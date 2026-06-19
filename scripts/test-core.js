import assert from "node:assert/strict";
import { cellToNestedId, nestedIdToCell } from "../src/core/healpix-nested.js";
import { mortonDecode, mortonEncode } from "../src/core/morton.js";
import { faceUvToVector, healpixVectorToDisplayVector } from "../src/core/projection.js";
import { tileBounds, tileFromCell, tileGridSize } from "../src/core/tile-address.js";
import { validateManifest } from "../src/core/manifest.js";
import { bytesPerSample, decodeSample, valueEncoding } from "../src/data/tile-codec.js";
import { detailOrderForBasePixels, LOD_TARGET_TILE_PIXELS } from "../src/render/lod.js";

for (const order of [0, 1, 2, 8, 10, 13]) {
  const nside = 2 ** order;
  for (const ix of [0, Math.max(0, Math.floor(nside / 2) - 1), nside - 1]) {
    for (const iy of [0, Math.max(0, Math.floor(nside / 2) - 1), nside - 1]) {
      const code = mortonEncode(ix, iy, order);
      assert.deepEqual(mortonDecode(code, order), { ix, iy });
      const cell = { order, face: 7, ix, iy };
      assert.deepEqual(nestedIdToCell(order, cellToNestedId(cell)), cell);
    }
  }
}

assert.equal(tileGridSize(10, 8), 4);
assert.equal(tileGridSize(13, 8), 32);
assert.deepEqual(tileFromCell({ order: 10, face: 3, ix: 511, iy: 512 }, 8), {
  order: 10,
  face: 3,
  x: 1,
  y: 2
});
assert.deepEqual(tileBounds({ order: 10, face: 0, x: 2, y: 3 }, 8), {
  u0: 0.5,
  v0: 0.75,
  u1: 0.75,
  v1: 1
});

const lodManifest = { minOrder: 8, maxOrder: 11, tileShift: 8 };
assert.equal(detailOrderForBasePixels(LOD_TARGET_TILE_PIXELS - 1, lodManifest, 11), 8);
assert.equal(detailOrderForBasePixels(LOD_TARGET_TILE_PIXELS + 1, lodManifest, 11), 9);
assert.equal(detailOrderForBasePixels(LOD_TARGET_TILE_PIXELS * 4 + 1, lodManifest, 11), 11);
assert.equal(detailOrderForBasePixels(LOD_TARGET_TILE_PIXELS * 16, lodManifest, 10), 10);

assert.equal(bytesPerSample("float32"), 4);
assert.equal(bytesPerSample("uint16"), 2);
const quantizedLayer = {
  id: "elevation_m",
  dtype: "uint16",
  source: { template: "layers/elevation_m/o{order}/f{face}/x{x}/y{y}.bin" },
  quantization: { scale: 0.5, offset: -1000, nodata: 65535 }
};
const encoding = valueEncoding(quantizedLayer);
assert.equal(decodeSample({ values: new Uint16Array([0, 2000, 65535]), encoding }, 0), -1000);
assert.equal(decodeSample({ values: new Uint16Array([0, 2000, 65535]), encoding }, 1), 0);
assert.ok(Number.isNaN(decodeSample({ values: new Uint16Array([0, 2000, 65535]), encoding }, 2)));
validateManifest({
  schema: "hpxmap-v1",
  ordering: "nested",
  maxOrder: 8,
  nside: 256,
  tileShift: 8,
  tileSize: 256,
  body: { name: "Earth", radiusKm: 6371.0088 },
  layers: [quantizedLayer]
});
validateManifest({
  schema: "hpxmap-v1",
  ordering: "nested",
  maxOrder: 9,
  nside: 512,
  tileShift: 7,
  tileSize: 128,
  layers: [{
    id: "value",
    dtype: "float32",
    source: {
      type: "zarr-tile",
      endpoint: "/api/zarr-tiles",
      zarr: "data/zarr-tile-demo.zarr",
      array: "value",
      dims: ["time", "level", "face", "y", "x"],
      select: { time: 0, level: 0 }
    }
  }]
});
assert.throws(() => validateManifest({
  schema: "hpxmap-v1",
  ordering: "nested",
  maxOrder: 8,
  nside: 256,
  tileShift: 8,
  tileSize: 256,
  body: { radiusKm: 0 },
  layers: [quantizedLayer]
}), /body\.radiusKm/);

for (let face = 0; face < 12; face += 1) {
  const bounds = tileBounds({ order: 10, face, x: 0, y: 0 }, 8);
  const p00 = displayPoint(face, bounds.u0, bounds.v0);
  const p10 = displayPoint(face, bounds.u1, bounds.v0);
  const p01 = displayPoint(face, bounds.u0, bounds.v1);
  const outward = dot(cross(sub(p01, p00), sub(p10, p00)), midpoint([p00, p01, p10]));
  assert.ok(outward > 0, `face ${face} first triangle must face outward`);
}

console.log("core tests passed");

function displayPoint(face, u, v) {
  return healpixVectorToDisplayVector(faceUvToVector(face, u, v));
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function midpoint(points) {
  const total = points.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1], acc[2] + point[2]], [0, 0, 0]);
  return [total[0] / points.length, total[1] / points.length, total[2] / points.length];
}
