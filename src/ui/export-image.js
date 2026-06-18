import { sampleColormap } from "../render/colormap.js";

export async function exportImage(
  app,
  {
    mode = "map",
    format = "png",
    scale = 1,
    width = null,
    height = null,
    transparent = false,
    embedMetadata = true,
    filename = null
  } = {}
) {
  const { blob, extension } = await renderExportBlob(app, {
    mode,
    format,
    scale,
    width,
    height,
    transparent,
    embedMetadata
  });
  const safeFilename = sanitizeFilename(filename || exportFileName(app, extension), extension);
  const method = await saveBlob(blob, safeFilename, extension);
  return { filename: safeFilename, bytes: blob.size, method };
}

export async function renderExportBlob(
  app,
  { mode = "active", format = "png", scale = 1, width = null, height = null, transparent = false, embedMetadata = true } = {}
) {
  const target = exportTarget(app, mode);
  const splitExport = target.kind === "split";
  const pane = target.pane;
  const source = splitExport ? app.controls.paneGrid : paneCanvas(pane);
  const rect = source.getBoundingClientRect();
  const exportScale = Math.max(1, Math.min(4, Number(scale) || 1));
  const sourcePixelWidth = splitExport
    ? Math.max(1, Math.round(rect.width * Math.min(window.devicePixelRatio || 1, 2)))
    : source.width;
  const sourcePixelHeight = splitExport
    ? Math.max(1, Math.round(rect.height * Math.min(window.devicePixelRatio || 1, 2)))
    : source.height;
  const sourceAspect = sourcePixelWidth / Math.max(1, sourcePixelHeight);
  const requestedWidth = Number(width);
  const requestedHeight = Number(height);
  let outputWidth = Math.max(1, Math.round(sourcePixelWidth * exportScale));
  let outputHeight = Math.max(1, Math.round(sourcePixelHeight * exportScale));
  if (Number.isFinite(requestedWidth) && requestedWidth > 0 && Number.isFinite(requestedHeight) && requestedHeight > 0) {
    outputWidth = Math.round(requestedWidth);
    outputHeight = Math.round(requestedHeight);
  } else if (Number.isFinite(requestedWidth) && requestedWidth > 0) {
    outputWidth = Math.round(requestedWidth);
    outputHeight = Math.round(requestedWidth / sourceAspect);
  } else if (Number.isFinite(requestedHeight) && requestedHeight > 0) {
    outputHeight = Math.round(requestedHeight);
    outputWidth = Math.round(requestedHeight * sourceAspect);
  }
  const mime = format === "jpg" || format === "jpeg" ? "image/jpeg" : "image/png";
  const transparentPng = transparent && mime === "image/png";
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d");
  if (!transparentPng) {
    context.fillStyle = "#202326";
    context.fillRect(0, 0, outputWidth, outputHeight);
  }
  if (splitExport) {
    drawSplitPanes(context, app, outputWidth, outputHeight);
  } else {
    context.drawImage(source, 0, 0, outputWidth, outputHeight);
  }
  if (transparentPng) {
    makeBackgroundTransparent(context, outputWidth, outputHeight);
  }

  const pixelScale = outputWidth / Math.max(1, rect.width);
  if (!splitExport) {
    drawPaneColorbar(context, pane, outputWidth, outputHeight, pixelScale);
  }
  if (!splitExport && pane.state.scaleBar && pane.state.view === "globe") {
    drawPaneScaleBar(context, pane, outputWidth, outputHeight, pixelScale);
  }

  const extension = mime === "image/jpeg" ? "jpg" : "png";
  let blob = await canvasToBlob(canvas, mime, 0.92);
  if (embedMetadata) {
    blob = await embedImageMetadata(blob, extension, imageMetadata(app, {
      target: target.id,
      format: extension,
      scale: exportScale,
      width: outputWidth,
      height: outputHeight,
      transparent: transparentPng
    }));
  }
  return { blob, extension, width: outputWidth, height: outputHeight };
}

function exportTarget(app, requested = "active") {
  const visiblePanes = app.visiblePanes?.() ?? [];
  const active = app.activePane?.() ?? visiblePanes[0];
  if (requested === "split" && app.splitMode !== "single" && visiblePanes.length > 1) {
    return { kind: "split", id: "split", pane: active };
  }
  if (app.splitMode === "single") {
    return { kind: "pane", id: "active", pane: active };
  }
  if (requested === "left") {
    return { kind: "pane", id: "left", pane: app.paneById?.("left") ?? active };
  }
  if (requested === "right") {
    return { kind: "pane", id: "right", pane: app.paneById?.("right") ?? active };
  }
  return { kind: "pane", id: "active", pane: active };
}

