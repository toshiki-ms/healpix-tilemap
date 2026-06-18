import { loadManifest } from "../core/manifest.js";
import { DirectoryTileSource } from "../data/directory-source.js";
import { TileCache } from "../data/tile-cache.js";
import { TileScheduler } from "../data/tile-scheduler.js";
import { warmWasmDecoder } from "../data/wasm-decoder.js";
import { cellToLonLat } from "../core/healpix-nested.js";
import { colorbarCss } from "../render/colormap.js";
import { GlobeRenderer } from "../render/globe-renderer.js";
import { clampOrder } from "../render/lod.js";
import { NetRenderer } from "../render/net-renderer.js";
import { installRemoteControl } from "../remote/viewer-control.js";

const DATASET_INDEX_URL = "/datasets/index.json";

export class App {
  constructor(root = document.querySelector(".app-shell")) {
    this.root = root;
    this.controls = {
      datasetSelect: document.querySelector("#datasetSelect"),
      datasetStatus: document.querySelector("#datasetStatus"),
      loadStatus: document.querySelector("#loadStatus"),
      viewMode: document.querySelector("#viewMode"),
      layerSelect: document.querySelector("#layerSelect"),
      orderSelect: document.querySelector("#orderSelect"),
      colormapSelect: document.querySelector("#colormapSelect"),
      scaleSelect: document.querySelector("#scaleSelect"),
      minInput: document.querySelector("#minInput"),
      maxInput: document.querySelector("#maxInput"),
      autoStretchButton: document.querySelector("#autoStretchButton"),
      reliefToggle: document.querySelector("#reliefToggle"),
      gridToggle: document.querySelector("#gridToggle"),
      resetViewButton: document.querySelector("#resetViewButton"),
      colorbarRamp: document.querySelector("#colorbarRamp"),
      colorMin: document.querySelector("#colorMin"),
      colorMax: document.querySelector("#colorMax"),
      cellValue: document.querySelector("#cellValue"),
      faceValue: document.querySelector("#faceValue"),
      localValue: document.querySelector("#localValue"),
      lonLatValue: document.querySelector("#lonLatValue"),
      sampleValue: document.querySelector("#sampleValue"),
      tileValue: document.querySelector("#tileValue")
    };
    this.state = {
      view: "net",
      layerId: "",
      order: 8,
      maxOrder: 8,
      colormap: "viridis",
      scale: "linear",
      min: -1,
      max: 1,
      symlogConstant: 0.03,
      relief: true,
      grid: false
    };
    this.datasetCatalog = null;
    this.datasetId = "";
    this.lastUrlWrite = 0;
    this.renderStats = null;
    this.selectedSample = null;
  }

  async start() {
    try {
      this.datasetCatalog = await loadDatasetIndex();
    } catch (error) {
      this.showDatasetSetupMessage(error);
      return;
    }
    if (new URLSearchParams(window.location.search).has("debug")) {
      window.__hpxApp = this;
    }
    this.datasetId = selectedDatasetId(this.datasetCatalog);
    const dataset = this.datasetCatalog.datasets.find((item) => item.id === this.datasetId);
    this.manifestUrl = new URL(`/datasets/${dataset.manifest}`, window.location.href).href;
    this.manifest = await loadManifest(this.manifestUrl);
    this.source = new DirectoryTileSource(this.manifest, this.manifestUrl);
    warmWasmDecoder();
    this.cache = new TileCache({
      source: this.source,
      byteBudget: 384 * 1024 * 1024,
      maxConcurrentRequests: 24
    });
    this.scheduler = new TileScheduler({ cache: this.cache, manifest: this.manifest });
    this.state.view = this.manifest.defaultView?.mode ?? this.state.view;
    this.state.layerId = this.manifest.defaultView?.layer ?? this.manifest.layers[0].id;
    const defaultOrder = this.manifest.defaultView?.order ?? this.manifest.maxOrder;
    this.state.maxOrder = defaultOrder;
    this.state.order = defaultOrder;
    this.state.scale = this.manifest.defaultView?.scale ?? this.state.scale;
    this.state.colormap = this.manifest.defaultView?.colormap ?? this.state.colormap;
    this.applyUrlState();
    this.setupControls();
    this.setupRenderers();
    installRemoteControl(this);
    this.updateDisplayControls();
    this.cache.addEventListener("tileload", () => this.updateLoadStatus());
    this.cache.addEventListener("tileerror", () => this.updateLoadStatus());
    window.addEventListener("resize", () => {
      this.net.resize();
      this.globe.resize();
    });
    this.controls.datasetStatus.textContent = `${this.manifest.name} / nside ${this.manifest.nside}`;
    this.loop();
  }

