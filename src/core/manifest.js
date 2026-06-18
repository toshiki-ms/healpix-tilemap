import { supportedDtype } from "../data/tile-codec.js";

export async function loadManifest(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Manifest request failed with ${response.status}`);
  }
  const manifest = await response.json();
  validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Manifest must be an object.");
  }
  if (manifest.schema !== "hpxmap-v1") {
    throw new Error(`Unsupported schema: ${manifest.schema}`);
  }
  if (manifest.ordering !== "nested") {
    throw new Error("Only nested ordering is supported by this viewer.");
  }
  for (const key of ["maxOrder", "nside", "tileShift", "tileSize"]) {
    if (!Number.isInteger(manifest[key]) || manifest[key] <= 0) {
      throw new Error(`Manifest field ${key} must be a positive integer.`);
    }
  }
  if (manifest.nside !== 2 ** manifest.maxOrder) {
    throw new Error("Manifest nside must equal 2^maxOrder.");
  }
  if (manifest.tileSize !== 2 ** manifest.tileShift) {
    throw new Error("Manifest tileSize must equal 2^tileShift.");
  }
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    throw new Error("Manifest must define at least one layer.");
  }
  for (const layer of manifest.layers) {
    if (!layer.id || !layer.source?.template) {
      throw new Error("Each layer must define id and source.template.");
    }
    if (!supportedDtype(layer.dtype)) {
      throw new Error(`Unsupported layer dtype: ${layer.dtype}`);
    }
    if ((layer.dtype === "uint16" || layer.dtype === "int16") && !layer.quantization) {
      throw new Error(`Layer ${layer.id} must define quantization for dtype ${layer.dtype}.`);
    }
  }
}
