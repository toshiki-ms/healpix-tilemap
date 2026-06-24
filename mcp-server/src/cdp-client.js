import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "google-chrome",
  "chromium",
  "chromium-browser"
].filter(Boolean);

export class ChromeViewerSession {
  constructor() {
    this.chrome = null;
    this.userDataDir = null;
    this.cdp = null;
    this.sessionId = null;
    this.targetId = null;
  }

  async open(url, options = {}) {
    await this.ensureBrowser(options);
    if (!this.targetId) {
      const target = await this.cdp.send("Target.createTarget", { url: "about:blank" });
      this.targetId = target.targetId;
      const attached = await this.cdp.send("Target.attachToTarget", {
        targetId: this.targetId,
        flatten: true
      });
      this.sessionId = attached.sessionId;
      await this.cdp.send("Runtime.enable", {}, this.sessionId);
      await this.cdp.send("Page.enable", {}, this.sessionId);
    }
    await this.cdp.send("Page.navigate", { url }, this.sessionId);
    await this.waitForRemote(options.timeoutMs ?? 20_000);
    return this.callRemote("get_state");
  }

  async callRemote(method, args = null, timeoutMs = 20_000) {
    if (!this.cdp || !this.sessionId) {
      throw new Error("Viewer page is not open. Call open_view first.");
    }
    const expression = `(async () => {
      const remote = window.__hpxRemote;
      if (!remote) throw new Error("window.__hpxRemote is not available.");
      return await remote[${JSON.stringify(method)}](${JSON.stringify(args ?? {})});
    })()`;
    return await this.evaluate(expression, timeoutMs);
  }

  async evaluate(expression, timeoutMs = 20_000) {
    const result = await this.cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
      this.sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed.");
    }
    return result.result.value;
  }

  async captureScreenshot(outputPath, options = {}) {
    if (!this.cdp || !this.sessionId) {
      throw new Error("Viewer page is not open. Call open_view first.");
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const result = await this.cdp.send(
      "Page.captureScreenshot",
      {
        format: options.format ?? "png",
        fromSurface: true,
        captureBeyondViewport: false
      },
      this.sessionId
    );
    await fs.writeFile(outputPath, Buffer.from(result.data, "base64"));
    return { path: outputPath, bytes: (await fs.stat(outputPath)).size };
  }

  async close() {
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
    if (this.chrome) {
      this.chrome.kill("SIGTERM");
      this.chrome = null;
    }
    if (this.userDataDir) {
      const dir = this.userDataDir;
      this.userDataDir = null;
      setTimeout(() => rm(dir, { recursive: true, force: true }).catch(() => {}), 500).unref();
    }
    this.sessionId = null;
    this.targetId = null;
  }

  async ensureBrowser(options) {
    if (this.cdp) {
      return;
    }
    const executable = await findChromeExecutable(options.executable);
    this.userDataDir = await mkdtemp(path.join(os.tmpdir(), "hpx-viewer-mcp-"));
    const size = `${options.width ?? 1280},${options.height ?? 900}`;
    const args = [
      options.headless === false ? null : "--headless=new",
      "--no-sandbox",
      "--use-gl=egl",
      `--window-size=${size}`,
      "--remote-debugging-port=0",
      `--user-data-dir=${this.userDataDir}`,
      "about:blank"
    ].filter(Boolean);
    this.chrome = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let wsUrl = "";
    let browserStartError = null;
    let browserExit = null;
    const collect = (chunk) => {
      const text = String(chunk);
      process.stderr.write(text);
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        wsUrl = match[1];
      }
    };
    this.chrome.stdout.on("data", collect);
    this.chrome.stderr.on("data", collect);
    this.chrome.on("error", (err) => {
      browserStartError = err;
    });
    this.chrome.on("exit", (code, signal) => {
      if (!wsUrl && !this.cdp) {
        browserExit = { code, signal };
      }
    });
    await waitFor(() => {
      if (browserStartError) {
        throw new Error(`Failed to start Chrome: ${browserStartError.message}`);
      }
      if (browserExit) {
        throw new Error(`Chrome exited before DevTools endpoint was available (${formatExit(browserExit)}).`);
      }
      return wsUrl;
    }, options.timeoutMs ?? 10_000, "Chrome DevTools endpoint");
    this.cdp = await connectCdp(wsUrl);
  }

  async waitForRemote(timeoutMs) {
    await waitForAsync(async () => {
      try {
        return await this.evaluate("window.__hpxRemote && window.__hpxRemote.version", 1000);
      } catch {
        return null;
      }
    }, timeoutMs, "viewer remote API");
  }
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    addSocketListener(ws, "message", (event) => {
      const message = JSON.parse(socketMessageData(event));
      const callbacks = this.pending.get(message.id);
      if (!callbacks) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        callbacks.reject(new Error(JSON.stringify(message.error)));
      } else {
        callbacks.resolve(message.result ?? {});
      }
    });
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    this.ws.close();
  }
}

async function connectCdp(endpoint) {
  const WebSocketClient = await webSocketConstructor();
  const ws = new WebSocketClient(endpoint);
  await new Promise((resolve, reject) => {
    addSocketListener(ws, "open", resolve, { once: true });
    addSocketListener(ws, "error", reject, { once: true });
  });
  return new CdpConnection(ws);
}

async function webSocketConstructor() {
  if (typeof globalThis.WebSocket !== "undefined") {
    return globalThis.WebSocket;
  }
  const wsModule = await import("ws");
  return wsModule.WebSocket ?? wsModule.default;
}

function addSocketListener(ws, event, listener, options = {}) {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(event, listener, options);
    return;
  }
  const wrapped = event === "message" ? (data) => listener({ data }) : listener;
  if (options.once && typeof ws.once === "function") {
    ws.once(event, wrapped);
    return;
  }
  if (typeof ws.on === "function") {
    ws.on(event, wrapped);
    return;
  }
  throw new Error("WebSocket implementation does not support event listeners.");
}

function socketMessageData(event) {
  const data = event?.data ?? event;
  return Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
}

function formatExit(exit) {
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
}

async function findChromeExecutable(requested) {
  const candidates = requested ? [requested] : DEFAULT_CHROME_CANDIDATES;
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    const found = await commandExists(candidate);
    if (found) {
      return candidate;
    }
  }
  throw new Error("Could not find Chrome. Set CHROME_BIN to a Chrome/Chromium executable.");
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${JSON.stringify(command)}`], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) {
      return value;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForAsync(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) {
      return value;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
