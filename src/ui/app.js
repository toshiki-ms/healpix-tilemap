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
import { defaultExportFileName, exportImage, exportMetadata, renderExportBlob } from "./export-image.js";

const DATASET_INDEX_URL = "/datasets/index.json";
const MIN_CAMERA_FOV = 1;
const MAX_CAMERA_FOV = 179.9;

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
      axesToggle: document.querySelector("#axesToggle"),
      northUpToggle: document.querySelector("#northUpToggle"),
      graticuleToggle: document.querySelector("#graticuleToggle"),
      scaleBarToggle: document.querySelector("#scaleBarToggle"),
      viewPanelToggle: document.querySelector("#viewPanelToggle"),
      resetViewButton: document.querySelector("#resetViewButton"),
      cameraPositionValue: document.querySelector("#cameraPositionValue"),
      cameraTargetValue: document.querySelector("#cameraTargetValue"),
      viewCenterValue: document.querySelector("#viewCenterValue"),
      viewVectorValue: document.querySelector("#viewVectorValue"),
      viewLonInput: document.querySelector("#viewLonInput"),
      viewLatInput: document.querySelector("#viewLatInput"),
      viewDistanceInput: document.querySelector("#viewDistanceInput"),
      viewFovInput: document.querySelector("#viewFovInput"),
      viewStatus: document.querySelector("#viewStatus"),
      copyViewButton: document.querySelector("#copyViewButton"),
      copyUrlButton: document.querySelector("#copyUrlButton"),
      copyPythonButton: document.querySelector("#copyPythonButton"),
      applyJsonButton: document.querySelector("#applyJsonButton"),
      exportMetadataButton: document.querySelector("#exportMetadataButton"),
      viewJsonInput: document.querySelector("#viewJsonInput"),
      openExportButton: document.querySelector("#openExportButton"),
      exportDialog: document.querySelector("#exportDialog"),
      exportFilenameInput: document.querySelector("#exportFilenameInput"),
      exportFormatSelect: document.querySelector("#exportFormatSelect"),
      exportDialogModeSelect: document.querySelector("#exportDialogModeSelect"),
      exportDialogScaleSelect: document.querySelector("#exportDialogScaleSelect"),
      exportDialogWidthInput: document.querySelector("#exportDialogWidthInput"),
      exportDialogHeightInput: document.querySelector("#exportDialogHeightInput"),
      exportDialogMetadataToggle: document.querySelector("#exportDialogMetadataToggle"),
      exportDialogTransparentToggle: document.querySelector("#exportDialogTransparentToggle"),
      exportSaveButton: document.querySelector("#exportSaveButton"),
      exportCancelButton: document.querySelector("#exportCancelButton"),
      exportStatus: document.querySelector("#exportStatus"),
      colorbarRamp: document.querySelector("#colorbarRamp"),
      colorMin: document.querySelector("#colorMin"),
      colorMax: document.querySelector("#colorMax"),
      scaleBarLine: document.querySelector("#scaleBarLine"),
      scaleBarValue: document.querySelector("#scaleBarValue"),
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
      grid: false,
      axes: false,
      northUp: false,
      graticule: false,
      scaleBar: false,
      exportEmbedMetadata: true,
      exportMode: "map",
      exportScale: 1,
      exportWidth: "",
      exportHeight: "",
      viewPanel: true
    };
    this.datasetCatalog = null;
    this.datasetId = "";
    this.lastUrlWrite = 0;
    this.lastViewPanelUpdate = 0;
    this.pendingCameraUrlValue = null;
    this.renderStats = null;
    this.selectedSample = null;
    this.viewInputsDirty = false;
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
    this.controls.axesToggle.addEventListener("click", () => {
      this.state.axes = !this.state.axes;
      this.globe?.setAxesVisible(this.state.axes);
      this.controls.axesToggle.setAttribute("aria-pressed", String(this.state.axes));
      this.writeUrlState();
    });
    this.controls.northUpToggle.addEventListener("change", () => {
      this.state.northUp = this.controls.northUpToggle.checked;
      this.globe?.setNorthUp(this.state.northUp);
      this.syncViewOptionStyles();
      this.writeUrlState();
    });
    this.controls.graticuleToggle.addEventListener("change", () => {
      this.state.graticule = this.controls.graticuleToggle.checked;
      this.globe?.setGraticuleVisible(this.state.graticule);
      this.syncViewOptionStyles();
      this.writeUrlState();
    });
    this.controls.scaleBarToggle.addEventListener("change", () => {
      this.state.scaleBar = this.controls.scaleBarToggle.checked;
      this.syncViewOptionStyles();
      this.root.dataset.scaleBar = String(this.state.scaleBar);
      this.updateScaleBar();
      this.writeUrlState();
    });
    this.controls.viewPanelToggle.addEventListener("click", () => {
      this.state.viewPanel = !this.state.viewPanel;
      this.root.dataset.viewPanel = String(this.state.viewPanel);
      this.controls.viewPanelToggle.setAttribute("aria-pressed", String(this.state.viewPanel));
      this.writeUrlState();
    });
    this.controls.resetViewButton.addEventListener("click", () => {
      this.net.resetView();
      this.globe.resetView();
      this.viewInputsDirty = false;
      this.updateViewPanel(true);
      this.writeUrlState();
    });
    for (const control of this.viewInputControls()) {
      control.addEventListener("input", () => {
        this.viewInputsDirty = true;
      });
      control.addEventListener("change", () => {
        if (this.viewInputsDirty) {
          this.applyViewInputs();
        }
      });
      control.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.applyViewInputs();
        }
      });
    }
    this.controls.applyJsonButton.addEventListener("click", () => this.applyViewJson());
    this.controls.copyViewButton.addEventListener("click", () => this.copyViewJson());
    this.controls.copyUrlButton.addEventListener("click", () => this.copyViewUrl());
    this.controls.copyPythonButton.addEventListener("click", () => this.copyViewPython());
    this.controls.exportMetadataButton.addEventListener("click", async () => {
      this.setViewStatus("Saving view JSON...");
      const result = await exportMetadata(this);
      this.setViewStatus(exportResultMessage(result));
    });
    this.controls.openExportButton.addEventListener("click", () => this.openExportDialog("png"));
    this.controls.exportCancelButton.addEventListener("click", () => this.closeExportDialog());
    this.controls.exportSaveButton.addEventListener("click", () => this.exportCurrentImage());
    this.controls.exportFormatSelect.addEventListener("change", () => this.updateExportFilenameExtension());
    for (const control of [this.controls.exportDialogMetadataToggle, this.controls.exportDialogTransparentToggle]) {
      control.addEventListener("change", () => this.syncExportDialogOptionStyles());
    }
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.controls.exportDialog.hidden) {
        this.closeExportDialog();
      }
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
    if (this.pendingCameraUrlValue) {
      this.globe.applyCameraUrlValue(this.pendingCameraUrlValue);
      this.pendingCameraUrlValue = null;
    }
    this.globe.setAxesVisible(this.state.axes);
    this.globe.setNorthUp(this.state.northUp);
    this.globe.setGraticuleVisible(this.state.graticule);
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
    if (patch.axes !== undefined) {
      this.state.axes = Boolean(patch.axes);
      this.globe?.setAxesVisible(this.state.axes);
    }
    if (patch.northUp !== undefined || patch.north !== undefined) {
      this.state.northUp = Boolean(patch.northUp ?? patch.north);
      this.globe?.setNorthUp(this.state.northUp);
    }
    if (patch.graticule !== undefined) {
      this.state.graticule = Boolean(patch.graticule);
      this.globe?.setGraticuleVisible(this.state.graticule);
    }
    if (patch.scaleBar !== undefined || patch.scalebar !== undefined) {
      this.state.scaleBar = Boolean(patch.scaleBar ?? patch.scalebar);
    }
    if (patch.camera || patch.centerLonLat || patch.lonLat || patch.position) {
      this.globe?.applyViewState(patch.camera ? patch : { camera: patch });
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
      viewState: this.currentViewState(),
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
    this.updateViewPanel();
    this.updateScaleBar();
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
    const axes = params.get("axes");
    if (axes === "0" || axes === "false") {
      this.state.axes = false;
    } else if (axes === "1" || axes === "true") {
      this.state.axes = true;
    }
    const north = params.get("north");
    if (north === "0" || north === "false") {
      this.state.northUp = false;
    } else if (north === "1" || north === "true") {
      this.state.northUp = true;
    }
    const graticule = params.get("graticule");
    if (graticule === "0" || graticule === "false") {
      this.state.graticule = false;
    } else if (graticule === "1" || graticule === "true") {
      this.state.graticule = true;
    }
    const scaleBar = params.get("scalebar");
    if (scaleBar === "0" || scaleBar === "false") {
      this.state.scaleBar = false;
    } else if (scaleBar === "1" || scaleBar === "true") {
      this.state.scaleBar = true;
    }
    const viewPanel = params.get("panel");
    if (viewPanel === "0" || viewPanel === "false") {
      this.state.viewPanel = false;
    } else if (viewPanel === "1" || viewPanel === "true") {
      this.state.viewPanel = true;
    }
    this.pendingCameraUrlValue = params.get("camera");
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
    params.set("axes", this.state.axes ? "1" : "0");
    params.set("north", this.state.northUp ? "1" : "0");
    params.set("graticule", this.state.graticule ? "1" : "0");
    params.set("scalebar", this.state.scaleBar ? "1" : "0");
    params.set("panel", this.state.viewPanel ? "1" : "0");
    params.set("min", formatNumber(this.state.min));
    params.set("max", formatNumber(this.state.max));
    if (this.state.view === "globe" && this.globe) {
      params.set("camera", this.globe.cameraUrlValue());
    }
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
    this.controls.axesToggle.setAttribute("aria-pressed", String(this.state.axes));
    this.controls.northUpToggle.checked = this.state.northUp;
    this.controls.graticuleToggle.checked = this.state.graticule;
    this.controls.scaleBarToggle.checked = this.state.scaleBar;
    this.syncViewOptionStyles();
    this.controls.exportDialogMetadataToggle.checked = this.state.exportEmbedMetadata;
    this.syncExportDialogOptionStyles();
    this.controls.viewPanelToggle.setAttribute("aria-pressed", String(this.state.viewPanel));
    this.root.dataset.viewPanel = String(this.state.viewPanel);
    this.root.dataset.scaleBar = String(this.state.scaleBar);
    this.updateColorbar();
    this.updateViewPanel(true);
    this.updateScaleBar();
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

  updateViewPanel(force = false) {
    const now = performance.now();
    if (!force && now - this.lastViewPanelUpdate < 250) {
      return;
    }
    this.lastViewPanelUpdate = now;
    const view = this.currentViewState();
    const camera = view.camera;
    if (!camera) {
      this.controls.cameraPositionValue.textContent = "-";
      this.controls.cameraTargetValue.textContent = "-";
      this.controls.viewCenterValue.textContent = "-";
      this.controls.viewVectorValue.textContent = "-";
      return;
    }
    this.controls.cameraPositionValue.textContent = formatVector(camera.position, 3);
    this.controls.cameraTargetValue.textContent = formatVector(camera.target, 3);
    this.controls.viewCenterValue.textContent = `${camera.centerLonLat.lon.toFixed(4)}, ${camera.centerLonLat.lat.toFixed(4)}`;
    this.controls.viewVectorValue.textContent = formatVector(camera.centerVector, 4);
    const editingViewInputs = this.viewInputControls().includes(document.activeElement);
    if ((!editingViewInputs || force) && !this.viewInputsDirty) {
      this.controls.viewLonInput.value = camera.centerLonLat.lon.toFixed(6);
      this.controls.viewLatInput.value = camera.centerLonLat.lat.toFixed(6);
      this.controls.viewDistanceInput.value = camera.distance.toFixed(4);
      this.controls.viewFovInput.value = camera.fov.toFixed(2);
    }
    if (document.activeElement !== this.controls.viewJsonInput && (force || !this.controls.viewJsonInput.value.trim())) {
      this.controls.viewJsonInput.value = JSON.stringify(view, null, 2);
    }
  }

  currentViewState() {
    const rendererState = this.state.view === "globe"
      ? this.globe?.viewState()
      : {
          net: {
            scale: this.net?.transform.scale ?? null,
            offsetX: this.net?.transform.offsetX ?? null,
            offsetY: this.net?.transform.offsetY ?? null
          }
        };
    return {
      datasetId: this.datasetId,
      layerId: this.state.layerId,
      view: this.state.view,
      order: this.state.maxOrder,
      colormap: this.state.colormap,
      scale: this.state.scale,
      min: this.state.min,
      max: this.state.max,
      relief: this.state.relief,
      grid: this.state.grid,
      axes: this.state.axes,
      northUp: this.state.northUp,
      graticule: this.state.graticule,
      scaleBar: this.state.scaleBar,
      ...rendererState
    };
  }

  applyViewInputs() {
    const lon = Number(this.controls.viewLonInput.value);
    const lat = Number(this.controls.viewLatInput.value);
    const distance = Number(this.controls.viewDistanceInput.value);
    const fov = Number(this.controls.viewFovInput.value);
    if (this.state.view !== "globe" || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      this.setViewStatus("Invalid camera inputs.");
      return;
    }
    this.globe.focusLonLat(lon, lat, Number.isFinite(distance) ? distance : null);
    const appliedFov = normalizeCameraFov(fov);
    if (Number.isFinite(appliedFov)) {
      this.globe.applyViewState({ fov: appliedFov });
    }
    this.viewInputsDirty = false;
    this.updateViewPanel(true);
    this.writeUrlState();
    this.setViewStatus(fov !== appliedFov && Number.isFinite(appliedFov)
      ? `Applied camera view. FOV limited to ${MAX_CAMERA_FOV}.`
      : "Applied camera view.");
  }

  applyViewJson() {
    let parsed;
    try {
      parsed = JSON.parse(this.controls.viewJsonInput.value);
    } catch {
      this.setViewStatus("Invalid view JSON.");
      return;
    }
    this.viewInputsDirty = false;
    this.setViewState(parsed);
    this.updateViewPanel(true);
    this.writeUrlState();
    this.setViewStatus("Applied view JSON.");
  }

  viewInputControls() {
    return [
      this.controls.viewLonInput,
      this.controls.viewLatInput,
      this.controls.viewDistanceInput,
      this.controls.viewFovInput
    ];
  }

  async copyViewJson() {
    const text = JSON.stringify(this.currentViewState(), null, 2);
    this.controls.viewJsonInput.value = text;
    await this.copyTextWithStatus(text, "Copied view JSON.");
  }

  async copyViewUrl() {
    this.writeUrlState(false);
    await this.copyTextWithStatus(window.location.href, "Copied view URL.");
  }

  async copyViewPython() {
    await this.copyTextWithStatus(this.currentViewPython(), "Copied Python snippet.");
  }

  async copyTextWithStatus(text, message) {
    try {
      await copyText(text);
      this.setViewStatus(message);
    } catch (error) {
      this.setViewStatus(`Copy failed: ${errorMessage(error)}`);
    }
  }

  currentViewPython() {
    const args = [
      pythonLiteral(this.datasetId),
      `layer=${pythonLiteral(this.state.layerId)}`,
      `view=${pythonLiteral(this.state.view)}`,
      `order=${this.state.maxOrder}`,
      `cmap=${pythonLiteral(this.state.colormap)}`,
      `scale=${pythonLiteral(this.state.scale)}`,
      `min=${formatPythonNumber(this.state.min)}`,
      `max=${formatPythonNumber(this.state.max)}`,
      `relief=${pythonLiteral(this.state.relief)}`,
      `grid=${pythonLiteral(this.state.grid)}`
    ];
    const extra = [
      `axes=${pythonLiteral(this.state.axes)}`,
      `north=${pythonLiteral(this.state.northUp)}`,
      `graticule=${pythonLiteral(this.state.graticule)}`,
      `scalebar=${pythonLiteral(this.state.scaleBar)}`,
      `panel=${pythonLiteral(this.state.viewPanel)}`
    ];
    if (this.state.view === "globe" && this.globe) {
      extra.push(`camera=${pythonLiteral(this.globe.cameraUrlValue())}`);
    }
    return [
      "from hpxviewer import Viewer",
      "",
      "v = Viewer(",
      ...args.map((line) => `    ${line},`),
      ").set(",
      ...extra.map((line) => `    ${line},`),
      ")",
      "v.show()",
      ""
    ].join("\n");
  }

  openExportDialog(format = "png") {
    const extension = format === "jpeg" ? "jpg" : format;
    this.controls.exportFormatSelect.value = extension === "jpg" ? "jpg" : "png";
    this.controls.exportDialogModeSelect.value = this.state.exportMode;
    this.controls.exportDialogScaleSelect.value = String(this.state.exportScale);
    this.controls.exportDialogWidthInput.value = this.state.exportWidth;
    this.controls.exportDialogHeightInput.value = this.state.exportHeight;
    this.controls.exportDialogTransparentToggle.checked = false;
    this.controls.exportDialogMetadataToggle.checked = this.state.exportEmbedMetadata;
    this.controls.exportFilenameInput.value = defaultExportFileName(this, extension);
    this.updateExportFilenameExtension();
    this.setExportStatus("");
    this.controls.exportDialog.hidden = false;
    this.controls.exportFilenameInput.focus();
    this.controls.exportFilenameInput.select();
  }

  closeExportDialog() {
    this.controls.exportDialog.hidden = true;
  }

  updateExportFilenameExtension() {
    const format = this.controls.exportFormatSelect.value === "jpg" ? "jpg" : "png";
    const input = this.controls.exportFilenameInput;
    const base = input.value.trim() || defaultExportFileName(this, format);
    input.value = base.replace(/\.(png|jpe?g)$/i, `.${format}`);
    const transparentDisabled = format !== "png";
    this.controls.exportDialogTransparentToggle.disabled = transparentDisabled;
    if (transparentDisabled) {
      this.controls.exportDialogTransparentToggle.checked = false;
    }
    this.syncExportDialogOptionStyles();
  }

  setExportStatus(message) {
    this.controls.exportStatus.textContent = message;
  }

  setViewStatus(message) {
    this.controls.viewStatus.textContent = message;
  }

  syncViewOptionStyles() {
    for (const control of [this.controls.northUpToggle, this.controls.graticuleToggle, this.controls.scaleBarToggle]) {
      syncCheckField(control);
    }
  }

  syncExportDialogOptionStyles() {
    for (const control of [this.controls.exportDialogMetadataToggle, this.controls.exportDialogTransparentToggle]) {
      syncCheckField(control);
    }
  }

  async exportCurrentImage() {
    const renderer = this.state.view === "globe" ? this.globe : this.net;
    const format = this.controls.exportFormatSelect.value;
    const width = Number(this.controls.exportDialogWidthInput.value);
    const height = Number(this.controls.exportDialogHeightInput.value);
    const transparent = this.controls.exportDialogTransparentToggle.checked;
    const embedMetadata = this.controls.exportDialogMetadataToggle.checked;
    renderer.draw();
    this.controls.exportSaveButton.disabled = true;
    this.setExportStatus("Preparing image...");
    try {
      const result = await exportImage(this, {
        mode: this.controls.exportDialogModeSelect.value,
        format,
        scale: Number(this.controls.exportDialogScaleSelect.value),
        width: Number.isFinite(width) && width > 0 ? width : null,
        height: Number.isFinite(height) && height > 0 ? height : null,
        transparent,
        embedMetadata,
        filename: this.controls.exportFilenameInput.value
      });
      this.state.exportMode = this.controls.exportDialogModeSelect.value;
      this.state.exportScale = Number(this.controls.exportDialogScaleSelect.value);
      this.state.exportWidth = this.controls.exportDialogWidthInput.value;
      this.state.exportHeight = this.controls.exportDialogHeightInput.value;
      this.state.exportEmbedMetadata = embedMetadata;
      this.setExportStatus(exportResultMessage(result));
      if (result.method !== "canceled") {
        setTimeout(() => this.closeExportDialog(), 650);
      }
    } catch (error) {
      this.setExportStatus(error instanceof Error ? error.message : String(error));
    } finally {
      this.controls.exportSaveButton.disabled = false;
    }
  }

  async exportImageDataUrl(options = {}) {
    const renderer = this.state.view === "globe" ? this.globe : this.net;
    renderer.draw();
    const { blob, extension, width, height } = await renderExportBlob(this, {
      mode: options.mode ?? this.state.exportMode,
      format: options.format ?? "png",
      scale: options.scale ?? this.state.exportScale,
      width: options.width ?? null,
      height: options.height ?? null,
      transparent: Boolean(options.transparent),
      embedMetadata: options.embedMetadata !== false
    });
    return {
      dataUrl: await blobToDataUrl(blob),
      extension,
      width,
      height,
      bytes: blob.size,
      type: blob.type
    };
  }

  updateScaleBar() {
    if (!this.state.scaleBar || this.state.view !== "globe" || !this.globe) {
      return;
    }
    const scale = this.globe.surfaceScalePerPixel(120);
    if (!Number.isFinite(scale.valuePerPixel) || scale.valuePerPixel <= 0) {
      this.controls.scaleBarValue.textContent = "-";
      return;
    }
    const maxPixels = 150;
    const distance = niceDistance(scale.valuePerPixel * maxPixels);
    const width = Math.max(36, Math.min(maxPixels, distance / scale.valuePerPixel));
    this.controls.scaleBarLine.style.width = `${width.toFixed(1)}px`;
    this.controls.scaleBarValue.textContent = formatScaleDistance(distance, scale.unit);
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

function formatVector(vector, precision = 3) {
  if (!vector) {
    return "-";
  }
  const values = [vector.x, vector.y, vector.z].map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    return "-";
  }
  return values.map((value) => value.toFixed(precision)).join(", ");
}

function formatPythonNumber(value) {
  if (!Number.isFinite(value)) {
    return "None";
  }
  return Number(value).toPrecision(12).replace(/\.?0+($|e)/, "$1");
}

function normalizeCameraFov(value) {
  const fov = Number(value);
  if (!Number.isFinite(fov) || fov < MIN_CAMERA_FOV) {
    return Number.NaN;
  }
  return Math.min(MAX_CAMERA_FOV, fov);
}

function pythonLiteral(value) {
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    return formatPythonNumber(value);
  }
  return JSON.stringify(String(value));
}