  showDatasetSetupMessage(error) {
    this.root.dataset.view = "net";
    this.controls.datasetStatus.textContent = "No local datasets";
    this.controls.loadStatus.textContent = "dataset index missing";
    const message = document.createElement("section");
    message.className = "empty-state";
    message.innerHTML = `
      <h2>No datasets are bundled</h2>
      <p>Generate a local HEALPix tile pyramid, then reload the viewer.</p>
      <pre>npm install
pip install -e "python[generators,analysis]"
npm run generate:spectral:8192
npm run dev</pre>
      <small>${escapeHtml(error?.message ?? String(error))}</small>
    `;
    this.root.appendChild(message);
    for (const control of Object.values(this.controls)) {
      if ("disabled" in control) {
        control.disabled = true;
      }
    }
  }

  setupControls() {
    this.root.dataset.view = this.state.view;
    this.controls.datasetSelect.replaceChildren(
      ...this.datasetCatalog.datasets.map((dataset) => new Option(dataset.title ?? dataset.id, dataset.id))
    );
    this.controls.datasetSelect.value = this.datasetId;
    this.controls.viewMode.value = this.state.view;
    this.controls.layerSelect.replaceChildren(
      ...this.manifest.layers.map((layer) => new Option(layer.title ?? layer.id, layer.id))
    );
    this.controls.layerSelect.value = this.state.layerId;

    const minOrder = this.manifest.minOrder ?? this.manifest.tileShift;
    this.controls.orderSelect.replaceChildren();
    for (let order = minOrder; order <= this.manifest.maxOrder; order += 1) {
      this.controls.orderSelect.append(new Option(`order ${order} / nside ${2 ** order}`, String(order)));
    }
    this.controls.orderSelect.value = String(this.state.maxOrder);
    this.controls.colormapSelect.value = this.state.colormap;
    this.controls.scaleSelect.value = this.state.scale;

    this.controls.datasetSelect.addEventListener("change", () => {
      const params = new URLSearchParams();
      params.set("dataset", this.controls.datasetSelect.value);
      params.set("view", this.state.view);
      params.set("cmap", this.state.colormap);
      window.location.href = `${window.location.pathname}?${params.toString()}`;
    });
    this.controls.viewMode.addEventListener("change", () => {
      this.state.view = this.controls.viewMode.value;
      this.root.dataset.view = this.state.view;
      this.writeUrlState();
    });
    this.controls.layerSelect.addEventListener("change", () => {
      this.state.layerId = this.controls.layerSelect.value;
      this.autoStretch();
      this.writeUrlState();
    });
    this.controls.orderSelect.addEventListener("change", () => {
      this.state.maxOrder = Number(this.controls.orderSelect.value);
      const minOrder = this.manifest.minOrder ?? this.manifest.tileShift;
      this.state.order = clampOrder(this.state.order, minOrder, this.state.maxOrder);
      this.writeUrlState();
    });
    this.controls.colormapSelect.addEventListener("change", () => {
      this.state.colormap = this.controls.colormapSelect.value;
      this.updateColorbar();
      this.writeUrlState();
    });
    this.controls.scaleSelect.addEventListener("change", () => {
      this.state.scale = this.controls.scaleSelect.value;
      this.writeUrlState();
    });
    this.controls.minInput.addEventListener("change", () => {
      this.state.min = Number(this.controls.minInput.value);
      this.updateColorbar();
      this.writeUrlState();
    });
    this.controls.maxInput.addEventListener("change", () => {
      this.state.max = Number(this.controls.maxInput.value);
      this.updateColorbar();
      this.writeUrlState();
    });
    this.controls.autoStretchButton.addEventListener("click", () => {
      this.autoStretch();
      this.writeUrlState();
    });
    this.controls.reliefToggle.addEventListener("click", () => {
      this.state.relief = !this.state.relief;
      this.controls.reliefToggle.setAttribute("aria-pressed", String(this.state.relief));
      this.writeUrlState();
    });
    this.controls.gridToggle.addEventListener("click", () => {
      this.state.grid = !this.state.grid;
      this.controls.gridToggle.setAttribute("aria-pressed", String(this.state.grid));
      this.writeUrlState();
    });
    this.controls.resetViewButton.addEventListener("click", () => {
      this.net.resetView();
      this.globe.resetView();
    });
  }

