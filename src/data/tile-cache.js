import { tileKey } from "../core/tile-address.js";

export class TileCache extends EventTarget {
  constructor({ source, byteBudget = 512 * 1024 * 1024, maxConcurrentRequests = 24 }) {
    super();
    this.source = source;
    this.byteBudget = byteBudget;
    this.maxConcurrentRequests = maxConcurrentRequests;
    this.tiles = new Map();
    this.pending = new Map();
    this.totalBytes = 0;
    this.requestCounter = 0;
    this.activeRequests = 0;
    this.diagnostics = {
      requests: 0,
      cacheHits: 0,
      pendingHits: 0,
      loaded: 0,
      errors: 0,
      canceled: 0,
      recent: []
    };
  }

  cacheKey(layerId, tile) {
    return `${layerId}:${tileKey(tile)}`;
  }

  get(layerId, tile) {
    const key = this.cacheKey(layerId, tile);
    const entry = this.tiles.get(key);
    if (!entry) {
      return null;
    }
    entry.lastUsed = performance.now();
    return entry.data;
  }

  has(layerId, tile) {
    return this.tiles.has(this.cacheKey(layerId, tile));
  }

  request(layerId, tile, priority = 0) {
    const key = this.cacheKey(layerId, tile);
    const existing = this.tiles.get(key);
    if (existing) {
      existing.lastUsed = performance.now();
      this.diagnostics.cacheHits += 1;
      this.recordDiagnostic({ event: "cache-hit", status: "loaded", layerId, tile, key, priority });
      return existing.promise ?? Promise.resolve(existing.data);
    }
    const pending = this.pending.get(key);
    if (pending) {
      pending.priority = Math.max(pending.priority, priority);
      this.diagnostics.pendingHits += 1;
      this.recordDiagnostic({ event: "pending-hit", status: pending.state, layerId, tile, key, priority });
      this.pumpQueue();
      return pending.promise;
    }

    const requestId = ++this.requestCounter;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    this.pending.set(key, {
      controller: null,
      promise,
      priority,
      requestId,
      tile,
      layerId,
      requestedAt: performance.now(),
      startedAt: null,
      state: "queued",
      resolve: resolvePromise,
      reject: rejectPromise
    });
    this.diagnostics.requests += 1;
    this.recordDiagnostic({ event: "request", status: "queued", layerId, tile, key, priority });
    this.pumpQueue();
    return promise;
  }

  pumpQueue() {
    while (this.activeRequests < this.maxConcurrentRequests) {
      const next = this.nextQueued();
      if (!next) {
        return;
      }
      const [key, entry] = next;
      this.startRequest(key, entry);
    }
  }

  nextQueued() {
    let best = null;
    for (const item of this.pending.entries()) {
      const entry = item[1];
      if (entry.state !== "queued") {
        continue;
      }
      if (
        !best ||
        entry.priority > best[1].priority ||
        (entry.priority === best[1].priority && entry.requestId < best[1].requestId)
      ) {
        best = item;
      }
    }
    return best;
  }

