import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [selectionApiPlugin(), zarrTileApiPlugin()],
  build: {
    target: "es2020"
  },
  server: {
    watch: {
      ignored: ["**/public/datasets/**"]
    }
  }
});

function selectionApiPlugin() {
  let selection = null;
  const middleware = (request, response, next) => {
    if (!request.url?.startsWith("/api/selection")) {
      next();
      return;
    }
    setJsonHeaders(response);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "GET") {
      response.end(JSON.stringify({ selection }));
      return;
    }
    if (request.method === "DELETE") {
      selection = null;
      response.end(JSON.stringify({ selection }));
      return;
    }
    if (request.method === "POST") {
      readJsonBody(request)
        .then((body) => {
          selection = {
            ...body,
            receivedAt: new Date().toISOString()
          };
          response.end(JSON.stringify({ selection }));
        })
        .catch((error) => {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: error.message }));
        });
      return;
    }
    response.statusCode = 405;
    response.end(JSON.stringify({ error: "Method not allowed" }));
  };
  return {
    name: "hpx-selection-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    }
  };
}

function zarrTileApiPlugin() {
  let service = null;
  const middleware = (request, response, next) => {
    if (!request.url?.startsWith("/api/zarr-tiles")) {
      next();
      return;
    }
    if (!service) {
      service = new ZarrTileService(__dirname);
    }
    service.handle(request, response).catch((error) => {
      sendJsonError(response, 500, error.message);
    });
  };
  return {
    name: "hpx-zarr-tile-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    }
  };
}

class ZarrTileService {
  constructor(root) {
    this.root = root;
    this.inflight = new Map();
    this.queue = [];
    this.active = 0;
    const defaultWorkers = Math.max(1, Math.min(4, cpus().length || 1));
    this.workers = positiveInt(process.env.HPX_ZARR_TILE_WORKERS, defaultWorkers);
  }

