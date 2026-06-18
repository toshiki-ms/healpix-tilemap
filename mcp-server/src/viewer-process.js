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
  viewerProcess = spawn(
    "npx",
    ["vite", "preview", "--host", host, "--port", String(port), "--strictPort"],
    { cwd: VIEWER_ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  viewerUrl = baseUrl;
  viewerProcess.stdout.on("data", (chunk) => process.stderr.write(String(chunk)));
  viewerProcess.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
  viewerProcess.on("exit", () => {
    viewerProcess = null;
    viewerUrl = null;
  });
  await waitForServing(baseUrl, timeoutMs);
  return { url: baseUrl, alreadyRunning: false };
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
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

async function waitForServing(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isServing(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for viewer server: ${url}`);
}

async function isServing(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}