  startRequest(key, entry) {
    entry.state = "active";
    entry.startedAt = performance.now();
    entry.controller = new AbortController();
    this.activeRequests += 1;
    this.source
      .loadTile(entry.layerId, entry.tile, entry.controller.signal)
      .then((data) => {
        const endedAt = performance.now();
        this.insert(key, data);
        this.diagnostics.loaded += 1;
        this.recordDiagnostic({
          event: "load",
          status: "loaded",
          layerId: entry.layerId,
          tile: entry.tile,
          key,
          bytes: data.bytes,
          queuedMs: entry.startedAt - entry.requestedAt,
          loadTimeMs: endedAt - entry.startedAt,
          totalTimeMs: endedAt - entry.requestedAt
        });
        this.dispatchEvent(new CustomEvent("tileload", { detail: { layerId: entry.layerId, tile: entry.tile, data } }));
        entry.resolve(data);
      })
      .catch((error) => {
        if (error.name === "AbortError") {
          this.diagnostics.canceled += 1;
          this.recordDiagnostic({ event: "cancel", status: "canceled", layerId: entry.layerId, tile: entry.tile, key });
        } else {
          this.diagnostics.errors += 1;
          this.recordDiagnostic({
            event: "error",
            status: "error",
            layerId: entry.layerId,
            tile: entry.tile,
            key,
            error: error instanceof Error ? error.message : String(error)
          });
          console.warn(error);
          this.dispatchEvent(new CustomEvent("tileerror", { detail: { layerId: entry.layerId, tile: entry.tile, error } }));
        }
        entry.reject(error);
      })
      .finally(() => {
        this.pending.delete(key);
        this.activeRequests -= 1;
        this.pumpQueue();
      });
  }

  insert(key, data) {
    this.tiles.set(key, {
      data,
      bytes: data.bytes,
      lastUsed: performance.now()
    });
    this.totalBytes += data.bytes;
    this.evict();
  }

  evict() {
    if (this.totalBytes <= this.byteBudget) {
      return;
    }
    const entries = [...this.tiles.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of entries) {
      this.tiles.delete(key);
      this.totalBytes -= entry.bytes;
      if (this.totalBytes <= this.byteBudget) {
        break;
      }
    }
  }

  cancelUnwanted(wantedKeys) {
    for (const [key, pending] of this.pending) {
      if (!wantedKeys.has(key)) {
        if (pending.state === "queued") {
          this.pending.delete(key);
          this.diagnostics.canceled += 1;
          this.recordDiagnostic({ event: "cancel", status: "canceled", layerId: pending.layerId, tile: pending.tile, key });
          pending.reject(abortError());
        } else if (pending.state === "active") {
          pending.controller?.abort();
        }
      }
    }
  }

  tileStatus(layerId, tile) {
    const key = this.cacheKey(layerId, tile);
    if (this.tiles.has(key)) {
      return "loaded";
    }
    return this.pending.has(key) ? "pending" : "missing";
  }

  stats() {
    return {
      loaded: this.tiles.size,
      pending: this.pending.size,
      active: this.activeRequests,
      queued: Math.max(0, this.pending.size - this.activeRequests),
      bytes: this.totalBytes
    };
  }

  diagnosticsSnapshot() {
    return {
      ...this.stats(),
      requests: this.diagnostics.requests,
      cacheHits: this.diagnostics.cacheHits,
      pendingHits: this.diagnostics.pendingHits,
      loadedEvents: this.diagnostics.loaded,
      errors: this.diagnostics.errors,
      canceled: this.diagnostics.canceled,
      recent: this.diagnostics.recent.slice(-20)
    };
  }

  recordDiagnostic(detail) {
    const tile = detail.tile;
    this.diagnostics.recent.push({
      timeMs: Math.round(performance.now()),
      event: detail.event,
      status: detail.status,
      layerId: detail.layerId,
      key: detail.key,
      tile: tile ? tileKey(tile) : undefined,
      order: tile?.order,
      face: tile?.face,
      x: tile?.x,
      y: tile?.y,
      priority: Number.isFinite(detail.priority) ? Math.round(detail.priority) : undefined,
      bytes: detail.bytes,
      queuedMs: roundMs(detail.queuedMs),
      loadTimeMs: roundMs(detail.loadTimeMs),
      totalTimeMs: roundMs(detail.totalTimeMs),
      error: detail.error
    });
    if (this.diagnostics.recent.length > 200) {
      this.diagnostics.recent.splice(0, this.diagnostics.recent.length - 200);
    }
  }
}

function roundMs(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined;
}

function abortError() {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Tile request was cancelled.", "AbortError");
  }
  const error = new Error("Tile request was cancelled.");
  error.name = "AbortError";
  return error;
}
