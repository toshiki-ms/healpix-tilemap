#!/usr/bin/env python3
"""Generate a synthetic hpxmap-v1 dataset.

The generated field is analytic and deterministic. Each order is sampled from
the same continuous function so parent fallback is visually stable. This keeps
the first app dataset small enough for development while exercising the same
tile path intended for larger HEALPix maps.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np

FACE_RING_ANCHORS = np.array([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], dtype=np.float64)
FACE_PHI_ANCHORS = np.array([1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7], dtype=np.float64)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--nside", type=int, default=1024)
    parser.add_argument("--min-order", type=int, default=8)
    parser.add_argument("--tile-size", type=int, default=256)
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

    if args.output.exists() and args.force:
        shutil.rmtree(args.output)
    args.output.mkdir(parents=True, exist_ok=True)

    layer_dir = args.output / "layers" / "value"
    layer_dir.mkdir(parents=True, exist_ok=True)

    all_min = math.inf
    all_max = -math.inf
    samples_for_percentile: list[np.ndarray] = []

    for order in range(args.min_order, max_order + 1):
        order_min, order_max, order_samples = write_order(layer_dir, order, tile_shift, args.tile_size)
        all_min = min(all_min, order_min)
        all_max = max(all_max, order_max)
        samples_for_percentile.append(order_samples)
        print(f"order {order}: min={order_min:.6f} max={order_max:.6f}")

    percentile_source = np.concatenate(samples_for_percentile)
    p1, p50, p99 = np.percentile(percentile_source, [1, 50, 99])

    manifest = {
        "schema": "hpxmap-v1",
        "name": f"synthetic-n{args.nside}",
        "ordering": "nested",
        "minOrder": args.min_order,
        "maxOrder": max_order,
        "nside": args.nside,
        "tileShift": tile_shift,
        "tileSize": args.tile_size,
        "tileLayout": "face-local-row-major",
        "defaultView": {
            "mode": "net",
            "layer": "value",
            "order": max_order,
            "scale": "symlog",
            "colormap": "viridis",
        },
        "layers": [
            {
                "id": "value",
                "title": "Synthetic value",
                "kind": "scalar",
                "dtype": "float32",
                "unit": "",
                "nodata": "nan",
                "aggregation": "analytic-sample",
                "source": {
                    "type": "directory",
                    "template": "layers/value/o{order}/f{face}/x{x}/y{y}.bin",
                },
                "stats": {
                    "min": float(all_min),
                    "max": float(all_max),
                    "percentiles": {
                        "1": float(p1),
                        "50": float(p50),
                        "99": float(p99),
                    },
                },
            }
        ],
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output / 'manifest.json'}")


def write_order(layer_dir: Path, order: int, tile_shift: int, tile_size: int) -> tuple[float, float, np.ndarray]:
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
                values = synthetic_value(face, uu, vv).astype("<f4", copy=False)
                out_dir = layer_dir / f"o{order}" / f"f{face}" / f"x{x}"
                out_dir.mkdir(parents=True, exist_ok=True)
                values.tofile(out_dir / f"y{y}.bin")
                finite = values[np.isfinite(values)]
                if finite.size:
                    order_min = min(order_min, float(finite.min()))
                    order_max = max(order_max, float(finite.max()))
                    stride = max(1, finite.size // 2048)
                    samples.append(finite[::stride].astype(np.float64))

    return order_min, order_max, np.concatenate(samples)


def synthetic_value(face: int, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    vector = face_uv_to_vector(face, u, v)
    x, y, z = vector
    lon = np.arctan2(z, x)
    lat = np.arcsin(np.clip(y, -1, 1))
    ridges = 0.38 * np.sin(11 * lon + 3.2 * np.sin(4 * lat))
    waves = 0.32 * np.cos(7 * lat + 1.2 * x - 0.8 * z)
    band = 0.24 * np.sin(3.0 * lon + 8.0 * x * z)
    spot_a = 0.75 * np.exp(-(angular_delta(lon, 1.1) ** 2 + (lat - 0.45) ** 2) / 0.055)
    spot_b = -0.68 * np.exp(-(angular_delta(lon, -2.2) ** 2 + (lat + 0.24) ** 2) / 0.08)
    polar = 0.18 * y * y * np.sin(5.0 * lon + 0.6)
    return ridges + waves + band + spot_a + spot_b + polar


def angular_delta(angle: np.ndarray, center: float) -> np.ndarray:
    return np.arctan2(np.sin(angle - center), np.cos(angle - center))


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
