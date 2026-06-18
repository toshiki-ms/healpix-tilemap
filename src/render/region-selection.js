import { tileKey } from "../core/tile-address.js";

const TILE_PAINT_STEP_PIXELS = 8;

export function isTileSelectionPointer(event) {
  return event.button === 2 || (event.buttons & 2) === 2;
}

export function addTileToSelection(tiles, tile) {
  if (!tile) {
    return false;
  }
  const key = tileKey(tile);
  if (tiles.has(key)) {
    return false;
  }
  tiles.set(key, { ...tile });
  return true;
}

export function addTilesAlongLine({ tiles, start, end, tileAt, stepPixels = TILE_PAINT_STEP_PIXELS }) {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const steps = Math.max(1, Math.ceil(distance / stepPixels));
  let added = 0;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const tile = tileAt(lerp(start.x, end.x, t), lerp(start.y, end.y, t));
    if (addTileToSelection(tiles, tile)) {
      added += 1;
    }
  }
  return added;
}

export function createTileSelection({ tiles, tileShift, interaction = "paint" }) {
  const coverage = coverageFromTiles(tiles, { tileShift });
  if (coverage.tileCount <= 0) {
    return null;
  }
  return {
    selectionType: "tiles",
    selectionKind: "healpix-tile-coverage",
    interaction,
    coverage
  };
}

export function coverageFromTiles(tiles, { tileShift }) {
  const sortedTiles = [...tiles].sort(
    (a, b) => a.order - b.order || a.face - b.face || a.y - b.y || a.x - b.x
  );
  const tileRanges = [];
  for (const tile of sortedTiles) {
    const current = tileRanges[tileRanges.length - 1];
    if (
      current &&
      current.order === tile.order &&
      current.face === tile.face &&
      current.y === tile.y &&
      current.x1 + 1 === tile.x
    ) {
      current.x1 = tile.x;
      current.tileCount += 1;
      continue;
    }
    tileRanges.push({
      order: tile.order,
      face: tile.face,
      y: tile.y,
      x0: tile.x,
      x1: tile.x,
      tileCount: 1
    });
  }
  const cellRanges = tileRanges.map((range) => {
    const tileSize = Math.min(2 ** tileShift, 2 ** range.order);
    return {
      order: range.order,
      face: range.face,
      ix0: range.x0 * tileSize,
      ix1: (range.x1 + 1) * tileSize - 1,
      iy0: range.y * tileSize,
      iy1: (range.y + 1) * tileSize - 1,
      tileCount: range.tileCount,
      cellCount: safeIntegerProduct(range.tileCount, tileSize, tileSize)
    };
  });
  const tileCount = sortedTiles.length;
  const orders = [...new Set(sortedTiles.map((tile) => tile.order))].sort((a, b) => a - b);
  const faces = [...new Set(sortedTiles.map((tile) => tile.face))].sort((a, b) => a - b);
  const cellCount = cellRanges.reduce((total, range) => safeIntegerSum(total, range.cellCount), 0);
  return {
    schema: "hpxviewer.tileSelection.v1",
    type: "healpix-tile-ranges",
    basis: "painted-rendered-lod-tiles",
    orders,
    order: orders.length === 1 ? orders[0] : null,
    tileShift,
    tileSize: orders.length === 1 ? Math.min(2 ** tileShift, 2 ** orders[0]) : null,
    faceCount: faces.length,
    faces,
    tileCount,
    rangeCount: tileRanges.length,
    cellCount,
    tileRanges,
    cellRanges
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function safeIntegerProduct(...values) {
  let result = 1n;
  for (const value of values) {
    result *= BigInt(value);
  }
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result.toString();
}

function safeIntegerSum(a, b) {
  if (typeof a === "string" || typeof b === "string") {
    return (BigInt(a) + BigInt(b)).toString();
  }
  const result = a + b;
  return Number.isSafeInteger(result) ? result : (BigInt(a) + BigInt(b)).toString();
}
