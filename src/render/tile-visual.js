import { decodeSample } from "../data/tile-codec.js";
import { decodeQuantizedTileWasm } from "../data/wasm-decoder.js";
import { colorForValue } from "./colormap.js";

const RELIEF_LAYER_PATTERN = /(elevation|height|terrain|topo|dem)/i;
const RELIEF_Z_SCALE = 0.006;
const RELIEF_LIGHT = normalize3(-0.45, -0.55, 0.72);

export function visualKey(state) {
  return [
    state.colormap,
    state.scale,
    Number(state.min).toPrecision(8),
    Number(state.max).toPrecision(8),
    reliefEnabled(state) ? "relief" : "flat",
    state.grid ? "grid" : "nogrid"
  ].join(":");
}

export function tileCanvas(tileData, manifest, state) {
  const key = visualKey(state);
  const cached = tileData.imageCache.get(key);
  if (cached) {
    return cached;
  }

  const size = manifest.tileSize;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: false });
  const image = context.createImageData(size, size);
  const pixels = image.data;
  const values = decodedValues(tileData);
  const relief = reliefEnabled(state);

  for (let i = 0; i < values.length; i += 1) {
    let [r, g, b, a] = colorForValue(values[i], state);
    if (relief && a > 0) {
      const shade = reliefShade(values, size, i);
      r = clampByte(r * shade);
      g = clampByte(g * shade);
      b = clampByte(b * shade);
    }
    const p = i * 4;
    pixels[p] = r;
    pixels[p + 1] = g;
    pixels[p + 2] = b;
    pixels[p + 3] = a;
  }

  context.putImageData(image, 0, 0);

  if (state.grid) {
    context.strokeStyle = "rgba(255, 255, 255, 0.18)";
    context.lineWidth = 1;
    context.strokeRect(0.5, 0.5, size - 1, size - 1);
  }

  tileData.imageCache.set(key, canvas);
  if (tileData.imageCache.size > 6) {
    tileData.imageCache.delete(tileData.imageCache.keys().next().value);
  }
  return canvas;
}

export function sampleTileValue(tileData, manifest, cell) {
  const tileSize = manifest.tileSize;
  const shift = manifest.tileShift;
  const localMask = tileSize - 1;
  const localX = cell.ix & localMask;
  const localY = cell.iy & localMask;
  return decodeSample(tileData, localY * tileSize + localX);
}

function reliefEnabled(state) {
  return Boolean(state.relief) && RELIEF_LAYER_PATTERN.test(state.layerId ?? "");
}

function reliefShade(values, size, index) {
  const center = values[index];
  if (!Number.isFinite(center)) {
    return 1;
  }
  const x = index % size;
  const y = Math.floor(index / size);
  const left = finiteOr(values[y * size + Math.max(0, x - 1)], center);
  const right = finiteOr(values[y * size + Math.min(size - 1, x + 1)], center);
  const up = finiteOr(values[Math.max(0, y - 1) * size + x], center);
  const down = finiteOr(values[Math.min(size - 1, y + 1) * size + x], center);
  const dzdx = (right - left) * 0.5 * RELIEF_Z_SCALE;
  const dzdy = (down - up) * 0.5 * RELIEF_Z_SCALE;
  const normal = normalize3(-dzdx, -dzdy, 1);
  const light = normal.x * RELIEF_LIGHT.x + normal.y * RELIEF_LIGHT.y + normal.z * RELIEF_LIGHT.z;
  return Math.min(1.18, Math.max(0.58, 0.78 + light * 0.34));
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clampByte(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function normalize3(x, y, z) {
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

function decodedValues(tileData) {
  if (tileData.encoding.dtype === "float32") {
    return tileData.values;
  }
  if (tileData.decodedValues) {
    return tileData.decodedValues;
  }
  const decoded = decodeQuantizedTileWasm(tileData) ?? decodeQuantizedTileJs(tileData);
  tileData.decodedValues = decoded;
  return decoded;
}

function decodeQuantizedTileJs(tileData) {
  const decoded = new Float32Array(tileData.values.length);
  for (let i = 0; i < decoded.length; i += 1) {
    decoded[i] = decodeSample(tileData, i);
  }
  return decoded;
}
