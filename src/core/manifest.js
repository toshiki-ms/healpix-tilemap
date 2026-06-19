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
  if (manifest.body !== undefined) {
    if (!manifest.body || typeof manifest.body !== "object") {
      throw new Error("Manifest field body must be an object when present.");
    }
    if (manifest.body.radiusKm !== undefined) {
      const radiusKm = Number(manifest.body.radiusKm);
      if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
        throw new Error("Manifest field body.radiusKm must be a positive number.");
      }
    }
  }
  for (const layer of manifest.layers) {
    if (!layer.id || !layer.source || typeof layer.source !== "object") {
      throw new Error("Each layer must define id and source.");
    }
    validateLayerSource(layer);
    if (!supportedDtype(layer.dtype)) {
      throw new Error(`Unsupported layer dtype: ${layer.dtype}`);
    }
    if ((layer.dtype === "uint16" || layer.dtype === "int16") && !layer.quantization) {
      throw new Error(`Layer ${layer.id} must define quantization for dtype ${layer.dtype}.`);
    }
  }
}

function validateLayerSource(layer) {
  if (layer.source.type === "zarr-tile") {
    if (!layer.source.zarr || typeof layer.source.zarr !== "string") {
      throw new Error(`Layer ${layer.id} zarr-tile source must define zarr.`);
    }
    if (layer.source.array !== undefined && typeof layer.source.array !== "string") {
      throw new Error(`Layer ${layer.id} zarr-tile source array must be a string.`);
    }
    if (layer.source.dims !== undefined) {
      if (!Array.isArray(layer.source.dims) || layer.source.dims.some((name) => typeof name !== "string")) {
        throw new Error(`Layer ${layer.id} zarr-tile source dims must be an array of strings.`);
      }
    }
    if (
      layer.source.select !== undefined &&
      (!layer.source.select || typeof layer.source.select !== "object" || Array.isArray(layer.source.select))
    ) {
      throw new Error(`Layer ${layer.id} zarr-tile source select must be an object.`);
    }
    if (layer.source.selectors !== undefined) {
      validateSourceSelectors(layer);
    }
    return;
  }
  if (!layer.source.template || typeof layer.source.template !== "string") {
    throw new Error("Each directory layer source must define source.template.");
  }
}

function validateSourceSelectors(layer) {
  const selectors = layer.source.selectors;
  if (!selectors || typeof selectors !== "object" || Array.isArray(selectors)) {
    throw new Error(`Layer ${layer.id} zarr-tile source selectors must be an object.`);
  }
  for (const [id, spec] of Object.entries(selectors)) {
    if (!id) {
      throw new Error(`Layer ${layer.id} zarr-tile selector id cannot be empty.`);
    }
    const values = Array.isArray(spec) ? spec : spec?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`Layer ${layer.id} zarr-tile selector ${id} must define values.`);
    }
    for (const value of values) {
      if (value && typeof value === "object") {
        if (value.value === undefined && value.id === undefined) {
          throw new Error(`Layer ${layer.id} zarr-tile selector ${id} value object must define value or id.`);
        }
      }
    }
  }
}