function niceDistance(maxDistance) {
  if (!Number.isFinite(maxDistance) || maxDistance <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(maxDistance));
  const base = 10 ** exponent;
  for (const multiplier of [5, 2, 1]) {
    const candidate = multiplier * base;
    if (candidate <= maxDistance) {
      return candidate;
    }
  }
  return base * 0.5;
}

function formatDistance(km) {
  if (!Number.isFinite(km)) {
    return "-";
  }
  if (km >= 1000) {
    return `${Math.round(km).toLocaleString("en-US")} km`;
  }
  if (km >= 1) {
    return `${Math.round(km)} km`;
  }
  return `${Math.round(km * 1000)} m`;
}

function formatScaleDistance(value, unit) {
  if (unit === "km") {
    return formatDistance(value);
  }
  if (unit === "deg") {
    return formatAngularDistance(value);
  }
  return `${formatShortNumber(value)} ${unit || ""}`.trim();
}

function formatAngularDistance(degrees) {
  if (!Number.isFinite(degrees)) {
    return "-";
  }
  if (degrees >= 1) {
    return `${formatShortNumber(degrees)} deg`;
  }
  const arcmin = degrees * 60;
  if (arcmin >= 1) {
    return `${formatShortNumber(arcmin)} arcmin`;
  }
  return `${formatShortNumber(degrees * 3600)} arcsec`;
}

function formatShortNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "-";
  }
  if (Math.abs(number) >= 100) {
    return String(Math.round(number));
  }
  if (Math.abs(number) >= 10) {
    return number.toFixed(1).replace(/\.0$/, "");
  }
  if (Math.abs(number) >= 1) {
    return number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  return number.toPrecision(2);
}

function exportResultMessage(result) {
  if (!result || result.method === "canceled") {
    return "Export canceled.";
  }
  const size = result.bytes >= 1024 * 1024
    ? `${(result.bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(result.bytes / 1024))} KiB`;
  if (result.method === "file-picker") {
    return `Saved ${result.filename} (${size}).`;
  }
  return `Download started: ${result.filename} (${size}).`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function syncCheckField(control) {
  const field = control.closest(".check-field");
  field?.classList.toggle("is-checked", control.checked);
  field?.classList.toggle("is-disabled", control.disabled);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read export blob.")));
    reader.readAsDataURL(blob);
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to execCommand below for browsers that expose the API but deny permission.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard is unavailable.");
  }
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
