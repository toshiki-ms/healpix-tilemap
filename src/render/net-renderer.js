import { cellToNestedId } from "../core/healpix-nested.js";
import { faceUvToNet, netToFaceUv, vectorToLonLat, faceUvToVector } from "../core/projection.js";
import {
  cellFromFaceUv,
  enumerateTiles,
  sourceCropForTarget,
  tileBounds,
  tileFromCell,
  tileKey
} from "../core/tile-address.js";
import { detailOrderForBasePixels, LOD_TARGET_TILE_PIXELS } from "./lod.js";
import {
  addTileToSelection,
  addTilesAlongLine,
  createTileSelection,
  isTileSelectionPointer
} from "./region-selection.js";
import { sampleTileValue, tileCanvas } from "./tile-visual.js";

const NET_BOUNDS = Object.freeze({ minX: -1.1, maxX: 8.1, minY: -0.08, maxY: 4.08 });

export class NetRenderer {
  constructor({ canvas, manifest, scheduler, state, onHover, onSelect = () => {} }) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.manifest = manifest;
    this.scheduler = scheduler;
    this.state = state;
    this.onHover = onHover;
    this.onSelect = onSelect;
    this.pixelRatio = 1;
    this.transform = { scale: 1, offsetX: 0, offsetY: 0 };
    this.drag = null;
    this.tileSelection = null;
    this.selectedTiles = new Map();
    this.visibleTiles = [];
    this.renderStats = emptyRenderStats();

    canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    canvas.addEventListener("pointercancel", () => this.onPointerUp());
    canvas.addEventListener("pointerleave", () => this.onPointerLeave());
    canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    canvas.addEventListener("click", (event) => this.onClick(event));
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * this.pixelRatio));
    const height = Math.max(1, Math.round(rect.height * this.pixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.resetView();
    }
  }

  resetView() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const logicalWidth = NET_BOUNDS.maxX - NET_BOUNDS.minX;
    const logicalHeight = NET_BOUNDS.maxY - NET_BOUNDS.minY;
    const scale = Math.min(w / logicalWidth, h / logicalHeight) * 0.94;
    this.transform.scale = scale;
    this.transform.offsetX = (w - logicalWidth * scale) * 0.5;
    this.transform.offsetY = (h - logicalHeight * scale) * 0.5;
  }

  desiredTiles() {
    this.resize();
    const tiles = enumerateTiles(this.state.order, this.manifest.tileShift);
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width * 0.5;
    const cy = rect.height * 0.5;
    this.visibleTiles = tiles
      .map((tile) => {
        const box = this.tileScreenBox(tile);
        const visible = box.maxX >= 0 && box.minX <= rect.width && box.maxY >= 0 && box.minY <= rect.height;
        const centerX = (box.minX + box.maxX) * 0.5;
        const centerY = (box.minY + box.maxY) * 0.5;
        const priority = Math.hypot(centerX - cx, centerY - cy);
        return { tile, visible, priority };
      })
      .filter((entry) => entry.visible)
      .sort((a, b) => a.priority - b.priority)
      .map((entry) => entry.tile);
    return this.visibleTiles;
  }

  detailOrder(maxOrder = this.manifest.maxOrder) {
    this.resize();
    return detailOrderForBasePixels(this.transform.scale * Math.SQRT2, this.manifest, maxOrder);
  }

  draw() {
    this.resize();
    const ctx = this.context;
    const rect = this.canvas.getBoundingClientRect();
    this.renderStats = emptyRenderStats(this.visibleTiles.length);
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.fillStyle = "#202326";
    ctx.fillRect(0, 0, rect.width, rect.height);

    for (const targetTile of this.visibleTiles) {
      const resolved = this.scheduler.resolve(this.state.layerId, targetTile);
      updateRenderStats(this.renderStats, resolved, targetTile);
      if (!resolved) {
        this.drawTilePlaceholder(targetTile);
        continue;
      }
      this.drawTileImage(targetTile, resolved);
    }

    if (this.state.grid) {
      this.drawFaceBoundaries();
    }
    this.drawSelectedTiles();
  }

  stats() {
    return this.renderStats;
  }

  drawTilePlaceholder(tile) {
    const ctx = this.context;
    const bounds = tileBounds(tile, this.manifest.tileShift);
    const points = this.tilePoints(tile.face, bounds);
    ctx.save();
    this.path(points);
    ctx.fillStyle = "rgba(255,255,255,0.025)";
    ctx.fill();
    ctx.restore();
  }

  drawTileImage(targetTile, resolved) {
    const ctx = this.context;
    const image = tileCanvas(resolved.data, this.manifest, this.state);
    const bounds = tileBounds(targetTile, this.manifest.tileShift);
    const crop = sourceCropForTarget(resolved.sourceTile, targetTile, this.manifest.tileShift);
    const points = this.tilePoints(targetTile.face, bounds);
    const p00 = points[0];
    const p10 = points[1];
    const p01 = points[3];
    const sx = crop.sx * image.width;
    const sy = crop.sy * image.height;
    const sw = crop.sw * image.width;
    const sh = crop.sh * image.height;
    const bleed = this.state.grid ? 0 : tileBleed(p00, p10, p01);

    ctx.save();
    if (this.state.grid) {
      this.path(points);
      ctx.clip();
    }
    ctx.transform(p10.x - p00.x, p10.y - p00.y, p01.x - p00.x, p01.y - p00.y, p00.x, p00.y);
    ctx.drawImage(image, sx, sy, sw, sh, -bleed, -bleed, 1 + 2 * bleed, 1 + 2 * bleed);
    ctx.restore();
  }

  drawFaceBoundaries() {
    const ctx = this.context;
    ctx.save();
    ctx.strokeStyle = "rgba(246, 241, 231, 0.34)";
    ctx.lineWidth = 1.15;
    for (let face = 0; face < 12; face += 1) {
      const points = this.tilePoints(face, { u0: 0, v0: 0, u1: 1, v1: 1 });
      this.path(points);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawSelectedTiles() {
    if (!this.selectedTiles.size) {
      return;
    }
    const ctx = this.context;
    ctx.save();
    ctx.fillStyle = "rgba(120, 214, 234, 0.2)";
    ctx.strokeStyle = "rgba(120, 214, 234, 0.95)";
    ctx.lineWidth = 1.4;
    for (const tile of this.selectedTiles.values()) {
      const points = this.tilePoints(tile.face, tileBounds(tile, this.manifest.tileShift));
      this.path(points);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  tilePoints(face, bounds) {
    return [
      this.netToScreen(faceUvToNet(face, bounds.u0, bounds.v0)),
      this.netToScreen(faceUvToNet(face, bounds.u1, bounds.v0)),
      this.netToScreen(faceUvToNet(face, bounds.u1, bounds.v1)),
      this.netToScreen(faceUvToNet(face, bounds.u0, bounds.v1))
    ];
  }

  tileScreenBox(tile) {
    const points = this.tilePoints(tile.face, tileBounds(tile, this.manifest.tileShift));
    return {
      minX: Math.min(...points.map((p) => p.x)),
      maxX: Math.max(...points.map((p) => p.x)),
      minY: Math.min(...points.map((p) => p.y)),
      maxY: Math.max(...points.map((p) => p.y))
    };
  }

  path(points) {
    const ctx = this.context;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
  }

  netToScreen(point) {
    return {
      x: (point.x - NET_BOUNDS.minX) * this.transform.scale + this.transform.offsetX,
      y: (point.y - NET_BOUNDS.minY) * this.transform.scale + this.transform.offsetY
    };
  }

  screenToNet(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.transform.offsetX) / this.transform.scale + NET_BOUNDS.minX,
      y: (clientY - rect.top - this.transform.offsetY) / this.transform.scale + NET_BOUNDS.minY
    };
  }

  inspectAt(clientX, clientY) {
    const net = this.screenToNet(clientX, clientY);
    const faceUv = netToFaceUv(net.x, net.y);
    if (!faceUv) {
      return null;
    }
    const cell = cellFromFaceUv(this.state.order, faceUv.face, faceUv.u, faceUv.v);
    const targetTile = tileFromCell(cell, this.manifest.tileShift);
    const resolved = this.scheduler.resolve(this.state.layerId, targetTile);
    const sourceNside = resolved ? 2 ** resolved.sourceTile.order : 1;
    const sourceCell = resolved
      ? {
          order: resolved.sourceTile.order,
          face: cell.face,
          ix: Math.min(sourceNside - 1, Math.max(0, Math.floor(faceUv.u * sourceNside))),
          iy: Math.min(sourceNside - 1, Math.max(0, Math.floor(faceUv.v * sourceNside)))
        }
      : null;
    const value = resolved && sourceCell ? sampleTileValue(resolved.data, this.manifest, sourceCell) : NaN;
    const lonLat = vectorToLonLat(faceUvToVector(faceUv.face, faceUv.u, faceUv.v));
    return {
      cell,
      nestedId: cellToNestedId(cell),
      lonLat,
      value,
      exact: resolved?.exact ?? false,
      tile: resolved?.sourceTile ?? targetTile,
      targetTile,
      tileKey: tileKey(resolved?.sourceTile ?? targetTile)
    };
  }

  onPointerDown(event) {
    if (isTileSelectionPointer(event)) {
      event.preventDefault();
      this.canvas.setPointerCapture(event.pointerId);
      this.selectedTiles.clear();
      this.tileSelection = {
        pointerId: event.pointerId,
        last: { x: event.clientX, y: event.clientY }
      };
      addTileToSelection(this.selectedTiles, this.tileAt(event.clientX, event.clientY));
      return;
    }
    if (event.button !== 0) {
      return;
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.drag = {
      x: event.clientX,
      y: event.clientY,
      offsetX: this.transform.offsetX,
      offsetY: this.transform.offsetY,
      moved: false
    };
  }

  onPointerMove(event) {
    if (this.tileSelection) {
      event.preventDefault();
      const current = { x: event.clientX, y: event.clientY };
      addTilesAlongLine({
        tiles: this.selectedTiles,
        start: this.tileSelection.last,
        end: current,
        tileAt: (clientX, clientY) => this.tileAt(clientX, clientY)
      });
      this.tileSelection.last = current;
      return;
    }
    if (this.drag) {
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      if (Math.hypot(dx, dy) > 4) {
        this.drag.moved = true;
      }
      this.transform.offsetX = this.drag.offsetX + event.clientX - this.drag.x;
      this.transform.offsetY = this.drag.offsetY + event.clientY - this.drag.y;
      return;
    }
    this.onHover(this.inspectAt(event.clientX, event.clientY));
  }

  onPointerUp(event) {
    if (this.tileSelection) {
      const last = this.tileSelection.last;
      const end = event ? { x: event.clientX, y: event.clientY } : last;
      this.tileSelection = null;
      if (event) {
        event.preventDefault();
      }
      addTilesAlongLine({
        tiles: this.selectedTiles,
        start: last,
        end,
        tileAt: (clientX, clientY) => this.tileAt(clientX, clientY)
      });
      this.onSelect(
        createTileSelection({
          tiles: this.selectedTiles.values(),
          tileShift: this.manifest.tileShift
        })
      );
      return;
    }
    if (!event) {
      this.drag = null;
      return;
    }
    if (this.drag && !this.drag.moved) {
      this.onSelect(this.inspectAt(event.clientX, event.clientY));
    }
    this.drag = null;
  }

  onClick(event) {
    if (event.button !== 0) {
      return;
    }
    this.selectedTiles.clear();
    this.onSelect(this.inspectAt(event.clientX, event.clientY));
  }

  onPointerLeave() {
    if (!this.drag) {
      this.onHover(null);
    }
  }

  onWheel(event) {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const before = this.screenToNet(event.clientX, event.clientY);
    const factor = Math.exp(-event.deltaY * 0.001);
    this.transform.scale = Math.max(55, Math.min(this.maxScale(), this.transform.scale * factor));
    const afterScreen = this.netToScreen(before);
    this.transform.offsetX += x - afterScreen.x;
    this.transform.offsetY += y - afterScreen.y;
  }

  maxScale() {
    const maxDelta = Math.max(0, this.manifest.maxOrder - this.manifest.tileShift);
    const maxFaceEdgePixels = LOD_TARGET_TILE_PIXELS * 2 ** maxDelta * 3;
    return Math.max(2200, maxFaceEdgePixels / Math.SQRT2);
  }

  tileAt(clientX, clientY) {
    return this.inspectAt(clientX, clientY)?.targetTile ?? null;
  }
}

function tileBleed(p00, p10, p01) {
  const edgeX = Math.hypot(p10.x - p00.x, p10.y - p00.y);
  const edgeY = Math.hypot(p01.x - p00.x, p01.y - p00.y);
  const screenSize = Math.max(1, Math.min(edgeX, edgeY));
  return Math.min(0.02, 1.25 / screenSize);
}

function emptyRenderStats(visible = 0) {
  return {
    visible,
    exact: 0,
    approximate: 0,
    missing: visible,
    maxSourceOrder: null
  };
}

function updateRenderStats(stats, resolved, targetTile) {
  if (!resolved) {
    return;
  }
  stats.missing -= 1;
  stats.maxSourceOrder = Math.max(stats.maxSourceOrder ?? -Infinity, resolved.sourceTile.order);
  if (resolved.sourceTile.order === targetTile.order) {
    stats.exact += 1;
  } else {
    stats.approximate += 1;
  }
}