  setupRenderers() {
    this.net = new NetRenderer({
      canvas: document.querySelector("#mapCanvas"),
      manifest: this.manifest,
      scheduler: this.scheduler,
      state: this.state,
      onHover: (sample) => this.updateInspector(sample),
      onSelect: (sample) => this.updateSelection(sample)
    });
    this.globe = new GlobeRenderer({
      canvas: document.querySelector("#globeCanvas"),
      manifest: this.manifest,
      scheduler: this.scheduler,
      state: this.state,
      onHover: (sample) => this.updateInspector(sample),
      onSelect: (sample) => this.updateSelection(sample)
    });
  }

  setViewState(patch = {}) {
    const nextLayerId = patch.layerId ?? patch.layer;
    const layerChanged = typeof nextLayerId === "string" && nextLayerId !== this.state.layerId;
    if (layerChanged && this.manifest.layers.some((item) => item.id === nextLayerId)) {
      this.state.layerId = nextLayerId;
    }
    if (patch.view === "globe" || patch.view === "net") {
      this.state.view = patch.view;
      this.root.dataset.view = this.state.view;
    }
    const requestedOrder = Number(patch.maxOrder ?? patch.order);
    if (Number.isInteger(requestedOrder)) {
      const minOrder = this.manifest.minOrder ?? this.manifest.tileShift;
      this.state.maxOrder = clampOrder(requestedOrder, minOrder, this.manifest.maxOrder);
      this.state.order = clampOrder(this.state.order, minOrder, this.state.maxOrder);
    }
    const nextColormap = patch.colormap ?? patch.cmap;
    if (typeof nextColormap === "string" && nextColormap.length > 0) {
      this.state.colormap = nextColormap;
    }
    if (patch.scale === "linear" || patch.scale === "log" || patch.scale === "symlog") {
      this.state.scale = patch.scale;
    }
    const min = Number(patch.min);
    const max = Number(patch.max);
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      this.state.min = min;
      this.state.max = max;
    } else if (layerChanged) {
      this.autoStretch(false);
    }
    if (patch.relief !== undefined) {
      this.state.relief = Boolean(patch.relief);
    }
    if (patch.grid !== undefined) {
      this.state.grid = Boolean(patch.grid);
    }
    const symlogConstant = Number(patch.symlogConstant);
    if (Number.isFinite(symlogConstant) && symlogConstant > 0) {
      this.state.symlogConstant = symlogConstant;
    }
    this.updateDisplayControls();
    this.writeUrlState();
    return this.stateSnapshot();
  }

  stateSnapshot() {
    return {
      datasetId: this.datasetId,
      manifestUrl: this.manifestUrl,
      state: { ...this.state },
      renderStats: this.renderStats ? { ...this.renderStats } : null,
      cacheStats: this.cache?.stats?.() ?? null,
      selection: this.selectionSnapshot(),
      url: window.location.href
    };
  }

  loop() {
    const renderer = this.state.view === "globe" ? this.globe : this.net;
    this.updateActiveOrder(renderer);
    const visible = renderer.desiredTiles();
    this.scheduler.requestVisible(this.state.layerId, visible);
    renderer.draw();
    this.renderStats = renderer.stats?.() ?? null;
    this.updateLoadStatus();
    this.writeUrlState(true);
    requestAnimationFrame(() => this.loop());
  }

  applyUrlState() {
    const params = new URLSearchParams(window.location.search);
    const layer = params.get("layer");
    if (layer && this.manifest.layers.some((item) => item.id === layer)) {
      this.state.layerId = layer;
    }
    const view = params.get("view");
    if (view === "globe" || view === "net") {
      this.state.view = view;
    }
    const order = Number(params.get("order"));
    if (Number.isInteger(order) && order >= (this.manifest.minOrder ?? this.manifest.tileShift) && order <= this.manifest.maxOrder) {
      this.state.maxOrder = order;
      this.state.order = order;
    }
    const colormap = params.get("cmap");
    if (colormap) {
      this.state.colormap = colormap;
    }
    const scale = params.get("scale");
    if (scale === "linear" || scale === "log" || scale === "symlog") {
      this.state.scale = scale;
    }
    const relief = params.get("relief");
    if (relief === "0" || relief === "false") {
      this.state.relief = false;
    } else if (relief === "1" || relief === "true") {
      this.state.relief = true;
    }
    const grid = params.get("grid");
    if (grid === "0" || grid === "false") {
      this.state.grid = false;
    } else if (grid === "1" || grid === "true") {
      this.state.grid = true;
    }
    const min = Number(params.get("min"));
    const max = Number(params.get("max"));
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      this.state.min = min;
      this.state.max = max;
    } else {
      this.autoStretch(false);
    }
  }

  writeUrlState(throttled = false) {
    const now = performance.now();
    if (throttled && now - this.lastUrlWrite < 800) {
      return;
    }
    this.lastUrlWrite = now;
    const params = new URLSearchParams();
    params.set("dataset", this.datasetId);
    params.set("layer", this.state.layerId);
    params.set("view", this.state.view);
    params.set("order", String(this.state.maxOrder));
    params.set("cmap", this.state.colormap);
    params.set("scale", this.state.scale);
    params.set("relief", this.state.relief ? "1" : "0");
    params.set("grid", this.state.grid ? "1" : "0");
    params.set("min", formatNumber(this.state.min));
    params.set("max", formatNumber(this.state.max));
    const current = new URLSearchParams(window.location.search);
    if (current.has("remote")) {
      params.set("remote", current.get("remote") || "1");
    }
    if (current.has("debug")) {
      params.set("debug", current.get("debug") || "1");
    }
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", next);
  }

  updateDisplayControls() {
    this.controls.orderSelect.value = String(this.state.maxOrder);
    this.controls.minInput.value = String(this.state.min);
    this.controls.maxInput.value = String(this.state.max);
    this.controls.reliefToggle.setAttribute("aria-pressed", String(this.state.relief));
    this.controls.gridToggle.setAttribute("aria-pressed", String(this.state.grid));
    this.updateColorbar();
  }

  autoStretch(updateInputs = true) {
    const layer = this.manifest.layers.find((item) => item.id === this.state.layerId);
    const p = layer?.stats?.percentiles;
    this.state.min = Number(p?.["1"] ?? layer?.stats?.min ?? -1);
    this.state.max = Number(p?.["99"] ?? layer?.stats?.max ?? 1);
    if (updateInputs) {
      this.updateDisplayControls();
    }
  }

  updateColorbar() {
    this.controls.colorbarRamp.style.background = colorbarCss(this.state.colormap);
    this.controls.colorMin.textContent = formatNumber(this.state.min);
    this.controls.colorMax.textContent = formatNumber(this.state.max);
  }

  updateLoadStatus() {
    if (!this.cache) {
      return;
    }
    const stats = this.cache.stats();
    const renderStats = this.renderStats;
    const visible = renderStats ? ` · ${renderStats.visible} visible` : "";
    const orders = renderStats?.orderCounts ? ` · ${formatOrderCounts(renderStats.orderCounts)}` : "";
    const loading = stats.pending > 0 ? ` · ${stats.pending} loading` : "";
    this.controls.loadStatus.textContent = `LOD ${this.state.order}/${this.state.maxOrder}${visible}${orders}${loading}`;
  }

  updateActiveOrder(renderer) {
    const minOrder = this.manifest.minOrder ?? this.manifest.tileShift;
    const nextOrder = renderer.detailOrder
      ? renderer.detailOrder(this.state.maxOrder)
      : this.state.maxOrder;
    this.state.order = clampOrder(nextOrder, minOrder, this.state.maxOrder);
  }

  updateInspector(sample) {
    if (sample?.selectionType === "tiles") {
      const coverage = sample.coverage;
      this.controls.cellValue.textContent = "tiles";
      this.controls.faceValue.textContent = coverage?.faces?.join(", ") ?? "-";
      this.controls.localValue.textContent = coverage?.order === null ? "multi-order" : `order ${coverage?.order}`;
      this.controls.lonLatValue.textContent = "-";
      this.controls.sampleValue.textContent = `${coverage?.tileCount ?? 0} tiles`;
      this.controls.tileValue.textContent = `${coverage?.rangeCount ?? 0} ranges`;
      return;
    }
    if (!sample) {
      this.controls.cellValue.textContent = "-";
      this.controls.faceValue.textContent = "-";
      this.controls.localValue.textContent = "-";
      this.controls.lonLatValue.textContent = "-";
      this.controls.sampleValue.textContent = "-";
      this.controls.tileValue.textContent = "-";
      return;
    }
    const lonLat = sample.lonLat ?? cellToLonLat(sample.cell);
    this.controls.cellValue.textContent = String(sample.nestedId);
    this.controls.faceValue.textContent = String(sample.cell.face);
    this.controls.localValue.textContent = `${sample.cell.ix}, ${sample.cell.iy}`;
    this.controls.lonLatValue.textContent = `${lonLat.lon.toFixed(3)}, ${lonLat.lat.toFixed(3)}`;
    this.controls.sampleValue.textContent = Number.isFinite(sample.value) ? sample.value.toFixed(6) : "loading";
    this.controls.tileValue.textContent = sample.tileKey;
  }

  updateSelection(sample) {
    if (!sample) {
      return;
    }
    this.updateInspector(sample);
    this.selectedSample = serializeSelection(sample, this);
    broadcastSelection(this.selectedSample);
    persistSelection(this.selectedSample);
  }

  selectionSnapshot() {
    return this.selectedSample ? { ...this.selectedSample } : null;
  }
}