function paneCanvas(pane) {
  return pane.state.view === "globe" ? pane.globe.canvas : pane.net.canvas;
}

function drawSplitPanes(context, app, width, height) {
  const gridRect = app.controls.paneGrid.getBoundingClientRect();
  const scaleX = width / Math.max(1, gridRect.width);
  const scaleY = height / Math.max(1, gridRect.height);
  const panes = app.visiblePanes?.() ?? [];
  context.save();
  context.fillStyle = "#202326";
  context.fillRect(0, 0, width, height);
  for (const pane of panes) {
    const paneRect = pane.element.getBoundingClientRect();
    const box = {
      x: (paneRect.left - gridRect.left) * scaleX,
      y: (paneRect.top - gridRect.top) * scaleY,
      width: paneRect.width * scaleX,
      height: paneRect.height * scaleY
    };
    const canvas = pane.state.view === "globe" ? pane.globe.canvas : pane.net.canvas;
    context.fillStyle = "#202326";
    context.fillRect(box.x, box.y, box.width, box.height);
    context.drawImage(canvas, box.x, box.y, box.width, box.height);
    drawSplitPaneLabel(context, pane, box, Math.min(scaleX, scaleY));
    drawSplitPaneColorbar(context, pane, box, Math.min(scaleX, scaleY));
    if (pane.state.scaleBar && pane.state.view === "globe") {
      drawSplitPaneScaleBar(context, pane, box, Math.min(scaleX, scaleY));
    }
  }
  drawSplitSeparators(context, app, width, height);
  context.restore();
}

function drawSplitPaneLabel(context, pane, box, scale) {
  const title = paneLabelText(pane);
  const x = box.x + 12 * scale;
  const y = box.y + 12 * scale;
  const paddingX = 9 * scale;
  const h = 28 * scale;
  context.save();
  context.font = `650 ${12 * scale}px Inter, system-ui, sans-serif`;
  const w = Math.min(box.width - 24 * scale, context.measureText(title).width + paddingX * 2);
  drawPanel(context, x, y, w, h, 6 * scale);
  context.fillStyle = "#f3f0e8";
  clippedText(context, title, x + paddingX, y + 18 * scale, w - paddingX * 2);
  context.restore();
}

function drawSplitPaneColorbar(context, pane, box, scale) {
  const w = Math.min(300 * scale, box.width - 28 * scale);
  if (w < 96 * scale) {
    return;
  }
  const h = 52 * scale;
  const x = box.x + box.width - w - 14 * scale;
  const y = box.y + box.height - h - 14 * scale;
  drawPanel(context, x, y, w, h, 7 * scale);
  const rampX = x + 10 * scale;
  const rampY = y + 10 * scale;
  const rampW = w - 20 * scale;
  const rampH = 12 * scale;
  const gradient = context.createLinearGradient(rampX, 0, rampX + rampW, 0);
  for (let i = 0; i <= 16; i += 1) {
    const [r, g, b] = sampleColormap(pane.state.colormap, i / 16);
    gradient.addColorStop(i / 16, `rgb(${r} ${g} ${b})`);
  }
  context.fillStyle = gradient;
  roundRect(context, rampX, rampY, rampW, rampH, 4 * scale);
  context.fill();
  context.fillStyle = "#c8c1b3";
  context.font = `${10 * scale}px SFMono-Regular, Consolas, monospace`;
  context.textAlign = "left";
  context.fillText(formatNumber(pane.state.min), rampX, y + 38 * scale);
  context.textAlign = "right";
  context.fillText(formatNumber(pane.state.max), rampX + rampW, y + 38 * scale);
  context.textAlign = "left";
}

function drawSplitPaneScaleBar(context, pane, box, scale) {
  const label = pane.scaleBarValue?.textContent || "";
  const cssWidth = parseFloat(pane.scaleBarLine?.style.width) || 96;
  const barWidth = cssWidth * scale;
  const x = box.x + (box.width - barWidth) * 0.5;
  const y = box.y + box.height - 36 * scale;
  context.save();
  context.strokeStyle = "#f6f1e7";
  context.lineWidth = Math.max(2, 2 * scale);
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x, y + 8 * scale);
  context.lineTo(x + barWidth, y + 8 * scale);
  context.lineTo(x + barWidth, y);
  context.stroke();
  context.fillStyle = "#f6f1e7";
  context.font = `650 ${11 * scale}px Inter, system-ui, sans-serif`;
  context.textAlign = "center";
  context.fillText(label, x + barWidth * 0.5, y + 24 * scale);
  context.restore();
}

