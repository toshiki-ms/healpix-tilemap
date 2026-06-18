import { parentTile, tileKey } from "../core/tile-address.js";

export class TileScheduler {
  constructor({ cache, manifest }) {
    this.cache = cache;
    this.manifest = manifest;
    this.minOrder = manifest.minOrder ?? manifest.tileShift;
    this.lastDiagnostics = null;
  }

  requestVisible(layerId, targetTiles) {
    this.requestVisibleMany([{ layerId, targetTiles }]);
  }

  requestVisibleMany(requests) {
    const wanted = new Set();
    const diagnostics = {
      requestedAtMs: Math.round(performance.now()),
      wantedTiles: 0,
      wantedOrders: {},
      targetTiles: 0,
      targetOrders: {},
      cacheHits: 0,
      pending: 0,
      queued: 0,
      layers: []
    };
    for (const request of requests) {
      const layerId = request.layerId;
      const layerDiagnostics = {
        layerId,
        targetTiles: request.targetTiles.length,
        targetOrders: orderCounts(request.targetTiles),
        wantedTiles: 0,
        wantedOrders: {},
        cacheHits: 0,
        pending: 0,
        queued: 0
      };
      diagnostics.targetTiles += request.targetTiles.length;
      mergeOrderCounts(diagnostics.targetOrders, layerDiagnostics.targetOrders);
      request.targetTiles.forEach((tile, index) => {
        let current = tile;
        let distance = 0;
        while (current) {
          const key = this.cache.cacheKey(layerId, current);
          const firstWanted = !wanted.has(key);
          if (firstWanted) {
            wanted.add(key);
            incrementOrderCount(diagnostics.wantedOrders, current.order);
            incrementOrderCount(layerDiagnostics.wantedOrders, current.order);
            layerDiagnostics.wantedTiles += 1;
            const status = this.cache.tileStatus(layerId, current);
            if (status === "loaded") {
              diagnostics.cacheHits += 1;
              layerDiagnostics.cacheHits += 1;
            } else if (status === "pending") {
              diagnostics.pending += 1;
              layerDiagnostics.pending += 1;
            } else {
              diagnostics.queued += 1;
              layerDiagnostics.queued += 1;
            }
          }
          if (!this.cache.has(layerId, current)) {
            this.cache.request(layerId, current, 1000 - index - distance * 100).catch(() => {});
          }
          current = parentTile(current, this.minOrder);
          distance += 1;
        }
      });
      diagnostics.layers.push(layerDiagnostics);
    }
    diagnostics.wantedTiles = wanted.size;
    this.lastDiagnostics = diagnostics;
    this.cache.cancelUnwanted(wanted);
  }

  resolve(layerId, targetTile) {
    let current = targetTile;
    while (current) {
      const data = this.cache.get(layerId, current);
      if (data) {
        return { data, sourceTile: current, exact: current.order === targetTile.order };
      }
      current = parentTile(current, this.minOrder);
    }
    return null;
  }

  key(tile) {
    return tileKey(tile);
  }

  diagnosticsSnapshot() {
    return this.lastDiagnostics ? JSON.parse(JSON.stringify(this.lastDiagnostics)) : null;
  }
}

function orderCounts(tiles) {
  const counts = {};
  for (const tile of tiles) {
    incrementOrderCount(counts, tile.order);
  }
  return counts;
}

function incrementOrderCount(counts, order) {
  counts[order] = (counts[order] ?? 0) + 1;
}

function mergeOrderCounts(target, source) {
  for (const [order, count] of Object.entries(source)) {
    target[order] = (target[order] ?? 0) + count;
  }
}