  async handle(request, response) {
    if (request.method !== "GET") {
      sendJsonError(response, 405, "Method not allowed");
      return;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    const requestTile = parseZarrTileRequest(url);
    const { manifestPath, manifest } = await this.loadDatasetManifest(requestTile.dataset);
    const layer = manifest.layers?.find((item) => item.id === requestTile.layer);
    if (!layer) {
      sendJsonError(response, 404, `Layer ${requestTile.layer} was not found.`);
      return;
    }
    if (layer.source?.type !== "zarr-tile") {
      sendJsonError(response, 400, `Layer ${requestTile.layer} is not a zarr-tile layer.`);
      return;
    }
    validateZarrTileAddress(manifest, requestTile);
    const cachePath = zarrTileCachePath(this.root, manifest, layer, requestTile);
    if (!(await fileExists(cachePath))) {
      await this.generateTile({ manifestPath, layerId: layer.id, cachePath, tile: requestTile });
    }
    const buffer = await fs.readFile(cachePath);
    response.statusCode = 200;
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Cache-Control", "public, max-age=3600");
    response.end(buffer);
  }

  async loadDatasetManifest(datasetId) {
    const indexPath = path.join(this.root, "public", "datasets", "index.json");
    let manifestRef = `${datasetId}/manifest.json`;
    try {
      const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
      const entry = index.datasets?.find((item) => item.id === datasetId);
      if (entry?.manifest) {
        manifestRef = entry.manifest;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const manifestPath = path.resolve(this.root, "public", "datasets", manifestRef);
    const datasetRoot = path.resolve(this.root, "public", "datasets");
    if (!manifestPath.startsWith(datasetRoot + path.sep)) {
      throw new Error("Dataset manifest path escapes public/datasets.");
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    return { manifestPath, manifest };
  }

  async generateTile({ manifestPath, layerId, cachePath, tile }) {
    const key = cachePath;
    const existing = this.inflight.get(key);
    if (existing) {
      await existing;
      return;
    }
    const task = this.enqueue(() => this.runPythonWorker({ manifestPath, layerId, cachePath, tile }));
    this.inflight.set(key, task);
    try {
      await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pumpQueue();
    });
  }

  pumpQueue() {
    while (this.active < this.workers && this.queue.length > 0) {
      const item = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.pumpQueue();
        });
    }
  }

  runPythonWorker({ manifestPath, layerId, cachePath, tile }) {
    return new Promise((resolve, reject) => {
      const python = process.env.PYTHON ?? "python3";
      const args = [
        "tools/zarr_tile.py",
        "--manifest",
        manifestPath,
        "--layer-id",
        layerId,
        "--order",
        String(tile.order),
        "--face",
        String(tile.face),
        "--x",
        String(tile.x),
        "--y",
        String(tile.y),
        "--output",
        cachePath
      ];
      const child = spawn(python, args, { cwd: this.root, env: process.env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout = cappedOutput(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = cappedOutput(stderr, chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Zarr tile worker failed with exit code ${code}: ${stderr || stdout}`));
      });
    });
  }
}

function parseZarrTileRequest(url) {
  return {
    dataset: requiredParam(url, "dataset"),
    layer: requiredParam(url, "layer"),
    order: intParam(url, "order"),
    face: intParam(url, "face"),
    x: intParam(url, "x"),
    y: intParam(url, "y")
  };
}

function requiredParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new Error(`Missing ${name} parameter.`);
  }
  return value;
}

function intParam(url, name) {
  const value = requiredParam(url, name);
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    throw new Error(`Parameter ${name} must be an integer.`);
  }
  return numeric;
}

function validateZarrTileAddress(manifest, tile) {
  const tileShift = Number(manifest.tileShift);
  const minOrder = Number(manifest.minOrder ?? tileShift);
  const maxOrder = Number(manifest.maxOrder);
  if (tile.order < minOrder || tile.order > maxOrder) {
    throw new Error(`Tile order must be in ${minOrder}..${maxOrder}.`);
  }
  if (tile.face < 0 || tile.face >= 12) {
    throw new Error("Tile face must be in 0..11.");
  }
  if (tile.order < tileShift) {
    throw new Error(`Tile order must be >= tileShift ${tileShift}.`);
  }
  const grid = 2 ** (tile.order - tileShift);
  if (tile.x < 0 || tile.x >= grid || tile.y < 0 || tile.y >= grid) {
    throw new Error(`Tile x/y must be in 0..${grid - 1}.`);
  }
}

function zarrTileCachePath(root, manifest, layer, tile) {
  const source = layer.source ?? {};
  const cacheRoot = source.cacheDir
    ? path.resolve(root, source.cacheDir)
    : path.join(root, "cache", "zarr-tiles");
  return path.join(
    cacheRoot,
    safePathSegment(String(manifest.name ?? "dataset")),
    safePathSegment(String(layer.id ?? "layer")),
    zarrTileCacheHash(manifest, layer),
    `o${tile.order}`,
    `f${tile.face}`,
    `x${tile.x}`,
    `y${tile.y}.bin`
  );
}

function zarrTileCacheHash(manifest, layer) {
  const descriptor = {
    schema: "hpxmap-zarr-tile-cache-v1",
    dataset: manifest.name ?? null,
    layer: layer.id ?? null,
    manifestMaxOrder: manifest.maxOrder ?? null,
    manifestNside: manifest.nside ?? null,
    manifestTileShift: manifest.tileShift ?? null,
    manifestTileSize: manifest.tileSize ?? null,
    dtype: layer.dtype ?? null,
    quantization: layer.quantization ?? null,
    source: layer.source ?? null
  };
  return createHash("sha256").update(stableJson(descriptor)).digest("hex").slice(0, 16);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function safePathSegment(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function positiveInt(value, fallback) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric;
  }
  return fallback;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function cappedOutput(current, chunk) {
  const next = current + chunk.toString();
  return next.length > 20000 ? next.slice(next.length - 20000) : next;
}

function sendJsonError(response, statusCode, message) {
  setJsonHeaders(response);
  response.statusCode = statusCode;
  response.end(JSON.stringify({ error: message }));
}

function setJsonHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Selection payload is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}
