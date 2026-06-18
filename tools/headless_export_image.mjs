#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.output) {
    throw new Error("Usage: headless_export_image.mjs --url URL --output FILE [--mode figure] [--format png]");
  }
  const output = path.resolve(String(args.output));
  const format = normalizeFormat(args.format ?? path.extname(output).slice(1) ?? "png");
  const viewportWidth = positiveInteger(args.viewportWidth ?? args["viewport-width"] ?? 1280);
  const viewportHeight = positiveInteger(args.viewportHeight ?? args["viewport-height"] ?? 900);
  const timeoutMs = Math.max(1000, Number(args.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000);
  const chromePath = String(args.chrome ?? process.env.CHROME_BIN ?? findChrome());
  const remotePort = await pickDebugPort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpx-export-chrome-"));
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--use-gl=egl",
    `--window-size=${viewportWidth},${viewportHeight}`,
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], { stdio: "ignore" });

  let browser;
  let page;
  try {
    const version = await fetchJson(`http://127.0.0.1:${remotePort}/json/version`, timeoutMs);
    browser = await connectCdp(version.webSocketDebuggerUrl);
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const targets = await fetchJson(`http://127.0.0.1:${remotePort}/json/list`, timeoutMs);
    const target = targets.find((item) => item.id === targetId);
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("Could not create a Chrome page target.");
    }
    page = await connectCdp(target.webSocketDebuggerUrl);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Page.navigate", { url: withDebugParam(String(args.url)) });
    await waitForViewer(page, timeoutMs);
    const exportResult = await evaluate(page, exportExpression({
      mode: args.mode ?? "figure",
      format,
      scale: Number(args.scale ?? 1),
      width: optionalPositiveInteger(args.width),
      height: optionalPositiveInteger(args.height),
      transparent: Boolean(args.transparent),
      embedMetadata: args.metadata !== false && args["no-metadata"] !== true
    }), timeoutMs);
    const dataUrl = exportResult.dataUrl;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      throw new Error("Viewer did not return an image data URL.");
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
    console.log(JSON.stringify({
      output,
      bytes: fs.statSync(output).size,
      width: exportResult.width,
      height: exportResult.height,
      format: exportResult.extension,
      type: exportResult.type
    }));
  } finally {
    page?.close?.();
    browser?.close?.();
    chrome.kill("SIGTERM");
    await delay(200);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    if (key === "transparent" || key === "no-metadata") {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function normalizeFormat(value) {
  const format = String(value || "png").toLowerCase();
  if (format === "jpg" || format === "jpeg") {
    return "jpg";
  }
  return "png";
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Expected a positive integer, got ${value}.`);
  }
  return Math.round(number);
}

function optionalPositiveInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return positiveInteger(value);
}

function withDebugParam(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set("debug", "1");
  return url.href;
}

function findChrome() {
  for (const candidate of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    if (commandExists(candidate)) {
      return candidate;
    }
  }
  throw new Error("Could not find Chrome. Set CHROME_BIN or pass --chrome.");
}

function commandExists(command) {
  const paths = String(process.env.PATH || "").split(path.delimiter);
  return paths.some((dir) => {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

async function pickDebugPort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => port ? resolve(port) : reject(new Error("Could not allocate a debug port.")));
    });
    server.on("error", reject);
  });
}

async function fetchJson(url, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error(`Timed out fetching ${url}.`);
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const messageId = ++id;
          ws.send(JSON.stringify({ id: messageId, method, params }));
          return new Promise((resolveMessage, rejectMessage) => {
            pending.set(messageId, { resolve: resolveMessage, reject: rejectMessage });
          });
        },
        close() {
          ws.close();
        }
      });
    });
    ws.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (!payload.id || !pending.has(payload.id)) {
        return;
      }
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      payload.error ? reject(new Error(payload.error.message)) : resolve(payload.result);
    });
    ws.addEventListener("error", reject);
  });
}

async function waitForViewer(page, timeoutMs) {
  await evaluate(page, `
    new Promise((resolve, reject) => {
      const started = performance.now();
      let settledFrames = 0;
      function tick() {
        const app = window.__hpxApp;
        const status = document.querySelector("#datasetStatus")?.textContent || "";
        const pending = app?.cache?.stats?.().pending ?? 0;
        const visible = app?.renderStats?.visible ?? 0;
        if (app?.exportImageDataUrl && status && !status.includes("Loading") && visible > 0 && pending === 0) {
          settledFrames += 1;
          if (settledFrames >= 3) {
            resolve(true);
            return;
          }
        } else {
          settledFrames = 0;
        }
        if (performance.now() - started > ${JSON.stringify(timeoutMs)}) {
          reject(new Error("Timed out waiting for the viewer to finish loading tiles."));
          return;
        }
        requestAnimationFrame(tick);
      }
      tick();
    })
  `, timeoutMs);
}

async function evaluate(page, expression, timeoutMs) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Chrome evaluation failed.");
  }
  return result.result?.value;
}

function exportExpression(options) {
  return `window.__hpxApp.exportImageDataUrl(${JSON.stringify(options)})`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
