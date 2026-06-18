import { parentTile, tileKey } from "../core/tile-address.js";

export class TileScheduler {
  constructor({ cache, manifest }) {
    this.cache = cache;
    this.manifest = manifest;
    this.minOrder = manifest.minOrder ?? manifest.tileShift;
  }

  requestVisible(layerId, targetTiles) {
    this.requestVisibleMany([{ layerId, targetTiles }]);
  }

  requestVisibleMany(requests) {
    const wanted = new Set();
    for (const request of requests) {
      const layerId = request.layerId;
      request.targetTiles.forEach((tile, index) => {
        let current = tile;
        let distance = 0;
        while (current) {
          wanted.add(this.cache.cacheKey(layerId, current));
          if (!this.cache.has(layerId, current)) {
            this.cache.request(layerId, current, 1000 - index - distance * 100).catch(() => {});
          }
          current = parentTile(current, this.minOrder);
          distance += 1;
        }
      });
    }
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
}
