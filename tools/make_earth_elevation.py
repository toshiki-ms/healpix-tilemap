#!/usr/bin/env python3
"""Generate an hpxmap-v1 Earth elevation dataset from a global DEM raster."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import math
import shutil
from pathlib import Path
from typing import Any

import numpy as np

FACE_RING_ANCHORS = np.array([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], dtype=np.float64)
FACE_PHI_ANCHORS = np.array([1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7], dtype=np.float64)
DEFAULT_SOURCE = Path("data/ETOPO_2022_v1_60s_N90W180_bed.nc")
LEGACY_SOURCE = Path("../healpix-othello/src/assets/earth-elevation/etopo1-1deg-int16.bin")
MAX_DIRECT_WINDOW_CELLS = 8_000_000
VRT_SAMPLE_CHUNK = 32


@dataclass(frozen=True)
class ElevationGrid:
    source_path: Path
    title: str
    description: str
    resolution_label: str
    aggregation_label: str
    gridline_global: bool
    width: int
    height: int
    values: np.ndarray | None = None
    dataset: Any | None = None
    nodata: float | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--nside", type=int, default=1024)
    parser.add_argument("--min-order", type=int, default=8)
    parser.add_argument("--tile-size", type=int, default=256)
    parser.add_argument("--tile-dtype", choices=["float32", "uint16", "int16"], default="float32")
    parser.add_argument("--quantize-min", type=float, default=None)
    parser.add_argument("--quantize-max", type=float, default=None)
    parser.add_argument("--quantize-step", type=float, default=None)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    max_order = int(round(math.log2(args.nside)))
    if 2**max_order != args.nside:
        raise SystemExit("--nside must be a power of two")
    tile_shift = int(round(math.log2(args.tile_size)))
    if 2**tile_shift != args.tile_size:
        raise SystemExit("--tile-size must be a power of two")
    if args.min_order < tile_shift:
        raise SystemExit("--min-order must be >= log2(tile-size) for this prototype")
    if args.min_order > max_order:
        raise SystemExit("--min-order must be <= max order")

    source_grid = load_elevation_grid(args.source)
    encoding = make_encoding(
        args.tile_dtype,
        quantize_min=args.quantize_min,
        quantize_max=args.quantize_max,
        quantize_step=args.quantize_step,
    )

    if args.output.exists() and args.force:
        shutil.rmtree(args.output)
    args.output.mkdir(parents=True, exist_ok=True)

    layer_dir = args.output / "layers" / "elevation_m"
    layer_dir.mkdir(parents=True, exist_ok=True)

    all_min = math.inf
    all_max = -math.inf
    samples_for_percentile: list[np.ndarray] = []

    for order in range(args.min_order, max_order + 1):
        order_min, order_max, order_samples = write_order(
            layer_dir, source_grid, order, tile_shift, args.tile_size, encoding
        )
        all_min = min(all_min, order_min)
        all_max = max(all_max, order_max)
        samples_for_percentile.append(order_samples)
        print(f"order {order}: min={order_min:.1f} max={order_max:.1f}")

    percentile_source = np.concatenate(samples_for_percentile)
    p1, p2, p50, p98, p99 = np.percentile(percentile_source, [1, 2, 50, 98, 99])

    layer = {
        "id": "elevation_m",
        "title": "Elevation",
        "kind": "scalar",
        "dtype": encoding["dtype"],
        "unit": "m",
        "nodata": encoding["nodata"],
        "aggregation": source_grid.aggregation_label,
        "source": {
            "type": "directory",
            "template": "layers/elevation_m/o{order}/f{face}/x{x}/y{y}.bin",
        },
        "stats": {
            "min": float(all_min),
            "max": float(all_max),
            "percentiles": {
                "1": float(p1),
                "2": float(p2),
                "50": float(p50),
                "98": float(p98),
                "99": float(p99),
            },
        },
    }
    if encoding["dtype"] != "float32":
        layer["quantization"] = {
            "scale": encoding["scale"],
            "offset": encoding["offset"],
            "nodata": encoding["nodata"],
        }

    manifest = {
        "schema": "hpxmap-v1",
        "name": f"earth-elevation-n{args.nside}",
        "ordering": "nested",
        "minOrder": args.min_order,
        "maxOrder": max_order,
        "nside": args.nside,
        "tileShift": tile_shift,
        "tileSize": args.tile_size,
        "tileLayout": "face-local-row-major",
        "description": f"{source_grid.description} sampled onto a HEALPix tile pyramid.",
        "defaultView": {
            "mode": "globe",
            "layer": "elevation_m",
            "order": max_order,
            "scale": "symlog",
            "colormap": "balance",
        },
        "layers": [layer],
        "sources": [
            {
                "title": source_grid.title,
                "asset": str(source_grid.source_path),
                "resolution": source_grid.resolution_label,
                "note": "Sampled with periodic longitude and clamped latitude bicubic interpolation.",
            }
        ],
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output / 'manifest.json'}")


def write_order(
    layer_dir: Path,
    source_grid: ElevationGrid,
    order: int,
    tile_shift: int,
    tile_size: int,
    encoding: dict[str, float | int | str],
) -> tuple[float, float, np.ndarray]:
    nside = 2**order
    grid = max(1, 2 ** max(0, order - tile_shift))
    order_min = math.inf
    order_max = -math.inf
    samples = []
    local = (np.arange(tile_size, dtype=np.float64) + 0.5) / nside

    for face in range(12):
        for y in range(grid):
            tile_v = y * tile_size / nside + local
            for x in range(grid):
                tile_u = x * tile_size / nside + local
                uu, vv = np.meshgrid(tile_u, tile_v)
                lon, lat = face_uv_to_lon_lat(face, uu, vv)
                values = sample_elevation_adaptive(source_grid, lon, lat).astype(np.float32, copy=False)
                out_dir = layer_dir / f"o{order}" / f"f{face}" / f"x{x}"
                out_dir.mkdir(parents=True, exist_ok=True)
                encode_tile(values, encoding).tofile(out_dir / f"y{y}.bin")
                finite = values[np.isfinite(values)]
                if finite.size:
                    order_min = min(order_min, float(finite.min()))
                    order_max = max(order_max, float(finite.max()))
                    stride = max(1, finite.size // 2048)
                    samples.append(finite[::stride].astype(np.float64))

    return order_min, order_max, np.concatenate(samples)


def make_encoding(
    tile_dtype: str,
    quantize_min: float | None,
    quantize_max: float | None,
    quantize_step: float | None,
) -> dict[str, float | int | str]:
    if tile_dtype == "float32":
        return {"dtype": "float32", "nodata": "nan", "scale": 1.0, "offset": 0.0}

    value_min = -12000.0 if quantize_min is None else float(quantize_min)
    value_max = 9000.0 if quantize_max is None else float(quantize_max)
    if not value_max > value_min:
        raise SystemExit("quantization max must be greater than min")

    if tile_dtype == "uint16":
        code_min = 0
        code_max = 65534
        nodata = 65535
        offset = value_min
    elif tile_dtype == "int16":
        code_min = -32767
        code_max = 32767
        nodata = -32768
        offset = (value_min + value_max) * 0.5
    else:
        raise SystemExit(f"unsupported tile dtype: {tile_dtype}")

    scale = float(quantize_step) if quantize_step is not None else (value_max - value_min) / (code_max - code_min)
    if scale <= 0:
        raise SystemExit("--quantize-step must be positive")
    if tile_dtype == "uint16":
        if math.ceil((value_max - offset) / scale) > code_max:
            raise SystemExit("uint16 quantization range does not fit; increase --quantize-step or --quantize-max")
    else:
        if math.floor((value_min - offset) / scale) < code_min or math.ceil((value_max - offset) / scale) > code_max:
            raise SystemExit("int16 quantization range does not fit; increase --quantize-step or adjust min/max")

    print(
        f"tile encoding {tile_dtype}: value = encoded * {scale:.9g} + {offset:.9g}; "
        f"nodata={nodata}"
    )
    return {"dtype": tile_dtype, "scale": scale, "offset": offset, "nodata": nodata}


def encode_tile(tile: np.ndarray, encoding: dict[str, float | int | str]) -> np.ndarray:
    dtype = encoding["dtype"]
    if dtype == "float32":
        return np.asarray(tile, dtype="<f4")

    scale = float(encoding["scale"])
    offset = float(encoding["offset"])
    finite = np.isfinite(tile)
    if dtype == "uint16":
        nodata = np.uint16(int(encoding["nodata"]))
        out = np.full(tile.shape, nodata, dtype="<u2")
        encoded = np.rint((tile[finite] - offset) / scale)
        out[finite] = np.clip(encoded, 0, 65534).astype("<u2")
        return out
    if dtype == "int16":
        nodata = np.int16(int(encoding["nodata"]))
        out = np.full(tile.shape, nodata, dtype="<i2")
        encoded = np.rint((tile[finite] - offset) / scale)
        out[finite] = np.clip(encoded, -32767, 32767).astype("<i2")
        return out
    raise SystemExit(f"unsupported tile dtype: {dtype}")


def load_elevation_grid(source: Path) -> ElevationGrid:
    if not source.is_absolute():
        source = Path.cwd() / source
    if not source.exists():
        raise SystemExit(
            f"{source} does not exist. Download ETOPO 2022 first with `npm run download:etopo2022:60s`, "
            f"or pass --source {LEGACY_SOURCE} for the old 1-degree development asset."
        )

    if source.suffix == ".bin":
        values = np.fromfile(source, dtype="<i2")
        expected = 361 * 181
        if values.size != expected:
            raise SystemExit(f"{source} has {values.size} samples, expected {expected}")
        return ElevationGrid(
            source_path=source,
            title="Local ETOPO-derived 1-degree development asset",
            description="1-degree Earth elevation development asset",
            resolution_label="1 degree",
            aggregation_label="bicubic-global-gridline-sample",
            gridline_global=True,
            width=361,
            height=181,
            values=values.reshape((181, 361)),
        )

    try:
        import rasterio
    except ImportError as exc:
        raise SystemExit("rasterio is required for NetCDF/GeoTIFF DEM sources") from exc

    dataset = rasterio.open(source)
    nodata = dataset.nodata
    tags = dataset.tags()
    width = dataset.width
    height = dataset.height
    pixel_count = width * height
    values = None
    raster_dataset = dataset
    if pixel_count <= 260_000_000 and source.suffix != ".vrt":
        values = dataset.read(1, masked=False)
        dataset.close()
        raster_dataset = None
        if nodata is not None:
            values = values.astype(np.float32, copy=False)
            values = np.where(values == nodata, np.nan, values)

    gridline_global = width == 2 * height - 1
    resolution_arcsec = 360 * 3600 / (width - 1 if gridline_global else width)
    if resolution_arcsec >= 3600:
        resolution_label = f"{resolution_arcsec / 3600:.4g} degree"
    else:
        resolution_label = f"{resolution_arcsec:.4g} arc-second"
    title = tags.get("title") or tags.get("NC_GLOBAL#title") or default_source_title(source, resolution_label)
    description = tags.get("summary") or tags.get("NC_GLOBAL#summary") or title
    return ElevationGrid(
        source_path=source,
        title=title,
        description=description,
        resolution_label=resolution_label,
        aggregation_label="bicubic-global-gridline-sample" if gridline_global else "bicubic-raster-sample",
        gridline_global=gridline_global,
        width=width,
        height=height,
        values=values,
        dataset=raster_dataset,
        nodata=nodata,
    )


def default_source_title(source: Path, resolution_label: str) -> str:
    if source.name.startswith("ETOPO_2022") or "ETOPO2022" in source.as_posix():
        flavor = "surface" if "surface" in source.name or "surface" in source.as_posix() else "bedrock"
        return f"NOAA ETOPO 2022 {resolution_label} {flavor} elevation"
    return f"Global DEM raster ({resolution_label})"


def sample_elevation(source_grid: ElevationGrid, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    x, y, cycle_width = source_pixel_xy(source_grid, lon, lat)
    return bicubic_sample_periodic_x_clamped_y(source_grid, x, y, cycle_width)


def sample_elevation_adaptive(source_grid: ElevationGrid, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    if source_grid.dataset is None:
        return sample_elevation(source_grid, lon, lat)
    x, y, cycle_width = source_pixel_xy(source_grid, lon, lat)
    if estimated_window_cells(x, y) <= MAX_DIRECT_WINDOW_CELLS:
        return bicubic_sample_periodic_x_clamped_y(source_grid, x, y, cycle_width)

    out = np.empty(lon.shape, dtype=np.float64)
    rows, cols = lon.shape
    for row0 in range(0, rows, VRT_SAMPLE_CHUNK):
        row1 = min(rows, row0 + VRT_SAMPLE_CHUNK)
        for col0 in range(0, cols, VRT_SAMPLE_CHUNK):
            col1 = min(cols, col0 + VRT_SAMPLE_CHUNK)
            out[row0:row1, col0:col1] = sample_elevation(
                source_grid,
                lon[row0:row1, col0:col1],
                lat[row0:row1, col0:col1],
            )
    return out


def source_pixel_xy(source_grid: ElevationGrid, lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    height = source_grid.height
    width = source_grid.width
    if source_grid.gridline_global:
        cycle_width = width - 1
        x = np.mod((lon + 180) * cycle_width / 360, cycle_width)
        y = np.clip((90 - lat) * (height - 1) / 180, 0, height - 1)
        return unwrap_periodic_x(x, cycle_width), y, cycle_width

    x = np.mod((lon + 180) * width / 360 - 0.5, width)
    y = np.clip((90 - lat) * height / 180 - 0.5, 0, height - 1)
    return unwrap_periodic_x(x, width), y, width


def unwrap_periodic_x(x: np.ndarray, cycle_width: int) -> np.ndarray:
    x_min = float(np.nanmin(x))
    x_max = float(np.nanmax(x))
    if x_max - x_min <= cycle_width * 0.5:
        return x
    return np.where(x < cycle_width * 0.5, x + cycle_width, x)


def estimated_window_cells(x: np.ndarray, y: np.ndarray) -> int:
    x1 = np.floor(x).astype(np.int64)
    y1 = np.floor(y).astype(np.int64)
    width = int(np.max(x1) - np.min(x1) + 4)
    height = int(np.max(y1) - np.min(y1) + 4)
    return max(0, width) * max(0, height)


def bicubic_sample_periodic_x_clamped_y(
    source_grid: ElevationGrid,
    x: np.ndarray,
    y: np.ndarray,
    cycle_width: int,
) -> np.ndarray:
    height = source_grid.height
    x1 = np.floor(x).astype(np.int32)
    y1 = np.floor(y).astype(np.int32)
    tx = x - x1
    ty = y - y1
    x_min = int(np.min(x1)) - 1
    x_max = int(np.max(x1)) + 2
    y_min = int(np.min(y1)) - 1
    y_max = int(np.max(y1)) + 2
    window = read_periodic_window(source_grid, x_min, x_max, y_min, y_max, cycle_width)

    rows = []
    for offset_y in (-1, 0, 1, 2):
        yy = np.clip(y1 + offset_y, 0, height - 1) - y_min
        c0 = window[yy, x1 - 1 - x_min]
        c1 = window[yy, x1 - x_min]
        c2 = window[yy, x1 + 1 - x_min]
        c3 = window[yy, x1 + 2 - x_min]
        rows.append(catmull_rom(c0, c1, c2, c3, tx))
    return catmull_rom(rows[0], rows[1], rows[2], rows[3], ty)


def read_periodic_window(
    source_grid: ElevationGrid,
    x_min: int,
    x_max: int,
    y_min: int,
    y_max: int,
    cycle_width: int,
) -> np.ndarray:
    y_indices = np.clip(np.arange(y_min, y_max + 1, dtype=np.int64), 0, source_grid.height - 1)
    if source_grid.values is not None:
        x_indices = np.mod(np.arange(x_min, x_max + 1, dtype=np.int64), cycle_width)
        return source_grid.values[y_indices[:, None], x_indices[None, :]]

    if source_grid.dataset is None:
        raise RuntimeError("Elevation source has neither in-memory values nor a raster dataset.")

    from rasterio.windows import Window

    y_read_min = int(y_indices.min())
    y_read_max = int(y_indices.max())
    segments = []
    position = x_min
    while position <= x_max:
        start = position % cycle_width
        run = min(x_max - position + 1, cycle_width - start)
        block = source_grid.dataset.read(
            1,
            window=Window(start, y_read_min, run, y_read_max - y_read_min + 1),
            masked=False,
        )
        if source_grid.nodata is not None:
            block = block.astype(np.float32, copy=False)
            block = np.where(block == source_grid.nodata, np.nan, block)
        segments.append(block[y_indices - y_read_min, :])
        position += run
    return np.concatenate(segments, axis=1)


def catmull_rom(p0: np.ndarray, p1: np.ndarray, p2: np.ndarray, p3: np.ndarray, t: np.ndarray) -> np.ndarray:
    return 0.5 * (
        2 * p1
        + (-p0 + p2) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
    )


def face_uv_to_lon_lat(face: int, u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    vector = face_uv_to_vector(face, u, v)
    x, y, z = vector
    lon = np.degrees(np.arctan2(z, x))
    lat = np.degrees(np.arcsin(np.clip(y, -1, 1)))
    return lon, lat


def face_uv_to_vector(face: int, u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ring_norm = np.clip(FACE_RING_ANCHORS[face] - u - v, 0, 4)
    raw_norm = FACE_PHI_ANCHORS[face] - u + v
    phi_raw = phi_raw_from_grid_norm(raw_norm, ring_norm)
    phi = np.mod(phi_raw * np.pi / 4, 2 * np.pi)
    height = height_from_ring_norm(ring_norm)
    horizontal = np.sqrt(np.maximum(0, 1 - height * height))
    return np.cos(phi) * horizontal, height, np.sin(phi) * horizontal


def height_from_ring_norm(ring_norm: np.ndarray) -> np.ndarray:
    north = 1 - ring_norm * ring_norm / 3
    equator = ((2 - ring_norm) * 2) / 3
    mirror = 4 - ring_norm
    south = -1 + mirror * mirror / 3
    return np.where(ring_norm <= 1, north, np.where(ring_norm <= 3, equator, south))


def phi_raw_from_grid_norm(raw_norm: np.ndarray, ring_norm: np.ndarray) -> np.ndarray:
    anchor = nearest_polar_anchor_norm(raw_norm)
    north = anchor + (raw_norm - anchor) / np.maximum(ring_norm, 1e-6)
    south = anchor + (raw_norm - anchor) / np.maximum(4 - ring_norm, 1e-6)
    return np.where(ring_norm < 1, north, np.where(ring_norm > 3, south, raw_norm))


def nearest_polar_anchor_norm(raw_norm: np.ndarray) -> np.ndarray:
    anchors = np.array([1, 3, 5, 7], dtype=np.float64)
    candidates = anchors[:, None, None] + np.round((raw_norm[None, :, :] - anchors[:, None, None]) / 8) * 8
    distances = np.abs(raw_norm[None, :, :] - candidates)
    best = np.argmin(distances, axis=0)
    return np.take_along_axis(candidates, best[None, :, :], axis=0)[0]


if __name__ == "__main__":
    main()