function serializeSelection(sample, app) {
  const base = {
    type: "hpxviewer:selected",
    selectedAt: new Date().toISOString(),
    datasetId: app.datasetId,
    layerId: app.state.layerId,
    view: app.state.view,
    order: app.state.order,
    maxOrder: app.state.maxOrder,
    url: window.location.href
  };
  if (sample.selectionType === "tiles") {
    return {
      ...base,
      selectionType: "tiles",
      selectionKind: sample.selectionKind,
      interaction: sample.interaction,
      tiles: {
        coverage: sample.coverage
      }
    };
  }
  return {
    ...base,
    selectionType: "point",
    cell: sample.cell,
    nestedId: sample.nestedId,
    lonLat: sample.lonLat ?? cellToLonLat(sample.cell),
    value: Number.isFinite(sample.value) ? sample.value : null,
    exact: Boolean(sample.exact),
    tile: sample.tile,
    targetTile: sample.targetTile,
    tileKey: sample.tileKey
  };
}

function broadcastSelection(selection) {
  const message = { type: "hpxviewer:selected", payload: selection };
  window.dispatchEvent(new CustomEvent("hpxviewer:selected", { detail: selection }));
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, "*");
  }
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(message, "*");
  }
}

function persistSelection(selection) {
  fetch("/api/selection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selection)
  }).catch(() => {});
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (Math.abs(value) >= 1000 || Math.abs(value) < 0.001) {
    return value.toExponential(3);
  }
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function formatOrderCounts(counts) {
  return Object.entries(counts)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([order, count]) => `o${order}:${count}`)
    .join(" ");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

async function loadDatasetIndex() {
  const response = await fetch(DATASET_INDEX_URL);
  if (!response.ok) {
    throw new Error(`Dataset index request failed with ${response.status}`);
  }
  const catalog = await response.json();
  if (!catalog || !Array.isArray(catalog.datasets) || catalog.datasets.length === 0) {
    throw new Error("Dataset index must define at least one dataset.");
  }
  for (const dataset of catalog.datasets) {
    if (!dataset.id || !dataset.manifest) {
      throw new Error("Each dataset index entry must define id and manifest.");
    }
  }
  return catalog;
}

function selectedDatasetId(catalog) {
  const requested = new URLSearchParams(window.location.search).get("dataset");
  if (requested && catalog.datasets.some((dataset) => dataset.id === requested)) {
    return requested;
  }
  if (catalog.default && catalog.datasets.some((dataset) => dataset.id === catalog.default)) {
    return catalog.default;
  }
  return catalog.datasets[0].id;
}
