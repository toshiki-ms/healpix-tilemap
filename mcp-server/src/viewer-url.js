import { DEFAULT_VIEWER_BASE_URL } from "./paths.js";

export function buildViewerUrl(options = {}) {
  const url = new URL(options.baseUrl ?? DEFAULT_VIEWER_BASE_URL);
  const params = url.searchParams;
  setParam(params, "dataset", options.dataset);
  setParam(params, "layer", options.layer ?? options.layerId);
  setParam(params, "view", options.view);
  setParam(params, "order", options.order ?? options.maxOrder);
  setParam(params, "cmap", options.cmap ?? options.colormap);
  setParam(params, "scale", options.scale);
  setParam(params, "min", options.min);
  setParam(params, "max", options.max);
  if (options.relief !== undefined) {
    params.set("relief", truthy(options.relief) ? "1" : "0");
  }
  if (options.grid !== undefined) {
    params.set("grid", truthy(options.grid) ? "1" : "0");
  }
  params.set("remote", "1");
  return url.href;
}

function setParam(params, key, value) {
  if (value !== undefined && value !== null && value !== "") {
    params.set(key, String(value));
  }
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}