function drawPaneColorbar(context, pane, width, height, scale) {
  drawSplitPaneColorbar(context, pane, { x: 0, y: 0, width, height }, scale);
}

function drawPaneScaleBar(context, pane, width, height, scale) {
  drawSplitPaneScaleBar(context, pane, { x: 0, y: 0, width, height }, scale);
}

function drawSplitSeparators(context, app, width, height) {
  if (app.splitMode === "vertical") {
    context.strokeStyle = "rgba(243, 240, 232, 0.3)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(width * 0.5, 0);
    context.lineTo(width * 0.5, height);
    context.stroke();
  } else if (app.splitMode === "horizontal") {
    context.strokeStyle = "rgba(243, 240, 232, 0.3)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height * 0.5);
    context.lineTo(width, height * 0.5);
    context.stroke();
  }
}

function paneLabelText(pane) {
  return pane.label?.textContent || (pane.id === "left" ? "Overview" : "Detail");
}

export async function exportMetadata(app) {
  const blob = new Blob([JSON.stringify(app.currentViewState(), null, 2) + "\n"], {
    type: "application/json"
  });
  const filename = exportFileName(app, "json");
  const method = await saveBlob(blob, filename, "json");
  return { filename, bytes: blob.size, method };
}

export function defaultExportFileName(app, format = "png") {
  const extension = format === "jpeg" ? "jpg" : String(format || "png").toLowerCase();
  return exportFileName(app, extension);
}

function drawToolbar(context, app, width, scale) {
  const x = 14 * scale;
  const y = 14 * scale;
  const h = 76 * scale;
  const w = Math.min(width - 28 * scale, 1160 * scale);
  drawPanel(context, x, y, w, h, 8 * scale);
  context.fillStyle = "#f3f0e8";
  context.font = `${15 * scale}px Inter, system-ui, sans-serif`;
  context.fillText("HEALPix Tile Map", x + 14 * scale, y + 27 * scale);
  context.fillStyle = "#b9b2a3";
  context.font = `${12 * scale}px Inter, system-ui, sans-serif`;
  const pieces = [
    app.datasetId,
    app.state.view,
    app.state.layerId,
    `order ${app.state.maxOrder}`,
    app.state.colormap,
    app.state.scale,
    `${formatNumber(app.state.min)} .. ${formatNumber(app.state.max)}`
  ];
  context.fillText(pieces.join(" / "), x + 14 * scale, y + 50 * scale);
}

function drawInspector(context, app, width, height, scale) {
  const x = 14 * scale;
  const y = height - 206 * scale;
  const w = Math.min(360 * scale, width - 28 * scale);
  const h = 192 * scale;
  drawPanel(context, x, y, w, h, 8 * scale);
  context.fillStyle = "#f3f0e8";
  context.font = `700 ${13 * scale}px Inter, system-ui, sans-serif`;
  context.fillText("Inspector", x + 12 * scale, y + 22 * scale);
  context.fillStyle = "#a9d4df";
  context.textAlign = "right";
  context.font = `650 ${12 * scale}px Inter, system-ui, sans-serif`;
  context.fillText(app.controls.loadStatus.textContent || "", x + w - 12 * scale, y + 22 * scale);
  context.textAlign = "left";

  const rows = [
    ["Cell", app.controls.cellValue.textContent],
    ["Face", app.controls.faceValue.textContent],
    ["Local", app.controls.localValue.textContent],
    ["Lon/Lat", app.controls.lonLatValue.textContent],
    ["Value", app.controls.sampleValue.textContent],
    ["Tile", app.controls.tileValue.textContent]
  ];
  const cellW = (w - 25 * scale) * 0.5;
  const cellH = 42 * scale;
  for (let i = 0; i < rows.length; i += 1) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = x + 8 * scale + col * (cellW + 1 * scale);
    const cy = y + 45 * scale + row * (cellH + 1 * scale);
    context.fillStyle = "rgba(255, 255, 255, 0.045)";
    roundRect(context, cx, cy, cellW, cellH, 6 * scale);
    context.fill();
    context.fillStyle = "#b9b2a3";
    context.font = `${10 * scale}px Inter, system-ui, sans-serif`;
    context.fillText(rows[i][0].toUpperCase(), cx + 8 * scale, cy + 14 * scale);
    context.fillStyle = "#f6f1e7";
    context.font = `${12 * scale}px SFMono-Regular, Consolas, monospace`;
    clippedText(context, rows[i][1] || "-", cx + 8 * scale, cy + 31 * scale, cellW - 16 * scale);
  }
}

