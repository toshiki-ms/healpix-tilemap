import { tileKey } from "../core/tile-address.js";
import { arrayForDtype, bytesPerSample, valueEncoding } from "./tile-codec.js";

export class DirectoryTileSource {
  constructor(manifest, manifestUrl) {
    this.manifest = manifest;
    this.manifestUrl = manifestUrl;
    this.baseUrl = new URL(".", manifestUrl);
  }

  layer(id) {
    const layer = this.manifest.layers.find((item) => item.id === id);
    if (!layer) {
      throw new Error(`Unknown layer: ${id}`);
    }
    return layer;
  }

  tileUrl(layerId, tile) {
    const template = this.layer(layerId).source.template;
    const path = template
      .replaceAll("{order}", String(tile.order))
      .replaceAll("{face}", String(tile.face))
      .replaceAll("{x}", String(tile.x))
      .replaceAll("{y}", String(tile.y));
    return new URL(path, this.baseUrl).href;
  }

  async loadTile(layerId, tile, signal) {
    const layer = this.layer(layerId);
    const response = await fetch(this.tileUrl(layerId, tile), { signal });
    if (!response.ok) {
      if (response.status === 404 && layer.source?.sparse) {
        return sparseTileData({ layer, manifest: this.manifest, layerId, tile });
      }
      throw new Error(`Tile ${tileKey(tile)} returned ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    const expectedBytes = this.manifest.tileSize * this.manifest.tileSize * bytesPerSample(layer.dtype);
    if (buffer.byteLength !== expectedBytes) {
      if (layer.source?.sparse) {
        return sparseTileData({ layer, manifest: this.manifest, layerId, tile });
      }
      throw new Error(
        `Tile ${tileKey(tile)} has ${buffer.byteLength} bytes, expected ${expectedBytes}`
      );
    }
    return {
      key: tileKey(tile),
      layerId,
      tile: { ...tile },
      values: arrayForDtype(layer.dtype, buffer),
      encoding: valueEncoding(layer),
      bytes: buffer.byteLength,
      imageCache: new Map()
    };
  }
}

function sparseTileData({ layer, manifest, layerId, tile }) {
  const count = manifest.tileSize * manifest.tileSize;
  const values = emptyValues(layer, count);
  return {
    key: tileKey(tile),
    layerId,
    tile: { ...tile },
    values,
    encoding: valueEncoding(layer),
    bytes: values.byteLength,
    imageCache: new Map(),
    sparseEmpty: true
  };
}

function emptyValues(layer, count) {
  const empty = layer.emptyValue;
  if (layer.dtype === "float32") {
    const values = new Float32Array(count);
    values.fill(Number(empty) === 0 ? 0 : Number.NaN);
    return values;
  }
  const values = arrayForDtype(layer.dtype, new ArrayBuffer(count * bytesPerSample(layer.dtype)));
  const nodata = valueEncoding(layer).nodata;
  if (Number.isFinite(Number(empty))) {
    values.fill(Number(empty));
  } else if (nodata !== null) {
    values.fill(nodata);
  }
  return values;
}
