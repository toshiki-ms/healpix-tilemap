import { cellToNestedId } from "../core/healpix-nested.js";
import { faceUvToVector, lonLatToVector, vectorToLonLat } from "../core/projection.js";
import { cellFromFaceUv, tileFromCell, tileKey } from "../core/tile-address.js";
import { sampleTileValue } from "../render/tile-visual.js";

const REMOTE_PARAM_NAMES = new Set(["remote", "debug"]);

export function installRemoteControl(app) {
  const params = new URLSearchParams(window.location.search);
  if (![...REMOTE_PARAM_NAMES].some((name) => params.has(name))) {
    return;
  }
  window.__hpxRemote = createRemoteControl(app);
  window.dispatchEvent(new CustomEvent("hpxremote-ready"));
}

function createRemoteControl(app) {
  return {
    version: 1,
    get_state: () => snapshot(app),
    get_selection: () => app.selectionSnapshot(),
    set_view_state: (patch = {}) => app.setViewState(patch),
    goto_lonlat: (options = {}) => gotoLonLat(app, options),
    inspect_screen: (options = {}) => inspectScreen(app, options),
    inspect_lonlat: (options = {}) => inspectLonLat(app, options),
    wait_for_idle: (options = {}) => waitForIdle(app, options)
  };
}

function snapshot(app) {
  return {
    ...app.stateSnapshot(),
    datasetCatalog: app.datasetCatalog,
    manifest: manifestSummary(app.manifest),
    renderer: app.state.view,
    remoteVersion: 1
  };
}

function manifestSummary(manifest) {
  return {
    schema: manifest.schema,
    name: manifest.name,
    description: manifest.description ?? "",
    nside: manifest.nside,
    minOrder: manifest.minOrder,
    maxOrder: manifest.maxOrder,
    tileShift: manifest.tileShift,
    tileSize: manifest.tileSize,
    layers: manifest.layers.map((layer) => ({
      id: layer.id,
      title: layer.title ?? layer.id,
      kind: layer.kind,
      dtype: layer.dtype,
      unit: layer.unit ?? "",
      stats: layer.stats ?? null,
      quantization: layer.quantization ?? null
    }))
  };
}

function gotoLonLat(app, options) {
  const lon = Number(options.lon);
  const lat = Number(options.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new TypeError("goto_lonlat requires finite lon and lat.");
  }
  app.setViewState({
    view: "globe",
    order: options.order ?? options.maxOrder ?? app.state.maxOrder
  });
  app.globe.focusLonLat(lon, lat, options.distance);
  return snapshot(app);
}

function inspectScreen(app, options) {
  const canvas = app.state.view === "globe" ? app.globe.canvas : app.net.canvas;
  const rect = canvas.getBoundingClientRect();
  const x = Number.isFinite(Number(options.x)) ? Number(options.x) : rect.left + rect.width * 0.5;
  const y = Number.isFinite(Number(options.y)) ? Number(options.y) : rect.top + rect.height * 0.5;
  const sample = activeRenderer(app).inspectAt(x, y);
  return sample ? serializeSample(sample) : null;
}

async function inspectLonLat(app, options) {
  const lon = Number(options.lon);
  const lat = Number(options.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new TypeError("inspect_lonlat requires finite lon and lat.");
  }
  const faceUv = faceUvForLonLat(lon, lat);
  const order = clampOrder(Number(options.order ?? app.state.maxOrder), app.manifest);
  const layerId = String(options.layerId ?? options.layer ?? app.state.layerId);
  const cell = cellFromFaceUv(order, faceUv.face, faceUv.u, faceUv.v);
  const targetTile = tileFromCell(cell, app.manifest.tileShift);
  let resolved = app.scheduler.resolve(layerId, targetTile);
  if (!resolved && options.load !== false && app.source) {
    const data = await app.source.loadTile(layerId, targetTile).catch(() => null);
    if (data) {
      app.cache?.insert?.(app.cache.cacheKey(layerId, targetTile), data);
      resolved = { data, sourceTile: targetTile, exact: true };
    }
  }
  const sourceOrder = resolved?.sourceTile.order ?? order;
  const sourceNside = 2 ** sourceOrder;
  const sourceCell = {
    order: sourceOrder,
    face: faceUv.face,
    ix: Math.min(sourceNside - 1, Math.max(0, Math.floor(faceUv.u * sourceNside))),
    iy: Math.min(sourceNside - 1, Math.max(0, Math.floor(faceUv.v * sourceNside)))
  };
  const value = resolved ? sampleTileValue(resolved.data, app.manifest, sourceCell) : Number.NaN;
  return serializeSample({
    cell,
    nestedId: cellToNestedId(cell),
    lonLat: vectorToLonLat(faceUvToVector(faceUv.face, faceUv.u, faceUv.v)),
    requestedLonLat: { lon, lat },
    value,
    exact: resolved?.exact ?? false,
    tile: resolved?.sourceTile ?? targetTile,
    targetTile,
    tileKey: tileKey(resolved?.sourceTile ?? targetTile)
  });
}

async function waitForIdle(app, options) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 10_000));
  const started = performance.now();
  while (performance.now() - started <= timeoutMs) {
    const stats = app.cache?.stats?.();
    if (!stats || stats.pending === 0) {
      return snapshot(app);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return snapshot(app);
}

function serializeSample(sample) {
  return {
    cell: sample.cell,
    nestedId: sample.nestedId,
    lonLat: sample.lonLat,
    requestedLonLat: sample.requestedLonLat,
    value: Number.isFinite(sample.value) ? sample.value : null,
    exact: Boolean(sample.exact),
    tile: sample.tile,
    targetTile: sample.targetTile,
    tileKey: sample.tileKey
  };
}

function activeRenderer(app) {
  return app.state.view === "globe" ? app.globe : app.net;
}

function clampOrder(order, manifest) {
  const minOrder = manifest.minOrder ?? manifest.tileShift;
  if (!Number.isInteger(order)) {
    return manifest.maxOrder;
  }
  return Math.max(minOrder, Math.min(manifest.maxOrder, order));
}

function faceUvForLonLat(lon, lat) {
  const target = lonLatToVector(lon, lat);
  let best = { face: 0, u: 0.5, v: 0.5, score: -Infinity };
  const coarse = 10;
  for (let face = 0; face < 12; face += 1) {
    for (let iy = 0; iy <= coarse; iy += 1) {
      for (let ix = 0; ix <= coarse; ix += 1) {
        best = chooseBetter(best, target, face, ix / coarse, iy / coarse);
      }
    }
  }
  let step = 1 / coarse;
  for (let iteration = 0; iteration < 14; iteration += 1) {
    const base = best;
    step *= 0.5;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        best = chooseBetter(
          best,
          target,
          base.face,
          Math.min(1, Math.max(0, base.u + dx * step)),
          Math.min(1, Math.max(0, base.v + dy * step))
        );
      }
    }
  }
  return { face: best.face, u: best.u, v: best.v };
}

function chooseBetter(best, target, face, u, v) {
  const vector = faceUvToVector(face, u, v);
  const score = target[0] * vector[0] + target[1] * vector[1] + target[2] * vector[2];
  return score > best.score ? { face, u, v, score } : best;
}
