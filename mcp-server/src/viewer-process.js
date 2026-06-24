import { spawn } from "node:child_process";
import { VIEWER_ROOT } from "./paths.js";

let viewerProcess = null;
let viewerUrl = null;

export async function startViewerServer({ port = 4181, host = "127.0.0.1", timeoutMs = 20_000 } = {}) {
  const baseUrl = `http://${host}:${port}/`;
  if (await isServing(baseUrl)) {
    viewerUrl = baseUrl;
    return { url: baseUrl, alreadyRunning: true };
  }
  if (viewerProcess) {
    return { url: viewerUrl, alreadyRunning: false };
  }
  await runCommand("npm", ["run", "build"], { cwd: VIEWER_ROOT });
  const proc = spawn(
    "npx",
    ["vite", "preview", "--host", host, "--port", String(port), "--strictPort"],
    { cwd: VIEWER_ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  viewerProcess = proc;
  viewerUrl = baseUrl;
  proc.stdout.on("data", (chunk) => process.stderr.write(String(chunk)));
  proc.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (viewerProcess === proc) {
        viewerProcess = null;
        viewerUrl = null;
      }
      reject(error);
    };
    proc.on("error", (err) => {
      fail(new Error(`Failed to start viewer process: ${err.message}`));
    });
    proc.on("exit", (code, signal) => {
      if (viewerProcess === proc) {
        viewerProcess = null;
        viewerUrl = null;
      }
      if (!settled) {
        fail(new Error(`Viewer process exited before serving (${formatExit({ code, signal })}).`));
      }
    });
    waitForServing(baseUrl, timeoutMs, proc)
      .then(() => {
        if (!settled) {
          settled = true;
          resolve({ url: baseUrl, alreadyRunning: false });
        }
      })
      .catch((err) => {
        if (!proc.killed) {
          proc.kill("SIGTERM");
        }
        fail(err);
      });
  });
}

export function currentViewerServer() {
  return viewerUrl ? { url: viewerUrl, managed: Boolean(viewerProcess) } : null;
}

export function stopViewerServer() {
  if (viewerProcess) {
    viewerProcess.kill("SIGTERM");
    viewerProcess = null;
  }
  const stopped = viewerUrl;
  viewerUrl = null;
  return { stopped };
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => process.stderr.write(String(chunk)));
    child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
    child.on("error", (err) => {
      reject(new Error(`Failed to run ${command}: ${err.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

async function waitForServing(url, timeoutMs, process = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (process && (process.exitCode !== null || process.signalCode !== null)) {
      throw new Error(`Viewer process exited before serving (${formatExit(process)}).`);
    }
    if (await isServing(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for viewer server: ${url}`);
}

function formatExit(process) {
  const signal = process.signal ?? process.signalCode;
  return signal ? `signal ${signal}` : `code ${process.code ?? process.exitCode}`;
}

async function isServing(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}