function drawColorbar(context, app, width, height, scale) {
  const w = Math.min(380 * scale, width - 32 * scale);
  const h = 62 * scale;
  const x = width - w - 16 * scale;
  const y = height - h - 16 * scale;
  drawPanel(context, x, y, w, h, 8 * scale);
  const rampX = x + 12 * scale;
  const rampY = y + 12 * scale;
  const rampW = w - 24 * scale;
  const rampH = 14 * scale;
  const gradient = context.createLinearGradient(rampX, 0, rampX + rampW, 0);
  for (let i = 0; i <= 16; i += 1) {
    const t = i / 16;
    const [r, g, b] = sampleColormap(app.state.colormap, t);
    gradient.addColorStop(t, `rgb(${r} ${g} ${b})`);
  }
  context.fillStyle = gradient;
  roundRect(context, rampX, rampY, rampW, rampH, 4 * scale);
  context.fill();
  context.fillStyle = "#c8c1b3";
  context.font = `${11 * scale}px SFMono-Regular, Consolas, monospace`;
  context.fillText(formatNumber(app.state.min), rampX, y + 45 * scale);
  context.textAlign = "right";
  context.fillText(formatNumber(app.state.max), rampX + rampW, y + 45 * scale);
  context.textAlign = "left";
}

function drawScaleBar(context, app, width, height, scale) {
  const label = app.controls.scaleBarValue.textContent || "";
  const cssWidth = parseFloat(app.controls.scaleBarLine.style.width) || 96;
  const barWidth = cssWidth * scale;
  const x = (width - barWidth) * 0.5;
  const y = height - 36 * scale;
  context.save();
  context.strokeStyle = "#f6f1e7";
  context.lineWidth = Math.max(2, 2 * scale);
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x, y + 8 * scale);
  context.lineTo(x + barWidth, y + 8 * scale);
  context.lineTo(x + barWidth, y);
  context.stroke();
  context.fillStyle = "#f6f1e7";
  context.font = `650 ${11 * scale}px Inter, system-ui, sans-serif`;
  context.textAlign = "center";
  context.fillText(label, x + barWidth * 0.5, y + 24 * scale);
  context.restore();
}

function drawPanel(context, x, y, width, height, radius) {
  context.save();
  context.fillStyle = "rgba(28, 30, 32, 0.88)";
  context.strokeStyle = "rgba(243, 240, 232, 0.16)";
  context.lineWidth = Math.max(1, radius * 0.12);
  roundRect(context, x, y, width, height, radius);
  context.fill();
  context.stroke();
  context.restore();
}

function makeBackgroundTransparent(context, width, height) {
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const dr = Math.abs(data[i] - 32);
    const dg = Math.abs(data[i + 1] - 35);
    const db = Math.abs(data[i + 2] - 38);
    if (dr + dg + db <= 6) {
      data[i + 3] = 0;
    }
  }
  context.putImageData(image, 0, 0);
}

