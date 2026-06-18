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
      paneGrid: document.querySelector("#paneGrid"),
      splitModeSelect: document.querySelector("#splitModeSelect"),
      paneSelect: document.querySelector("#paneSelect"),
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
      linkCameraToggle: document.querySelector("#linkCameraToggle"),
      linkDatasetToggle: document.querySelector("#linkDatasetToggle"),
      linkColorScaleToggle: document.querySelector("#linkColorScaleToggle"),
      showFootprintToggle: document.querySelector("#showFootprintToggle"),
      footprintColorInput: document.querySelector("#footprintColorInput"),
      overviewModeToggle: document.querySelector("#overviewModeToggle"),
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
      loadViewStateButton: document.querySelector("#loadViewStateButton"),
      exportMetadataButton: document.querySelector("#exportMetadataButton"),
      viewStateFileInput: document.querySelector("#viewStateFileInput"),
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
    this.state = defaultViewerState();
    this.datasetCatalog = null;
    this.datasetId = "";
    this.resources = new Map();
    this.panes = [];
    this.activePaneId = "left";
    this.splitMode = "single";
    this.linkCamera = false;
    this.linkDataset = false;
    this.linkColorScale = false;
    this.showFootprint = false;
    this.footprintColor = "#000000";
    this.overviewMode = false;
    this.lastUrlWrite = 0;
    this.lastViewPanelUpdate = 0;
    this.pendingCameraUrlValue = null;
    this.renderStats = null;
    this.selectedSample = null;
    this.viewInputsDirty = false;
    this.debugMode = new URLSearchParams(window.location.search).has("debug");
    this.lastDebugPanelUpdate = 0;
    this.debugPanel = this.debugMode ? createDebugPanel() : null;
    if (this.debugPanel) {
      this.root.appendChild(this.debugPanel.element);
    }
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "hpxviewer:setViewState" || !event.data.payload) {
        return;
      }
      Promise.resolve(this.setViewState(event.data.payload))
        .then(() => {
          const targetOrigin = event.origin && event.origin !== "null" ? event.origin : "*";
          event.source?.postMessage({ type: "hpxviewer:viewStateApplied" }, targetOrigin);
        })
        .catch((error) => {
          console.warn("Could not apply posted view state.", error);
        });
    });
  }

  async start() {
    try {
      this.datasetCatalog = await loadDatasetIndex();
    } catch (error) {
      this.showDatasetSetupMessage(error);
      return;
    }
    if (this.debugMode) {
      window.__hpxApp = this;
      window.__hpxTileDiagnostics = () => this.tileDiagnostics();
    }
    warmWasmDecoder();
    this.applySplitUrlState();
    this.datasetId = selectedDatasetId(this.datasetCatalog);
    const resource = await this.loadDatasetResource(this.datasetId);
    const rightDatasetId = rightDatasetIdFromUrl(this.datasetCatalog, this.datasetId);
    const rightResource = rightDatasetId === this.datasetId
      ? resource
      : await this.loadDatasetResource(rightDatasetId);
    this.useResource(resource);
    this.state = stateForManifest(this.manifest, this.state);
    this.applyUrlState();
    this.createPanes(resource, rightResource);
    this.setupControls();
    this.setupRenderers();
    if (this.overviewMode) {
      this.applyOverviewMode();
    }
    installRemoteControl(this);
    this.updateDisplayControls();
    window.addEventListener("resize", () => {
      for (const pane of this.visiblePanes()) {
        pane.net?.resize();
        pane.globe?.resize();
      }
    });
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

  async loadDatasetResource(datasetId) {
    const id = String(datasetId || "");
    const cached = this.resources.get(id);
    if (cached) {
      return cached;
    }
    const dataset = this.datasetCatalog.datasets.find((item) => item.id === id);
    if (!dataset) {
      throw new Error(`Unknown dataset: ${id}`);
    }
    const manifestUrl = new URL(`/datasets/${dataset.manifest}`, window.location.href).href;
    const manifest = await loadManifest(manifestUrl);
    const source = new DirectoryTileSource(manifest, manifestUrl);
    const cache = new TileCache({
      source,
      byteBudget: 384 * 1024 * 1024,
      maxConcurrentRequests: 24
    });
    const scheduler = new TileScheduler({ cache, manifest });
    const resource = { datasetId: id, dataset, manifestUrl, manifest, source, cache, scheduler };
    cache.addEventListener("tileload", () => this.updateLoadStatus());
    cache.addEventListener("tileerror", () => this.updateLoadStatus());
    this.resources.set(id, resource);
    return resource;
  }

  useResource(resource) {
    this.datasetId = resource.datasetId;
    this.manifestUrl = resource.manifestUrl;
    this.manifest = resource.manifest;
    this.source = resource.source;
    this.cache = resource.cache;
    this.scheduler = resource.scheduler;
  }

  createPanes(resource, rightResource = resource) {
    const leftState = this.state;
    const rightOverrides = rightResource === resource
      ? { ...this.state }
      : { ...this.state, layerId: "", min: Number.NaN, max: Number.NaN };
    const rightState = stateForManifest(rightResource.manifest, rightOverrides);
    applyPrefixedUrlState(rightState, rightResource.manifest, "right");
    const left = this.createPane("left", resource, leftState);
    const right = this.createPane("right", rightResource, rightState);
    const active = new URLSearchParams(window.location.search).get("pane");
    this.activePaneId = active === "right" ? "right" : "left";
    const params = new URLSearchParams(window.location.search);
    right.pendingCameraUrlValue = params.get("rightCamera");
    if (this.splitMode === "single" && this.activePaneId === "right" && !right.pendingCameraUrlValue) {
      right.pendingCameraUrlValue = this.pendingCameraUrlValue;
    }
    this.panes = [left, right];
    this.syncActivePaneAliases(this.activePane());
  }

  createPane(id, resource, state) {
    const element = document.querySelector(`[data-pane-id="${id}"]`);
    if (!element) {
      throw new Error(`Missing pane element: ${id}`);
    }
    const pane = {
      id,
      element,
      label: element.querySelector(".pane-label"),
      datasetId: resource.datasetId,
      resource,
      manifest: resource.manifest,
      manifestUrl: resource.manifestUrl,
      source: resource.source,
      cache: resource.cache,
      scheduler: resource.scheduler,
      state,
      net: null,
      globe: null,
      renderStats: null,
      selectedSample: null,
      pendingCameraUrlValue: id === "left" ? this.pendingCameraUrlValue : null
    };
    element.addEventListener("pointerdown", () => this.setActivePane(id), { capture: true });
    return pane;
  }

  setupControls() {
    this.root.dataset.view = this.state.view;
    this.controls.paneGrid.dataset.split = this.splitMode;
    this.root.dataset.split = this.splitMode;
    this.controls.splitModeSelect.value = this.splitMode;
    this.controls.paneSelect.replaceChildren(...paneOptionsForSplit(this.splitMode));
    this.controls.paneSelect.value = this.activePaneId;
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

    this.controls.splitModeSelect.addEventListener("change", () => {
      this.setSplitMode(this.controls.splitModeSelect.value);
      this.writeUrlState();
    });
    this.controls.paneSelect.addEventListener("change", () => {
      this.setActivePane(this.controls.paneSelect.value);
      this.writeUrlState();
    });
    this.controls.linkCameraToggle.addEventListener("change", () => {
      this.linkCamera = this.controls.linkCameraToggle.checked;
      this.syncToolbarCheckStyles();
      if (this.linkCamera) {
        this.syncLinkedCamera();
      }
      this.writeUrlState();
    });
    this.controls.linkDatasetToggle.addEventListener("change", () => {
      this.linkDataset = this.controls.linkDatasetToggle.checked;
      this.syncToolbarCheckStyles();
      if (this.linkDataset) {
        this.copyDatasetToOtherPanes(this.activePane()).catch((error) => this.setViewStatus(errorMessage(error)));
      }
      this.writeUrlState();
    });
    this.controls.linkColorScaleToggle.addEventListener("change", () => {
      this.linkColorScale = this.controls.linkColorScaleToggle.checked;
      this.syncToolbarCheckStyles();
      if (this.linkColorScale) {
        this.copyColorScaleToOtherPanes(this.activePane());
      }
      this.writeUrlState();
    });
    this.controls.showFootprintToggle.addEventListener("change", () => {
      this.showFootprint = this.controls.showFootprintToggle.checked;
      this.syncToolbarCheckStyles();
      this.writeUrlState();
    });
    this.controls.footprintColorInput.addEventListener("input", () => {
      this.footprintColor = normalizeColor(this.controls.footprintColorInput.value, "#000000");
      this.writeUrlState(true);
    });
    this.controls.footprintColorInput.addEventListener("change", () => {
      this.footprintColor = normalizeColor(this.controls.footprintColorInput.value, "#000000");
      this.writeUrlState();
    });
    this.controls.overviewModeToggle.addEventListener("change", () => {
      this.overviewMode = this.controls.overviewModeToggle.checked;
      this.applyOverviewMode();
      this.syncToolbarCheckStyles();
      this.writeUrlState();
    });
    this.controls.datasetSelect.addEventListener("change", () => {
      this.setDatasetForActivePane(this.controls.datasetSelect.value)
        .catch((error) => this.setViewStatus(errorMessage(error)));
    });
    this.controls.viewMode.addEventListener("change", () => {
      this.state.view = this.controls.viewMode.value;
      this.root.dataset.view = this.state.view;
      this.activePane().element.dataset.view = this.state.view;
      this.applyLinkedPaneState("view", this.state.view);
      this.writeUrlState();
    });
    this.controls.layerSelect.addEventListener("change", () => {
      this.state.layerId = this.controls.layerSelect.value;
      this.autoStretch();
      this.copyColorScaleToOtherPanes(this.activePane(), { includeLayer: true });
      this.writeUrlState();
    });
    this.controls.orderSelect.addEventListener("change", () => {
      this.state.maxOrder = Number(this.controls.orderSelect.value);
      const minOrder = this.manifest.minOrder ?? this.manifest.tileShift;
      this.state.order = clampOrder(this.state.order, minOrder, this.state.maxOrder);
      this.applyLinkedPaneState("maxOrder", this.state.maxOrder);
      this.writeUrlState();
    });
    this.controls.colormapSelect.addEventListener("change", () => {
      this.state.colormap = this.controls.colormapSelect.value;
      this.updateColorbar();
      this.copyColorScaleToOtherPanes(this.activePane());
      this.writeUrlState();
    });
    this.controls.scaleSelect.addEventListener("change", () => {
      this.state.scale = this.controls.scaleSelect.value;
      this.copyColorScaleToOtherPanes(this.activePane());
      this.writeUrlState();
    });
    this.controls.minInput.addEventListener("change", () => {
      this.state.min = Number(this.controls.minInput.value);
      this.updateColorbar();
      this.copyColorScaleToOtherPanes(this.activePane());
      this.writeUrlState();
    });
    this.controls.maxInput.addEventListener("change", () => {
      this.state.max = Number(this.controls.maxInput.value);
      this.updateColorbar();
      this.copyColorScaleToOtherPanes(this.activePane());
      this.writeUrlState();
    });
    this.controls.autoStretchButton.addEventListener("click", () => {
      this.autoStretch();
      this.copyColorScaleToOtherPanes(this.activePane());
      this.writeUrlState();
    });
    this.controls.reliefToggle.addEventListener("click", () => {
      this.setSharedDisplayOption("relief", !this.state.relief);
      this.controls.reliefToggle.setAttribute("aria-pressed", String(this.state.relief));
      this.writeUrlState();
    });
    this.controls.gridToggle.addEventListener("click", () => {
      this.setSharedDisplayOption("grid", !this.state.grid);
      this.controls.gridToggle.setAttribute("aria-pressed", String(this.state.grid));
      this.writeUrlState();
    });
    this.controls.axesToggle.addEventListener("click", () => {
      this.setSharedDisplayOption("axes", !this.state.axes);
      this.controls.axesToggle.setAttribute("aria-pressed", String(this.state.axes));
      this.writeUrlState();
    });
    this.controls.northUpToggle.addEventListener("change", () => {
      this.setSharedDisplayOption("northUp", this.controls.northUpToggle.checked);
      this.syncViewOptionStyles();
      this.writeUrlState();
    });
    this.controls.graticuleToggle.addEventListener("change", () => {
      this.setSharedDisplayOption("graticule", this.controls.graticuleToggle.checked);
      this.syncViewOptionStyles();
      this.writeUrlState();
    });
    this.controls.scaleBarToggle.addEventListener("change", () => {
      this.setSharedDisplayOption("scaleBar", this.controls.scaleBarToggle.checked);
      this.syncViewOptionStyles();
      this.writeUrlState();
    });
    this.controls.viewPanelToggle.addEventListener("click", () => {
      this.setSharedDisplayOption("viewPanel", !this.state.viewPanel);
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
    this.controls.loadViewStateButton.addEventListener("click", () => {
      this.controls.viewStateFileInput.value = "";
      this.controls.viewStateFileInput.click();
    });
    this.controls.viewStateFileInput.addEventListener("change", () => this.loadViewStateFile());
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
    for (const pane of this.panes) {
      this.setupPaneRenderers(pane);
    }
    this.setActivePane(this.activePaneId, { updateControls: false });
    this.updatePaneLayout();
  }

  setupPaneRenderers(pane) {
    const mapCanvas = createPaneCanvas("map-canvas", `${pane.id} HEALPix map`);
    const globeCanvas = createPaneCanvas("globe-canvas", `${pane.id} HEALPix globe`);
    mapCanvas.id = pane.id === "left" ? "mapCanvas" : "rightMapCanvas";
    globeCanvas.id = pane.id === "left" ? "globeCanvas" : "rightGlobeCanvas";
    const label = document.createElement("span");
    label.className = "pane-label";
    label.textContent = pane.id === "left" ? "Left" : "Right";
    const scaleBar = document.createElement("section");
    scaleBar.className = "pane-scale-bar";
    scaleBar.setAttribute("aria-label", `${pane.id} scale bar`);
    const scaleBarLine = document.createElement("div");
    scaleBarLine.className = "scale-bar-line";
    const scaleBarValue = document.createElement("strong");
    scaleBarValue.textContent = "-";
    scaleBar.append(scaleBarLine, scaleBarValue);
    const inspector = createPaneInspector(pane.id);
    pane.element.replaceChildren(mapCanvas, globeCanvas, label, scaleBar, inspector.element);
    pane.label = label;
    pane.scaleBarElement = scaleBar;
    pane.scaleBarLine = scaleBarLine;
    pane.scaleBarValue = scaleBarValue;
    pane.inspector = inspector;
    pane.mapCanvas = mapCanvas;
    pane.globeCanvas = globeCanvas;
    pane.element.dataset.view = pane.state.view;
    pane.net = new NetRenderer({
      canvas: mapCanvas,
      manifest: pane.manifest,
      scheduler: pane.scheduler,
      state: pane.state,
      onHover: (sample) => this.updateInspector(sample, pane),
      onSelect: (sample) => {
        this.setActivePane(pane.id);
        this.updateSelection(sample);
      }
    });
    pane.globe = new GlobeRenderer({
      canvas: globeCanvas,
      manifest: pane.manifest,
      scheduler: pane.scheduler,
      state: pane.state,
      onHover: (sample) => this.updateInspector(sample, pane),
      onSelect: (sample) => {
        this.setActivePane(pane.id);
        this.updateSelection(sample);
      }
    });
    if (pane.pendingCameraUrlValue) {
      pane.globe.applyCameraUrlValue(pane.pendingCameraUrlValue);
      pane.pendingCameraUrlValue = null;
    }
    pane.globe.setAxesVisible(pane.state.axes);
    pane.globe.setNorthUp(pane.state.northUp);
    pane.globe.setGraticuleVisible(pane.state.graticule);
  }

  activePane() {
    return this.panes.find((pane) => pane.id === this.activePaneId) ?? this.panes[0];
  }

  paneById(id) {
    return this.panes.find((pane) => pane.id === id) ?? null;
  }

  visiblePanes() {
    if (this.splitMode === "single") {
      return [this.activePane()].filter(Boolean);
    }
    return this.panes;
  }

  setActivePane(id, { updateControls = true } = {}) {
    const targetId = this.overviewMode && id === "left" ? "right" : id;
    const pane = this.paneById(targetId);
    if (!pane) {
      return;
    }
    this.activePaneId = pane.id;
    this.syncActivePaneAliases(pane);
    this.updatePaneLayout();
    if (updateControls) {
      this.updateDisplayControls();
    }
  }

  syncActivePaneAliases(pane = this.activePane()) {
    if (!pane) {
      return;
    }
    this.useResource(pane.resource);
    this.state = pane.state;
    this.net = pane.net;
    this.globe = pane.globe;
    this.renderStats = pane.renderStats;
    this.selectedSample = pane.selectedSample;
    this.root.dataset.view = pane.state.view;
    this.root.dataset.scaleBar = String(pane.state.scaleBar);
  }

  updatePaneLayout() {
    this.root.dataset.split = this.splitMode;
    this.controls.paneGrid.dataset.split = this.splitMode;
    for (const pane of this.panes) {
      pane.element.classList.toggle("is-active", pane.id === this.activePaneId);
      pane.element.dataset.view = pane.state.view;
      pane.element.dataset.scaleBar = String(pane.state.scaleBar);
      pane.label.textContent = paneTitle(pane.id, this.splitMode, this.overviewMode);
    }
    this.controls.paneSelect.replaceChildren(...paneOptionsForSplit(this.splitMode));
    this.controls.paneSelect.value = this.activePaneId;
    this.controls.paneSelect.disabled = this.splitMode === "single";
  }

  setSplitMode(value) {
    this.splitMode = normalizeSplitMode(value);
    if (this.splitMode === "single" && !this.activePane()) {
      this.activePaneId = "left";
    }
    this.updatePaneLayout();
  }

  applySplitUrlState() {
    const params = new URLSearchParams(window.location.search);
    this.splitMode = normalizeSplitMode(params.get("split"));
    this.linkCamera = parseBooleanParam(params.get("linkCamera"), false);
    this.linkDataset = parseBooleanParam(params.get("linkDataset"), false);
    this.linkColorScale = parseBooleanParam(params.get("linkColorScale"), false);
    this.showFootprint = parseBooleanParam(params.get("footprint"), false);
    this.footprintColor = normalizeColor(params.get("footprintColor"), "#000000");
    this.overviewMode = parseBooleanParam(params.get("overview"), false);
    if (this.overviewMode) {
      if (this.splitMode === "single") {
        this.splitMode = "vertical";
      }
      this.showFootprint = true;
    }
  }

  async setDatasetForActivePane(datasetId) {
    const pane = this.activePane();
    if (!pane || pane.datasetId === datasetId) {
      return;
    }
    const resource = await this.loadDatasetResource(datasetId);
    this.assignResourceToPane(pane, resource);
    this.setupPaneRenderers(pane);
    this.setActivePane(pane.id);
    if (this.linkDataset) {
      await this.copyDatasetToOtherPanes(pane);
    }
    this.writeUrlState();
  }

  assignResourceToPane(pane, resource, overrides = {}) {
    const previous = pane.state;
    pane.datasetId = resource.datasetId;
    pane.resource = resource;
    pane.manifest = resource.manifest;
    pane.manifestUrl = resource.manifestUrl;
    pane.source = resource.source;
    pane.cache = resource.cache;
    pane.scheduler = resource.scheduler;
    pane.state = stateForManifest(resource.manifest, {
      view: previous.view,
      colormap: previous.colormap,
      scale: previous.scale,
      relief: previous.relief,
      grid: previous.grid,
      axes: previous.axes,
      northUp: previous.northUp,
      graticule: previous.graticule,
      scaleBar: previous.scaleBar,
      viewPanel: previous.viewPanel,
      exportEmbedMetadata: previous.exportEmbedMetadata,
      exportMode: previous.exportMode,
      exportScale: previous.exportScale,
      exportWidth: previous.exportWidth,
      exportHeight: previous.exportHeight,
      exportTransparent: previous.exportTransparent,
      ...overrides
    });
    pane.renderStats = null;
    pane.selectedSample = null;
  }

  async copyDatasetToOtherPanes(sourcePane) {
    if (!this.linkDataset) {
      return;
    }
    for (const pane of this.panes) {
      if (pane === sourcePane || pane.datasetId === sourcePane.datasetId) {
        continue;
      }
      this.assignResourceToPane(pane, sourcePane.resource, {
        layerId: sourcePane.state.layerId,
        maxOrder: sourcePane.state.maxOrder,
        order: sourcePane.state.order,
        min: sourcePane.state.min,
        max: sourcePane.state.max,
        relief: sourcePane.state.relief,
        grid: sourcePane.state.grid,
        axes: sourcePane.state.axes,
        northUp: sourcePane.state.northUp,
        graticule: sourcePane.state.graticule,
        scaleBar: sourcePane.state.scaleBar,
        viewPanel: sourcePane.state.viewPanel
      });
      this.setupPaneRenderers(pane);
    }
  }

  copyColorScaleToOtherPanes(sourcePane, { includeLayer = false } = {}) {
    if (!this.linkColorScale) {
      return;
    }
    for (const pane of this.panes) {
      if (pane === sourcePane) {
        continue;
      }
      if (includeLayer && pane.manifest.layers.some((layer) => layer.id === sourcePane.state.layerId)) {
        pane.state.layerId = sourcePane.state.layerId;
      }
      pane.state.colormap = sourcePane.state.colormap;
      pane.state.scale = sourcePane.state.scale;
      pane.state.min = sourcePane.state.min;
      pane.state.max = sourcePane.state.max;
      pane.state.symlogConstant = sourcePane.state.symlogConstant;
    }
  }

  setSharedDisplayOption(key, value) {
    const next = Boolean(value);
    for (const pane of this.panes) {
      pane.state[key] = next;
      if (key === "axes") {
        pane.globe?.setAxesVisible(next);
      } else if (key === "northUp") {
        pane.globe?.setNorthUp(next);
      } else if (key === "graticule") {
        pane.globe?.setGraticuleVisible(next);
      } else if (key === "scaleBar") {
        pane.element.dataset.scaleBar = String(next);
      }
    }
    this.syncActivePaneAliases(this.activePane());
    if (key === "scaleBar") {
      this.root.dataset.scaleBar = String(next);
      this.updateScaleBar();
    } else if (key === "viewPanel") {
      this.root.dataset.viewPanel = String(next);
    }
  }

  applyLinkedPaneState(key, value) {
    if (key === "view" && this.linkCamera) {
      for (const pane of this.panes) {
        if (pane.id !== this.activePaneId) {
          pane.state.view = value;
        }
      }
    }
    if (key === "maxOrder" && this.linkDataset) {
      for (const pane of this.panes) {
        if (pane.id !== this.activePaneId) {
          const minOrder = pane.manifest.minOrder ?? pane.manifest.tileShift;
          pane.state.maxOrder = clampOrder(Number(value), minOrder, pane.manifest.maxOrder);
          pane.state.order = clampOrder(pane.state.order, minOrder, pane.state.maxOrder);
        }
      }
    }
  }

  syncLinkedCamera() {
    if (!this.linkCamera || this.panes.length < 2) {
      return;
    }
    const sourcePane = this.activePane();
    if (!sourcePane) {
      return;
    }
    for (const pane of this.panes) {
      if (pane === sourcePane || pane.state.view !== sourcePane.state.view) {
        continue;
      }
      if (sourcePane.state.view === "globe" && sourcePane.globe && pane.globe) {
        pane.globe.applyViewState(sourcePane.globe.viewState());
      } else if (sourcePane.state.view === "net" && sourcePane.net && pane.net) {
        pane.net.transform = { ...sourcePane.net.transform };
      }
    }
  }

  applyOverviewMode() {
    if (!this.overviewMode) {
      return;
    }
    if (this.splitMode === "single") {
      this.splitMode = "vertical";
    }
    this.showFootprint = true;
    const left = this.paneById("left");
    if (left) {
      left.state.view = "globe";
      left.globe?.resetView();
    }
    this.activePaneId = "right";
    this.updatePaneLayout();
  }

  updateFootprintOverlay() {
    for (const pane of this.panes) {
      pane.globe?.setFootprintSegments([]);
    }
    if (!this.showFootprint || this.splitMode === "single") {
      return;
    }
    const left = this.paneById("left");
    const right = this.paneById("right");
    if (!left?.globe || left.state.view !== "globe" || !right) {
      return;
    }
    const renderer = right.state.view === "globe" ? right.globe : right.net;
    const segments = renderer?.viewportSurfaceSegments?.(32) ?? [];
    left.globe.setFootprintSegments(segments, this.footprintColor);
  }

  async setViewState(patch = {}) {
    if (patch.split !== undefined || patch.splitMode !== undefined || patch.panes !== undefined) {
      await this.applySplitViewState(patch);
    } else {
      await this.applySinglePaneViewState(this.activePane(), patch);
    }
    this.applyExportViewState(patch);
    this.updateDisplayControls();
    this.writeUrlState();
    return this.stateSnapshot();
  }

  applyExportViewState(patch = {}) {
    const source = patch.export && typeof patch.export === "object" ? patch.export : patch;
    if (source.mode !== undefined || source.exportMode !== undefined) {
      this.state.exportMode = normalizeExportMode(source.mode ?? source.exportMode);
    }
    const scale = Number(source.scale ?? source.exportScale);
    if (Number.isFinite(scale) && scale > 0) {
      this.state.exportScale = Math.max(1, Math.min(4, Math.round(scale)));
    }
    if (source.width !== undefined || source.exportWidth !== undefined) {
      this.state.exportWidth = exportDimensionString(source.width ?? source.exportWidth);
    }
    if (source.height !== undefined || source.exportHeight !== undefined) {
      this.state.exportHeight = exportDimensionString(source.height ?? source.exportHeight);
    }
    if (source.embedMetadata !== undefined || source.exportEmbedMetadata !== undefined) {
      this.state.exportEmbedMetadata = Boolean(source.embedMetadata ?? source.exportEmbedMetadata);
    }
    if (source.transparent !== undefined || source.exportTransparent !== undefined) {
      this.state.exportTransparent = Boolean(source.transparent ?? source.exportTransparent);
    }
  }

  async applySplitViewState(patch = {}) {
    this.splitMode = normalizeSplitMode(patch.splitMode ?? patch.split ?? this.splitMode);
    this.linkCamera = Boolean(patch.linkCamera ?? this.linkCamera);
    this.linkDataset = Boolean(patch.linkDataset ?? this.linkDataset);
    this.linkColorScale = Boolean(patch.linkColorScale ?? this.linkColorScale);
    this.showFootprint = Boolean(patch.showFootprint ?? patch.footprint ?? this.showFootprint);
    this.footprintColor = normalizeColor(patch.footprintColor, this.footprintColor);
    this.overviewMode = Boolean(patch.overviewMode ?? patch.overview ?? this.overviewMode);
    if (this.overviewMode && this.splitMode === "single") {
      this.splitMode = "vertical";
      this.showFootprint = true;
    }

    const panePatches = panePatchEntries(patch.panes);
    if (panePatches.length) {
      for (const [paneId, panePatch] of panePatches) {
        const pane = this.paneById(paneId);
        if (!pane) {
          continue;
        }
        const datasetId = panePatch.datasetId ?? panePatch.dataset;
        if (datasetId && datasetId !== pane.datasetId) {
          const resource = await this.loadDatasetResource(datasetId);
          this.assignResourceToPane(pane, resource, {
            layerId: "",
            min: Number.NaN,
            max: Number.NaN
          });
          this.setupPaneRenderers(pane);
        }
        await this.applySinglePaneViewState(pane, panePatch, { update: false });
      }
    } else {
      await this.applySinglePaneViewState(this.activePane(), patch, { update: false });
    }

    const active = patch.activePaneId ?? patch.paneId ?? patch.pane;
    this.activePaneId = active === "right" ? "right" : "left";
    if (this.overviewMode && this.activePaneId === "left") {
      this.activePaneId = "right";
    }
    this.syncActivePaneAliases(this.activePane());
    this.updatePaneLayout();
  }

  async applySinglePaneViewState(pane, patch = {}, { update = true } = {}) {
    if (!pane) {
      return;
    }
    if (patch.paneId === "left" || patch.paneId === "right") {
      this.setActivePane(patch.paneId);
      pane = this.activePane();
    }
    const datasetId = patch.datasetId ?? patch.dataset;
    if (datasetId && datasetId !== pane.datasetId) {
      const resource = await this.loadDatasetResource(datasetId);
      this.assignResourceToPane(pane, resource, {
        layerId: "",
        min: Number.NaN,
        max: Number.NaN
      });
      this.setupPaneRenderers(pane);
    }
    this.syncActivePaneAliases(pane);
    const nextLayerId = patch.layerId ?? patch.layer;
    const layerChanged = typeof nextLayerId === "string" && nextLayerId !== this.state.layerId;
    if (layerChanged && this.manifest.layers.some((item) => item.id === nextLayerId)) {
      this.state.layerId = nextLayerId;
    }
    if (patch.view === "globe" || patch.view === "net") {
      this.state.view = patch.view;
      this.root.dataset.view = this.state.view;
      this.activePane().element.dataset.view = this.state.view;
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
      this.setSharedDisplayOption("relief", patch.relief);
    }
    if (patch.grid !== undefined) {
      this.setSharedDisplayOption("grid", patch.grid);
    }
    if (patch.axes !== undefined) {
      this.setSharedDisplayOption("axes", patch.axes);
    }
    if (patch.northUp !== undefined || patch.north !== undefined) {
      this.setSharedDisplayOption("northUp", patch.northUp ?? patch.north);
    }
    if (patch.graticule !== undefined) {
      this.setSharedDisplayOption("graticule", patch.graticule);
    }
    if (patch.scaleBar !== undefined || patch.scalebar !== undefined) {
      this.setSharedDisplayOption("scaleBar", patch.scaleBar ?? patch.scalebar);
    }
    if (patch.viewPanel !== undefined || patch.panel !== undefined) {
      this.setSharedDisplayOption("viewPanel", patch.viewPanel ?? patch.panel);
    }
    if (patch.camera || patch.centerLonLat || patch.lonLat || patch.position) {
      this.globe?.applyViewState(patch.camera ? patch : { camera: patch });
    }
    if (patch.net && this.net) {
      const scale = Number(patch.net.scale);
      const offsetX = Number(patch.net.offsetX);
      const offsetY = Number(patch.net.offsetY);
      if (Number.isFinite(scale) && Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
        this.net.transform = { scale, offsetX, offsetY };
      }
    }
    const symlogConstant = Number(patch.symlogConstant);
    if (Number.isFinite(symlogConstant) && symlogConstant > 0) {
      this.state.symlogConstant = symlogConstant;
    }
    this.syncActivePaneAliases(this.activePane());
    if (update) {
      this.updateDisplayControls();
      this.writeUrlState();
    }
  }

  stateSnapshot() {
    return {
      datasetId: this.datasetId,
      manifestUrl: this.manifestUrl,
      activePaneId: this.activePaneId,
      splitMode: this.splitMode,
      footprintColor: this.footprintColor,
      state: { ...this.state },
      viewState: this.currentViewState(),
      renderStats: this.renderStats ? { ...this.renderStats } : null,
      cacheStats: this.cache?.stats?.() ?? null,
      panes: this.panes.map((pane) => ({
        id: pane.id,
        datasetId: pane.datasetId,
        manifestUrl: pane.manifestUrl,
        state: { ...pane.state },
        renderStats: pane.renderStats ? { ...pane.renderStats } : null,
        cacheStats: pane.cache?.stats?.() ?? null
      })),
      selection: this.selectionSnapshot(),
      url: window.location.href
    };
  }

  loop() {
    this.syncLinkedCamera();
    const panes = this.visiblePanes();
    const schedulerRequests = new Map();
    for (const pane of panes) {
      this.syncActivePaneAliases(pane);
      const renderer = pane.state.view === "globe" ? pane.globe : pane.net;
      this.updateActiveOrder(pane, renderer);
      const visible = renderer.desiredTiles();
      if (!schedulerRequests.has(pane.scheduler)) {
        schedulerRequests.set(pane.scheduler, []);
      }
      schedulerRequests.get(pane.scheduler).push({
        layerId: pane.state.layerId,
        targetTiles: visible
      });
    }
    for (const [scheduler, requests] of schedulerRequests) {
      scheduler.requestVisibleMany(requests);
    }
    this.updateFootprintOverlay();
    for (const pane of panes) {
      const renderer = pane.state.view === "globe" ? pane.globe : pane.net;
      renderer.draw();
      pane.renderStats = renderer.stats?.() ?? null;
    }
    this.syncActivePaneAliases(this.activePane());
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
    const basePane = this.splitMode === "single"
      ? this.activePane()
      : this.paneById("left") ?? this.activePane();
    params.set("split", this.splitMode);
    params.set("pane", this.activePaneId);
    params.set("dataset", basePane.datasetId);
    params.set("layer", basePane.state.layerId);
    params.set("view", basePane.state.view);
    params.set("order", String(basePane.state.maxOrder));
    params.set("cmap", basePane.state.colormap);
    params.set("scale", basePane.state.scale);
    params.set("relief", basePane.state.relief ? "1" : "0");
    params.set("grid", basePane.state.grid ? "1" : "0");
    params.set("axes", basePane.state.axes ? "1" : "0");
    params.set("north", basePane.state.northUp ? "1" : "0");
    params.set("graticule", basePane.state.graticule ? "1" : "0");
    params.set("scalebar", basePane.state.scaleBar ? "1" : "0");
    params.set("panel", basePane.state.viewPanel ? "1" : "0");
    params.set("linkCamera", this.linkCamera ? "1" : "0");
    params.set("linkDataset", this.linkDataset ? "1" : "0");
    params.set("linkColorScale", this.linkColorScale ? "1" : "0");
    params.set("footprint", this.showFootprint ? "1" : "0");
    params.set("footprintColor", this.footprintColor);
    params.set("overview", this.overviewMode ? "1" : "0");
    params.set("min", formatNumber(basePane.state.min));
    params.set("max", formatNumber(basePane.state.max));
    if (basePane.state.view === "globe" && basePane.globe) {
      params.set("camera", basePane.globe.cameraUrlValue());
    }
    const current = new URLSearchParams(window.location.search);
    const right = this.paneById("right");
    if (right && this.splitMode !== "single") {
      params.set("rightDataset", right.datasetId);
      params.set("rightLayer", right.state.layerId);
      params.set("rightView", right.state.view);
      params.set("rightOrder", String(right.state.maxOrder));
      params.set("rightCmap", right.state.colormap);
      params.set("rightScale", right.state.scale);
      params.set("rightMin", formatNumber(right.state.min));
      params.set("rightMax", formatNumber(right.state.max));
      if (right.state.view === "globe" && right.globe) {
        params.set("rightCamera", right.globe.cameraUrlValue());
      }
    }
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
    this.syncActivePaneAliases(this.activePane());
    this.controls.splitModeSelect.value = this.splitMode;
    this.controls.paneSelect.replaceChildren(...paneOptionsForSplit(this.splitMode));
    this.controls.paneSelect.value = this.activePaneId;
    this.controls.datasetSelect.value = this.datasetId;
    const paneName = paneTitle(this.activePaneId, this.splitMode, this.overviewMode);
    this.controls.datasetStatus.textContent = `${this.manifest.name} / nside ${this.manifest.nside} / ${paneName}`;
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
    this.updatePaneLayout();
    this.syncToolbarCheckStyles();
    this.updateColorbar();
    this.updateViewPanel(true);
    this.updateScaleBar();
  }

  syncToolbarCheckStyles() {
    const pairs = [
      [this.controls.linkCameraToggle, this.linkCamera],
      [this.controls.linkDatasetToggle, this.linkDataset],
      [this.controls.linkColorScaleToggle, this.linkColorScale],
      [this.controls.showFootprintToggle, this.showFootprint],
      [this.controls.overviewModeToggle, this.overviewMode]
    ];
    this.controls.footprintColorInput.value = this.footprintColor;
    for (const [control, checked] of pairs) {
      control.checked = Boolean(checked);
      syncCheckField(control);
    }
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
    this.updateDebugDiagnostics();
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

  paneViewState(pane) {
    const rendererState = pane.state.view === "globe"
      ? pane.globe?.viewState()
      : {
          net: {
            scale: pane.net?.transform.scale ?? null,
            offsetX: pane.net?.transform.offsetX ?? null,
            offsetY: pane.net?.transform.offsetY ?? null
          }
        };
    return {
      paneId: pane.id,
      datasetId: pane.datasetId,
      layerId: pane.state.layerId,
      view: pane.state.view,
      order: pane.state.maxOrder,
      colormap: pane.state.colormap,
      scale: pane.state.scale,
      min: pane.state.min,
      max: pane.state.max,
      relief: pane.state.relief,
      grid: pane.state.grid,
      axes: pane.state.axes,
      northUp: pane.state.northUp,
      graticule: pane.state.graticule,
      scaleBar: pane.state.scaleBar,
      viewPanel: pane.state.viewPanel,
      ...rendererState
    };
  }

  currentViewState() {
    const active = this.activePane();
    const activeState = this.paneViewState(active);
    const panes = Object.fromEntries(this.panes.map((pane) => [pane.id, this.paneViewState(pane)]));
    return {
      schema: "healpix-tilemap.view-state.v1",
      type: "hpxviewer:view",
      version: 2,
      split: this.splitMode,
      splitMode: this.splitMode,
      activePaneId: this.activePaneId,
      linkCamera: this.linkCamera,
      linkDataset: this.linkDataset,
      linkColorScale: this.linkColorScale,
      footprint: this.showFootprint,
      showFootprint: this.showFootprint,
      footprintColor: this.footprintColor,
      overview: this.overviewMode,
      overviewMode: this.overviewMode,
      export: {
        mode: this.state.exportMode,
        scale: this.state.exportScale,
        width: this.state.exportWidth,
        height: this.state.exportHeight,
        embedMetadata: this.state.exportEmbedMetadata,
        transparent: this.state.exportTransparent
      },
      ...activeState,
      panes
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

  async applyViewJson() {
    let parsed;
    try {
      parsed = JSON.parse(this.controls.viewJsonInput.value);
    } catch {
      this.setViewStatus("Invalid view JSON.");
      return;
    }
    this.viewInputsDirty = false;
    try {
      await this.setViewState(parsed);
      this.updateViewPanel(true);
      this.writeUrlState();
      this.setViewStatus("Applied view JSON.");
    } catch (error) {
      this.setViewStatus(`Apply failed: ${errorMessage(error)}`);
    }
  }

  async loadViewStateFile() {
    const file = this.controls.viewStateFileInput.files?.[0];
    if (!file) {
      return;
    }
    this.setViewStatus(`Loading ${file.name}...`);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await this.setViewState(parsed);
      this.controls.viewJsonInput.value = JSON.stringify(parsed, null, 2);
      this.viewInputsDirty = false;
      this.updateViewPanel(true);
      this.writeUrlState();
      this.setViewStatus(`Loaded ${file.name}.`);
    } catch (error) {
      this.setViewStatus(`Load failed: ${errorMessage(error)}`);
    }
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
    const leftPane = this.splitMode === "single" ? this.activePane() : this.paneById("left") ?? this.activePane();
    const rightPane = this.paneById("right");
    const leftState = this.paneViewState(leftPane);
    const args = [
      pythonLiteral(leftState.datasetId),
      `layer=${pythonLiteral(leftState.layerId)}`,
      `view=${pythonLiteral(leftState.view)}`,
      `order=${leftState.order}`,
      `cmap=${pythonLiteral(leftState.colormap)}`,
      `scale=${pythonLiteral(leftState.scale)}`,
      `min=${formatPythonNumber(leftState.min)}`,
      `max=${formatPythonNumber(leftState.max)}`,
      `relief=${pythonLiteral(leftState.relief)}`,
      `grid=${pythonLiteral(leftState.grid)}`
    ];
    const extra = [
      `axes=${pythonLiteral(leftState.axes)}`,
      `north=${pythonLiteral(leftState.northUp)}`,
      `graticule=${pythonLiteral(leftState.graticule)}`,
      `scalebar=${pythonLiteral(leftState.scaleBar)}`,
      `panel=${pythonLiteral(leftState.viewPanel)}`
    ];
    if (leftPane.state.view === "globe" && leftPane.globe) {
      extra.push(`camera=${pythonLiteral(leftPane.globe.cameraUrlValue())}`);
    }
    if (this.splitMode !== "single" && rightPane) {
      extra.unshift(
        `split=${pythonLiteral(this.splitMode)}`,
        `pane=${pythonLiteral(this.activePaneId)}`,
        `linkCamera=${pythonLiteral(this.linkCamera)}`,
        `linkDataset=${pythonLiteral(this.linkDataset)}`,
        `linkColorScale=${pythonLiteral(this.linkColorScale)}`,
        `footprint=${pythonLiteral(this.showFootprint)}`,
        `footprintColor=${pythonLiteral(this.footprintColor)}`,
        `overview=${pythonLiteral(this.overviewMode)}`
      );
      const rightState = this.paneViewState(rightPane);
      extra.push(
        `rightDataset=${pythonLiteral(rightState.datasetId)}`,
        `rightLayer=${pythonLiteral(rightState.layerId)}`,
        `rightView=${pythonLiteral(rightState.view)}`,
        `rightOrder=${rightState.order}`,
        `rightCmap=${pythonLiteral(rightState.colormap)}`,
        `rightScale=${pythonLiteral(rightState.scale)}`,
        `rightMin=${formatPythonNumber(rightState.min)}`,
        `rightMax=${formatPythonNumber(rightState.max)}`
      );
      if (rightPane.state.view === "globe" && rightPane.globe) {
        extra.push(`rightCamera=${pythonLiteral(rightPane.globe.cameraUrlValue())}`);
      }
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
    const splitOption = this.controls.exportDialogModeSelect.querySelector('option[value="split"]');
    const leftOption = this.controls.exportDialogModeSelect.querySelector('option[value="left"]');
    const rightOption = this.controls.exportDialogModeSelect.querySelector('option[value="right"]');
    if (splitOption) {
      splitOption.disabled = this.splitMode === "single";
    }
    if (leftOption) {
      leftOption.disabled = this.splitMode === "single";
    }
    if (rightOption) {
      rightOption.disabled = this.splitMode === "single";
    }
    const defaultMode = this.splitMode === "single" ? "active" : "split";
    this.controls.exportFormatSelect.value = extension === "jpg" ? "jpg" : "png";
    this.controls.exportDialogModeSelect.value = defaultMode;
    this.controls.exportDialogScaleSelect.value = String(this.state.exportScale);
    this.controls.exportDialogWidthInput.value = this.state.exportWidth;
    this.controls.exportDialogHeightInput.value = this.state.exportHeight;
    this.controls.exportDialogTransparentToggle.checked = extension === "png" && this.state.exportTransparent;
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
    const format = this.controls.exportFormatSelect.value;
    const width = Number(this.controls.exportDialogWidthInput.value);
    const height = Number(this.controls.exportDialogHeightInput.value);
    const transparent = this.controls.exportDialogTransparentToggle.checked;
    const embedMetadata = this.controls.exportDialogMetadataToggle.checked;
    this.drawVisiblePanes();
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
      this.state.exportMode = normalizeExportMode(this.controls.exportDialogModeSelect.value);
      this.state.exportScale = Number(this.controls.exportDialogScaleSelect.value);
      this.state.exportWidth = this.controls.exportDialogWidthInput.value;
      this.state.exportHeight = this.controls.exportDialogHeightInput.value;
      this.state.exportTransparent = transparent;
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
    this.drawVisiblePanes();
    const { blob, extension, width, height } = await renderExportBlob(this, {
      mode: options.mode ?? normalizeExportMode(this.state.exportMode),
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

  drawVisiblePanes() {
    for (const pane of this.visiblePanes()) {
      const renderer = pane.state.view === "globe" ? pane.globe : pane.net;
      renderer?.draw?.();
    }
    this.syncActivePaneAliases(this.activePane());
  }

  updateScaleBar() {
    this.updatePaneScaleBars();
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

  updatePaneScaleBars() {
    for (const pane of this.visiblePanes()) {
      if (!pane.scaleBarLine || !pane.scaleBarValue || !pane.state.scaleBar || pane.state.view !== "globe" || !pane.globe) {
        continue;
      }
      const scale = pane.globe.surfaceScalePerPixel(120);
      if (!Number.isFinite(scale.valuePerPixel) || scale.valuePerPixel <= 0) {
        pane.scaleBarValue.textContent = "-";
        continue;
      }
      const maxPixels = 150;
      const distance = niceDistance(scale.valuePerPixel * maxPixels);
      const width = Math.max(36, Math.min(maxPixels, distance / scale.valuePerPixel));
      pane.scaleBarLine.style.width = `${width.toFixed(1)}px`;
      pane.scaleBarValue.textContent = formatScaleDistance(distance, scale.unit);
    }
  }

  updateActiveOrder(pane, renderer) {
    const minOrder = pane.manifest.minOrder ?? pane.manifest.tileShift;
    const requestedMaxOrder = pane.state.maxOrder;
    const lodDecision = renderer.lodDiagnostics
      ? renderer.lodDiagnostics(requestedMaxOrder)
      : { selectedOrder: requestedMaxOrder };
    const nextOrder = Number(lodDecision.selectedOrder);
    pane.state.order = clampOrder(nextOrder, minOrder, requestedMaxOrder);
    pane.lodDecision = {
      ...roundDiagnosticNumbers(lodDecision),
      minOrder,
      requestedMaxOrder,
      selectedOrder: pane.state.order
    };
  }

  tileDiagnostics() {
    return {
      schema: "healpix-tilemap.tile-diagnostics.v1",
      generatedAt: new Date().toISOString(),
      debug: this.debugMode,
      splitMode: this.splitMode,
      activePaneId: this.activePaneId,
      panes: this.visiblePanes().map((pane) => ({
        id: pane.id,
        datasetId: pane.datasetId,
        layerId: pane.state.layerId,
        view: pane.state.view,
        order: pane.state.order,
        maxOrder: pane.state.maxOrder,
        lod: pane.lodDecision ?? null,
        render: pane.renderStats ? { ...pane.renderStats } : null,
        scheduler: pane.scheduler.diagnosticsSnapshot?.() ?? null,
        cache: pane.cache.diagnosticsSnapshot?.() ?? pane.cache.stats?.() ?? null
      }))
    };
  }

  updateDebugDiagnostics(force = false) {
    if (!this.debugPanel) {
      return;
    }
    const now = performance.now();
    if (!force && now - this.lastDebugPanelUpdate < 500) {
      return;
    }
    this.lastDebugPanelUpdate = now;
    const diagnostics = this.tileDiagnostics();
    this.debugPanel.body.textContent = formatTileDiagnostics(diagnostics);
  }

  updateInspector(sample, pane = this.activePane()) {
    const targets = [this.controls];
    if (pane?.inspector) {
      targets.push(pane.inspector);
    }
    this.renderInspector(sample, targets);
  }

  renderInspector(sample, targets) {
    if (sample?.selectionType === "tiles") {
      const coverage = sample.coverage;
      for (const target of targets) {
        target.cellValue.textContent = "tiles";
        target.faceValue.textContent = coverage?.faces?.join(", ") ?? "-";
        target.localValue.textContent = coverage?.order === null ? "multi-order" : `order ${coverage?.order}`;
        target.lonLatValue.textContent = "-";
        target.sampleValue.textContent = `${coverage?.tileCount ?? 0} tiles`;
        target.tileValue.textContent = `${coverage?.rangeCount ?? 0} ranges`;
      }
      return;
    }
    if (!sample) {
      for (const target of targets) {
        target.cellValue.textContent = "-";
        target.faceValue.textContent = "-";
        target.localValue.textContent = "-";
        target.lonLatValue.textContent = "-";
        target.sampleValue.textContent = "-";
        target.tileValue.textContent = "-";
      }
      return;
    }
    const lonLat = sample.lonLat ?? cellToLonLat(sample.cell);
    for (const target of targets) {
      target.cellValue.textContent = String(sample.nestedId);
      target.faceValue.textContent = String(sample.cell.face);
      target.localValue.textContent = `${sample.cell.ix}, ${sample.cell.iy}`;
      target.lonLatValue.textContent = `${lonLat.lon.toFixed(3)}, ${lonLat.lat.toFixed(3)}`;
      target.sampleValue.textContent = Number.isFinite(sample.value) ? sample.value.toFixed(6) : "loading";
      target.tileValue.textContent = sample.tileKey;
    }
  }

  updateSelection(sample) {
    if (!sample) {
      return;
    }
    this.updateInspector(sample);
    this.selectedSample = serializeSelection(sample, this);
    const pane = this.activePane();
    if (pane) {
      pane.selectedSample = this.selectedSample;
    }
    broadcastSelection(this.selectedSample);
    persistSelection(this.selectedSample);
  }

  selectionSnapshot() {
    return this.selectedSample ? { ...this.selectedSample } : null;
  }
}

function defaultViewerState() {
  return {
    view: "net",
    layerId: "",
    order: null,
    maxOrder: null,
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
    exportMode: "active",
    exportScale: 1,
    exportWidth: "",
    exportHeight: "",
    exportTransparent: false,
    viewPanel: true
  };
}

function stateForManifest(manifest, overrides = {}) {
  const state = { ...defaultViewerState(), ...overrides };
  const defaultLayer = manifest.defaultView?.layer ?? manifest.layers[0]?.id ?? "";
  if (!manifest.layers.some((layer) => layer.id === state.layerId)) {
    state.layerId = manifest.layers.some((layer) => layer.id === defaultLayer)
      ? defaultLayer
      : manifest.layers[0]?.id ?? "";
  }
  state.view = state.view === "globe" || state.view === "net"
    ? state.view
    : manifest.defaultView?.mode ?? "net";
  state.scale = state.scale === "linear" || state.scale === "log" || state.scale === "symlog"
    ? state.scale
    : manifest.defaultView?.scale ?? "linear";
  state.colormap = String(state.colormap || manifest.defaultView?.colormap || "viridis");
  const minOrder = manifest.minOrder ?? manifest.tileShift;
  const defaultOrder = manifest.defaultView?.order ?? manifest.maxOrder;
  state.maxOrder = clampOrder(Number(state.maxOrder ?? defaultOrder), minOrder, manifest.maxOrder);
  state.order = clampOrder(Number(state.order ?? state.maxOrder), minOrder, state.maxOrder);
  if (!Number.isFinite(Number(state.min)) || !Number.isFinite(Number(state.max)) || Number(state.max) <= Number(state.min)) {
    applyLayerRange(state, manifest);
  }
  return state;
}

function applyLayerRange(state, manifest) {
  const layer = manifest.layers.find((item) => item.id === state.layerId);
  const percentiles = layer?.stats?.percentiles;
  state.min = Number(percentiles?.["1"] ?? layer?.stats?.min ?? -1);
  state.max = Number(percentiles?.["99"] ?? layer?.stats?.max ?? 1);
}

function createPaneCanvas(className, label) {
  const canvas = document.createElement("canvas");
  canvas.className = className;
  canvas.setAttribute("aria-label", label);
  return canvas;
}

function createPaneInspector(id) {
  const element = document.createElement("section");
  element.className = "pane-inspector";
  element.setAttribute("aria-label", `${id} cell inspector`);
  element.innerHTML = `
    <div class="pane-inspector-head">
      <span>Inspector</span>
    </div>
    <dl>
      <div><dt>Cell</dt><dd data-field="cell">-</dd></div>
      <div><dt>Face</dt><dd data-field="face">-</dd></div>
      <div><dt>Local</dt><dd data-field="local">-</dd></div>
      <div><dt>Lon/Lat</dt><dd data-field="lonLat">-</dd></div>
      <div><dt>Value</dt><dd data-field="sample">-</dd></div>
      <div><dt>Tile</dt><dd data-field="tile">-</dd></div>
    </dl>
  `;
  return {
    element,
    cellValue: element.querySelector('[data-field="cell"]'),
    faceValue: element.querySelector('[data-field="face"]'),
    localValue: element.querySelector('[data-field="local"]'),
    lonLatValue: element.querySelector('[data-field="lonLat"]'),
    sampleValue: element.querySelector('[data-field="sample"]'),
    tileValue: element.querySelector('[data-field="tile"]')
  };
}

function normalizeSplitMode(value) {
  if (value === "vertical" || value === "horizontal") {
    return value;
  }
  return "single";
}

function paneOptionsForSplit(splitMode) {
  if (splitMode === "horizontal") {
    return [
      new Option("Top", "left"),
      new Option("Bottom", "right")
    ];
  }
  return [
    new Option("Left", "left"),
    new Option("Right", "right")
  ];
}

function paneTitle(id, splitMode, overviewMode) {
  if (overviewMode) {
    return id === "left" ? "Overview" : "Detail";
  }
  if (splitMode === "horizontal") {
    return id === "left" ? "Top" : "Bottom";
  }
  return id === "left" ? "Left" : "Right";
}

function panePatchEntries(panes) {
  if (!panes) {
    return [];
  }
  if (Array.isArray(panes)) {
    return panes
      .map((pane) => [pane?.paneId ?? pane?.id, pane])
      .filter(([id, pane]) => (id === "left" || id === "right") && pane && typeof pane === "object");
  }
  if (typeof panes === "object") {
    return Object.entries(panes)
      .filter(([id, pane]) => (id === "left" || id === "right") && pane && typeof pane === "object");
  }
  return [];
}

function parseBooleanParam(value, fallback = false) {
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return fallback;
}

function normalizeColor(value, fallback = "#000000") {
  const color = String(value ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : fallback;
}

function normalizeExportMode(value) {
  return ["active", "left", "right", "split"].includes(value) ? value : "active";
}

function exportDimensionString(value) {
  if (value === "" || value === null || value === undefined) {
    return "";
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 64 ? String(Math.round(number)) : "";
}

function rightDatasetIdFromUrl(catalog, fallback) {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("rightDataset");
  return requested && catalog.datasets.some((dataset) => dataset.id === requested)
    ? requested
    : fallback;
}

function applyPrefixedUrlState(state, manifest, prefix) {
  const params = new URLSearchParams(window.location.search);
  const get = (name) => params.get(`${prefix}${name}`);
  const layer = get("Layer");
  if (layer && manifest.layers.some((item) => item.id === layer)) {
    state.layerId = layer;
  }
  const view = get("View");
  if (view === "globe" || view === "net") {
    state.view = view;
  }
  const orderText = get("Order");
  const order = Number(orderText);
  if (orderText !== null && Number.isInteger(order)) {
    const minOrder = manifest.minOrder ?? manifest.tileShift;
    state.maxOrder = clampOrder(order, minOrder, manifest.maxOrder);
    state.order = state.maxOrder;
  }
  const colormap = get("Cmap");
  if (colormap) {
    state.colormap = colormap;
  }
  const scale = get("Scale");
  if (scale === "linear" || scale === "log" || scale === "symlog") {
    state.scale = scale;
  }
  const minText = get("Min");
  const maxText = get("Max");
  if (minText !== null || maxText !== null) {
    const min = Number(minText);
    const max = Number(maxText);
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      state.min = min;
      state.max = max;
    } else {
      applyLayerRange(state, manifest);
    }
  }
}

function serializeSelection(sample, app) {
  const base = {
    type: "hpxviewer:selected",
    selectedAt: new Date().toISOString(),
    paneId: app.activePaneId,
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
  const field = control.closest(".check-field, .toolbar-check");
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

function createDebugPanel() {
  const element = document.createElement("section");
  element.className = "debug-panel";
  element.setAttribute("aria-label", "tile and LOD diagnostics");
  element.innerHTML = `
    <div class="debug-panel-head">
      <strong>Tile/LOD Debug</strong>
      <span>?debug=1</span>
    </div>
    <pre></pre>
  `;
  return {
    element,
    body: element.querySelector("pre")
  };
}

function formatTileDiagnostics(diagnostics) {
  const lines = [];
  for (const pane of diagnostics.panes) {
    const render = pane.render ?? {};
    const scheduler = pane.scheduler ?? {};
    const cache = pane.cache ?? {};
    const lod = pane.lod ?? {};
    const fallback = render.fallback ?? render.approximate ?? 0;
    const lastLoad = [...(cache.recent ?? [])].reverse().find((event) => event.event === "load");
    lines.push(`${pane.id} ${pane.datasetId} ${pane.view}`);
    lines.push(`  LOD ${pane.order}/${pane.maxOrder} selected=${lod.selectedOrder ?? "-"} reason=${lod.reason ?? lod.view ?? "-"}`);
    lines.push(`  render visible=${render.visible ?? 0} exact=${render.exact ?? 0} fallback=${fallback} missing=${render.missing ?? 0}`);
    lines.push(`  target ${scheduler.targetTiles ?? 0} [${formatOrderCounts(scheduler.targetOrders ?? {})}]`);
    lines.push(`  requested ${scheduler.wantedTiles ?? 0} [${formatOrderCounts(scheduler.wantedOrders ?? {})}] cache=${scheduler.cacheHits ?? 0} pending=${scheduler.pending ?? 0} queued=${scheduler.queued ?? 0}`);
    lines.push(`  cache loaded=${cache.loaded ?? 0} pending=${cache.pending ?? 0} active=${cache.active ?? 0} hits=${cache.cacheHits ?? 0} bytes=${formatBytes(cache.bytes ?? 0)}`);
    if (lastLoad) {
      lines.push(`  last load ${lastLoad.tile ?? lastLoad.key ?? "-"} ${lastLoad.loadTimeMs ?? "-"}ms total=${lastLoad.totalTimeMs ?? "-"}ms`);
    }
  }
  return lines.join("\n");
}

function roundDiagnosticNumbers(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => roundDiagnosticNumbers(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundDiagnosticNumbers(item)]));
  }
  return value;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)}MiB`;
  }
  return `${Math.max(1, Math.round(value / 1024))}KiB`;
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
