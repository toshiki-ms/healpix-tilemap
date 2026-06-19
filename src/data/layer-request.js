export function baseLayerId(layerId) {
  return String(layerId ?? "").split("?", 1)[0];
}

export function parseLayerRequestId(layerId) {
  const text = String(layerId ?? "");
  const queryStart = text.indexOf("?");
  if (queryStart < 0) {
    return { layerId: text, selectors: {} };
  }
  const selectors = {};
  const params = new URLSearchParams(text.slice(queryStart + 1));
  for (const [key, value] of params.entries()) {
    selectors[key] = value;
  }
  return { layerId: text.slice(0, queryStart), selectors };
}

export function tileLayerId(state, manifest) {
  const layerId = baseLayerId(state?.layerId);
  const selectors = normalizeSelectorsForLayer(state?.selectors, manifest, layerId);
  const specs = selectorSpecsForLayer(manifest, layerId);
  if (!specs.length) {
    return layerId;
  }
  const params = new URLSearchParams();
  for (const spec of specs) {
    if (selectors[spec.id] !== undefined) {
      params.set(spec.id, String(selectors[spec.id]));
    }
  }
  const query = params.toString();
  return query ? `${layerId}?${query}` : layerId;
}

export function selectorSpecsForLayer(manifest, layerId) {
  const layer = layerForId(manifest, layerId);
  const source = layer?.source ?? {};
  if (source.type !== "zarr-tile") {
    return [];
  }
  const rawSelectors = source.selectors ?? {};
  const defaultSelect = source.select ?? {};
  return Object.entries(rawSelectors)
    .map(([id, raw]) => normalizeSelectorSpec(id, raw, defaultSelect))
    .filter((spec) => spec.values.length > 0);
}

export function defaultSelectorsForLayer(manifest, layerId) {
  const defaults = {};
  for (const spec of selectorSpecsForLayer(manifest, layerId)) {
    defaults[spec.id] = spec.defaultValue;
  }
  return defaults;
}

export function normalizeSelectorsForLayer(selectors, manifest, layerId) {
  const normalized = {};
  const source = selectors && typeof selectors === "object" ? selectors : {};
  for (const spec of selectorSpecsForLayer(manifest, layerId)) {
    const requested = source[spec.id];
    const value = spec.values.find((item) => String(item.value) === String(requested));
    normalized[spec.id] = value ? value.value : spec.defaultValue;
  }
  return normalized;
}

export function selectorUrlParamsForState(state, manifest) {
  const selectors = normalizeSelectorsForLayer(state?.selectors, manifest, state?.layerId);
  const specs = selectorSpecsForLayer(manifest, state?.layerId);
  return specs.map((spec) => [spec.id, selectors[spec.id]]);
}

function layerForId(manifest, layerId) {
  const id = baseLayerId(layerId);
  return manifest?.layers?.find((layer) => layer.id === id) ?? null;
}

function normalizeSelectorSpec(id, raw, defaultSelect) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw
    : { values: Array.isArray(raw) ? raw : [] };
  const values = normalizeSelectorValues(source.values);
  const fallback = defaultSelect?.[id] ?? source.default ?? values[0]?.value;
  const defaultValue = values.some((item) => String(item.value) === String(fallback))
    ? values.find((item) => String(item.value) === String(fallback)).value
    : values[0]?.value;
  return {
    id,
    label: String(source.label ?? titleCase(id)),
    values,
    defaultValue
  };
}

function normalizeSelectorValues(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((item, index) => {
    if (item && typeof item === "object") {
      const value = item.value ?? item.id ?? index;
      return {
        value: String(value),
        label: String(item.label ?? item.title ?? value)
      };
    }
    return {
      value: String(item),
      label: String(item)
    };
  });
}

function titleCase(value) {
  const text = String(value ?? "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}