function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width * 0.5, height * 0.5);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function clippedText(context, text, x, y, maxWidth) {
  const value = String(text ?? "-");
  if (context.measureText(value).width <= maxWidth) {
    context.fillText(value, x, y);
    return;
  }
  let clipped = value;
  while (clipped.length > 1 && context.measureText(`${clipped}...`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  context.fillText(`${clipped}...`, x, y);
}

function exportFileName(app, extension) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const clean = (value) => String(value).replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const split = app.splitMode && app.splitMode !== "single" ? `_${clean(app.splitMode)}` : "";
  return `healpix-tilemap${split}_${clean(app.datasetId)}_${clean(app.state.layerId)}_o${app.state.maxOrder}_${stamp}.${extension}`;
}

function imageMetadata(app, exportOptions) {
  const layer = app.manifest.layers.find((item) => item.id === app.state.layerId);
  return {
    schema: "healpix-tilemap.image-metadata.v1",
    exportedAt: new Date().toISOString(),
    application: {
      name: "HEALPix Tile Map",
      datasetId: app.datasetId,
      manifestUrl: app.manifestUrl
    },
    dataset: {
      id: app.datasetId,
      name: app.manifest.name,
      nside: app.manifest.nside,
      minOrder: app.manifest.minOrder,
      maxOrder: app.manifest.maxOrder
    },
    layer: {
      id: app.state.layerId,
      title: layer?.title ?? app.state.layerId,
      unit: layer?.unit ?? ""
    },
    export: exportOptions,
    viewState: app.currentViewState(),
    split: {
      mode: app.splitMode ?? "single",
      activePaneId: app.activePaneId ?? "left",
      overview: Boolean(app.overviewMode),
      footprint: Boolean(app.showFootprint),
      footprintColor: app.footprintColor ?? "#000000",
      panes: (app.panes ?? []).map((pane) => ({
        id: pane.id,
        datasetId: pane.datasetId,
        manifestUrl: pane.manifestUrl,
        state: { ...pane.state },
        viewState: pane.state.view === "globe"
          ? pane.globe?.viewState?.() ?? null
          : {
              net: {
                scale: pane.net?.transform.scale ?? null,
                offsetX: pane.net?.transform.offsetX ?? null,
                offsetY: pane.net?.transform.offsetY ?? null
              }
            }
      }))
    }
  };
}

async function embedImageMetadata(blob, extension, metadata) {
  const json = JSON.stringify(metadata);
  if (extension === "png") {
    return new Blob([insertPngInternationalText(await blob.arrayBuffer(), "healpix-tilemap.view_state", json)], {
      type: "image/png"
    });
  }
  if (extension === "jpg" || extension === "jpeg") {
    return new Blob([insertJpegXmp(await blob.arrayBuffer(), metadata)], {
      type: "image/jpeg"
    });
  }
  return blob;
}

function insertPngInternationalText(buffer, keyword, text) {
  const bytes = new Uint8Array(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) {
    return bytes;
  }
  const textBytes = new TextEncoder().encode(text);
  const keywordBytes = new TextEncoder().encode(keyword);
  const data = concatUint8([
    keywordBytes,
    new Uint8Array([0, 0, 0, 0, 0]),
    textBytes
  ]);
  const chunk = pngChunk("iTXt", data);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = ascii(bytes.slice(offset + 4, offset + 8));
    if (type === "IEND") {
      return concatUint8([bytes.slice(0, offset), chunk, bytes.slice(offset)]);
    }
    offset += 12 + length;
  }
  return bytes;
}

function insertJpegXmp(buffer, metadata) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return bytes;
  }
  const header = new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0");
  const xmp = new TextEncoder().encode(xmpPacket(metadata));
  const payloadLength = header.length + xmp.length;
  if (payloadLength + 2 > 65535) {
    return bytes;
  }
  const segment = new Uint8Array(4 + payloadLength);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment[2] = ((payloadLength + 2) >>> 8) & 0xff;
  segment[3] = (payloadLength + 2) & 0xff;
  segment.set(header, 4);
  segment.set(xmp, 4 + header.length);
  return concatUint8([bytes.slice(0, 2), segment, bytes.slice(2)]);
}

function xmpPacket(metadata) {
  const json = escapeXml(JSON.stringify(metadata));
  return [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:hpx="https://github.com/toshiki-ms/healpix-tilemap/ns/1.0/">',
    `<hpx:ViewState>${json}</hpx:ViewState>`,
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>'
  ].join("");
}

function pngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  writeUint32(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.length, crc32(chunk.slice(4, 8 + data.length)));
  return chunk;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function ascii(bytes) {
  return String.fromCharCode(...bytes);
}

function concatUint8(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
}

async function saveBlob(blob, filename, extension) {
  if (window.showSaveFilePicker && !navigator.webdriver) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [filePickerType(extension)]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "file-picker";
    } catch (error) {
      if (error?.name === "AbortError") {
        return "canceled";
      }
      console.warn("File picker save failed; falling back to download.", error);
    }
  }
  downloadBlob(blob, filename);
  return "download";
}

function filePickerType(extension) {
  if (extension === "jpg" || extension === "jpeg") {
    return {
      description: "JPEG image",
      accept: { "image/jpeg": [".jpg", ".jpeg"] }
    };
  }
  if (extension === "json") {
    return {
      description: "JSON metadata",
      accept: { "application/json": [".json"] }
    };
  }
  return {
    description: "PNG image",
    accept: { "image/png": [".png"] }
  };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Failed to encode export image."));
        }
      },
      mime,
      quality
    );
  });
}

function sanitizeFilename(value, extension) {
  const ext = extension.startsWith(".") ? extension.slice(1) : extension;
  const clean = String(value || `healpix-tilemap.${ext}`)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ");
  if (clean.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
    return clean;
  }
  return `${clean}.${ext}`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "-";
  }
  if (Math.abs(number) >= 1000 || Math.abs(number) < 0.001) {
    return number.toExponential(3);
  }
  return number.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
