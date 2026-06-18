import { assertFace, assertOrder, nsideForOrder } from "./healpix-nested.js";

export function tileGridSize(order, tileShift) {
  assertOrder(order);
  if (!Number.isInteger(tileShift) || tileShift < 0 || tileShift > 16) {
    throw new RangeError(`tileShift must be an integer in [0, 16], got ${tileShift}`);
  }
  return Math.max(1, 2 ** Math.max(0, order - tileShift));
}

export function tileSizeForShift(tileShift) {
  return 2 ** tileShift;
}

export function makeTileAddress(order, face, x, y) {
  assertOrder(order);
  assertFace(face);
  return { order, face, x, y };
}

export function tileKey(tile) {
  return `o${tile.order}:f${tile.face}:x${tile.x}:y${tile.y}`;
}

export function tileBounds(tile, tileShift) {
  const grid = tileGridSize(tile.order, tileShift);
  return {
    u0: tile.x / grid,
    v0: tile.y / grid,
    u1: (tile.x + 1) / grid,
    v1: (tile.y + 1) / grid
  };
}

export function tileFromCell(cell, tileShift) {
  const nside = nsideForOrder(cell.order);
  const size = Math.min(tileSizeForShift(tileShift), nside);
  return makeTileAddress(
    cell.order,
    cell.face,
    Math.floor(cell.ix / size),
    Math.floor(cell.iy / size)
  );
}

export function cellFromFaceUv(order, face, u, v) {
  const nside = nsideForOrder(order);
  const ix = Math.min(nside - 1, Math.max(0, Math.floor(u * nside)));
  const iy = Math.min(nside - 1, Math.max(0, Math.floor(v * nside)));
  return { order, face, ix, iy };
}

export function tileFromFaceUv(order, face, u, v, tileShift) {
  return tileFromCell(cellFromFaceUv(order, face, u, v), tileShift);
}

export function parentTile(tile, minOrder) {
  if (tile.order <= minOrder) {
    return null;
  }
  return {
    order: tile.order - 1,
    face: tile.face,
    x: Math.floor(tile.x / 2),
    y: Math.floor(tile.y / 2)
  };
}

export function enumerateTiles(order, tileShift) {
  const grid = tileGridSize(order, tileShift);
  const tiles = [];
  for (let face = 0; face < 12; face += 1) {
    for (let y = 0; y < grid; y += 1) {
      for (let x = 0; x < grid; x += 1) {
        tiles.push({ order, face, x, y });
      }
    }
  }
  return tiles;
}

export function sourceCropForTarget(sourceTile, targetTile, tileShift) {
  const source = tileBounds(sourceTile, tileShift);
  const target = tileBounds(targetTile, tileShift);
  const du = source.u1 - source.u0;
  const dv = source.v1 - source.v0;
  return {
    sx: (target.u0 - source.u0) / du,
    sy: (target.v0 - source.v0) / dv,
    sw: (target.u1 - target.u0) / du,
    sh: (target.v1 - target.v0) / dv
  };
}
