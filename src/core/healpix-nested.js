import { mortonDecode, mortonEncode } from "./morton.js";
import { cellCenterVector, vectorToLonLat } from "./projection.js";

export function nsideForOrder(order) {
  assertOrder(order);
  return 2 ** order;
}

export function pixelCount(order) {
  return 12 * 4 ** order;
}

export function cellToNestedId({ order, face, ix, iy }) {
  assertOrder(order);
  assertFace(face);
  const nside = nsideForOrder(order);
  assertCellCoord(ix, nside, "ix");
  assertCellCoord(iy, nside, "iy");
  return face * 4 ** order + mortonEncode(ix, iy, order);
}

export function nestedIdToCell(order, id) {
  assertOrder(order);
  const maxId = pixelCount(order) - 1;
  if (!Number.isInteger(id) || id < 0 || id > maxId) {
    throw new RangeError(`id must be an integer in [0, ${maxId}], got ${id}`);
  }
  const faceSize = 4 ** order;
  const face = Math.floor(id / faceSize);
  const local = id - face * faceSize;
  const { ix, iy } = mortonDecode(local, order);
  return { order, face, ix, iy };
}

export function cellToLonLat(cell) {
  return vectorToLonLat(cellCenterVector(cell.order, cell.face, cell.ix, cell.iy));
}

export function assertOrder(order) {
  if (!Number.isInteger(order) || order < 0 || order > 26) {
    throw new RangeError(`order must be an integer in [0, 26], got ${order}`);
  }
}

export function assertFace(face) {
  if (!Number.isInteger(face) || face < 0 || face >= 12) {
    throw new RangeError(`face must be an integer in [0, 11], got ${face}`);
  }
}

export function assertCellCoord(value, nside, label) {
  if (!Number.isInteger(value) || value < 0 || value >= nside) {
    throw new RangeError(`${label} must be an integer in [0, ${nside - 1}], got ${value}`);
  }
}
