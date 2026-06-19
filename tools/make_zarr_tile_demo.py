#!/usr/bin/env python3
"""Create a small zarr-tile demo dataset.

The generated Zarr store is intentionally kept outside public/datasets. The
viewer manifest points to it and asks the dev server to generate/cache tiles on
demand.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("data/zarr-tile-demo.zarr"))
    parser.add_argument("--dataset-output", type=Path, default=Path("public/datasets/zarr-tile-demo"))
    parser.add_argument("--dataset-id", default="zarr-tile-demo")
    parser.add_argument("--title", default="Zarr tile cache demo")
    parser.add_argument("--nside", type=int, default=256)
    parser.add_argument("--time-count", type=int, default=2)
    parser.add_argument("--level-count", type=int, default=3)
    parser.add_argument("--tile-size", type=int, default=128)
    parser.add_argument("--chunk-size", type=int, default=256)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    validate_power_of_two(args.nside, "--nside")
    validate_power_of_two(args.tile_size, "--tile-size")
    validate_power_of_two(args.chunk_size, "--chunk-size")
    chunk_size = min(args.chunk_size, args.nside)

    try:
        import zarr
    except ImportError as exc:
        raise SystemExit("zarr>=3 is required; install python[array] or python[all].") from exc

    if args.output.exists() and args.force:
        shutil.rmtree(args.output)
    if args.output.exists():
        raise SystemExit(f"{args.output} already exists; pass --force to replace it")
    args.output.parent.mkdir(parents=True, exist_ok=True)

    root = zarr.open_group(args.output, mode="w", zarr_format=3)
    arrays = {
        layer_id: root.create_array(
            layer_id,
            shape=(args.time_count, args.level_count, 12, args.nside, args.nside),
            chunks=(1, 1, 1, chunk_size, chunk_size),
            dtype="float32",
        )
        for layer_id in ("value", "u", "v")
    }
    for array in arrays.values():
        array.attrs["_ARRAY_DIMENSIONS"] = ["time", "level", "face", "y", "x"]
    root.attrs["description"] = "Synthetic zarr-tile face/y/x demo for HEALPix Tile Map."

    summaries = {
        layer_id: {"min": math.inf, "max": -math.inf, "samples": []}
        for layer_id in arrays
    }
    for time_index in range(args.time_count):
        for level_index in range(args.level_count):
            for face in range(12):
                for y0 in range(0, args.nside, chunk_size):
                    y1 = min(args.nside, y0 + chunk_size)
                    for x0 in range(0, args.nside, chunk_size):
                        x1 = min(args.nside, x0 + chunk_size)
                        chunks = demo_fields(
                            nside=args.nside,
                            time_index=time_index,
                            level_index=level_index,
                            face=face,
                            x0=x0,
                            x1=x1,
                            y0=y0,
                            y1=y1,
                        )
                        for layer_id, chunk in chunks.items():
                            arrays[layer_id][time_index, level_index, face, y0:y1, x0:x1] = chunk
                            summary = summaries[layer_id]
                            summary["min"] = min(float(summary["min"]), float(chunk.min()))
                            summary["max"] = max(float(summary["max"]), float(chunk.max()))
                            stride = max(1, chunk.size // 512)
                            summary["samples"].append(chunk.reshape(-1)[::stride])
            print(f"time={time_index} level={level_index} written", flush=True)

    max_order = int(round(math.log2(args.nside)))
    tile_shift = int(round(math.log2(args.tile_size)))
    min_order = max(tile_shift, max_order - 2)

    manifest = {
        "schema": "hpxmap-v1",
        "name": args.dataset_id,
        "ordering": "nested",
        "minOrder": min_order,
        "maxOrder": max_order,
        "nside": args.nside,
        "tileShift": tile_shift,
        "tileSize": args.tile_size,
        "tileLayout": "face-local-row-major",
        "description": "Demo dataset whose tiles are filled from a Zarr v3 face/y/x array through the server-side tile cache.",
        "defaultView": {
            "mode": "globe",
            "layer": "value",
            "order": max_order,
            "scale": "linear",
            "colormap": "viridis",
        },
        "layers": [
            make_layer(
                layer_id="value",
                title="Scalar value",
                source_zarr=str(args.output),
                summary=summaries["value"],
            ),
            make_layer(
                layer_id="u",
                title="U component",
                source_zarr=str(args.output),
                summary=summaries["u"],
            ),
            make_layer(
                layer_id="v",
                title="V component",
                source_zarr=str(args.output),
                summary=summaries["v"],
            ),
        ],
        "sources": [
            {
                "title": args.title,
                "asset": str(args.output),
                "inputLayout": "zarr-tile-face-grid",
                "note": "Tiles are generated by /api/zarr-tiles and cached under cache/zarr-tiles.",
            }
        ],
    }

    if args.dataset_output.exists() and args.force:
        shutil.rmtree(args.dataset_output)
    args.dataset_output.mkdir(parents=True, exist_ok=True)
    (args.dataset_output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output}")
    print(f"wrote {args.dataset_output / 'manifest.json'}")


def make_layer(*, layer_id: str, title: str, source_zarr: str, summary: dict[str, object]) -> dict[str, object]:
    sample = np.concatenate(summary["samples"])
    p1, p50, p99 = np.percentile(sample, [1, 50, 99])
    return {
        "id": layer_id,
        "title": title,
        "kind": "scalar",
        "dtype": "float32",
        "unit": "",
        "aggregation": "zarr-tile-mean-downsample",
        "source": {
            "type": "zarr-tile",
            "endpoint": "/api/zarr-tiles",
            "zarr": source_zarr,
            "array": layer_id,
            "dims": ["time", "level", "face", "y", "x"],
            "select": {"time": 0, "level": 0},
            "cacheKey": "spherical-vector-components-v1",
            "maxReadCells": 4194304,
        },
        "stats": {
            "min": float(summary["min"]),
            "max": float(summary["max"]),
            "percentiles": {"1": float(p1), "50": float(p50), "99": float(p99)},
        },
    }


def demo_fields(
    *,
    nside: int,
    time_index: int,
    level_index: int,
    face: int,
    x0: int,
    x1: int,
    y0: int,
    y1: int,
) -> np.ndarray:
    yy, xx = np.meshgrid(np.arange(y0, y1, dtype=np.float32), np.arange(x0, x1, dtype=np.float32), indexing="ij")
    u = (xx + 0.5) / nside
    v = (yy + 0.5) / nside
    sx, sy, sz = face_uv_to_vector(face, u, v)
    phase = 0.35 * time_index + 0.22 * level_index
    u_component = (
        np.sin(3.4 * sx - 1.7 * sy + 2.2 * sz + phase)
        + 0.28 * np.cos(7.0 * (sx * sz - 0.3 * sy) + 0.2 * level_index)
    )
    v_component = (
        np.cos(-2.1 * sx + 2.9 * sy + 1.6 * sz - 0.5 * phase)
        + 0.25 * np.sin(8.0 * (sy * sz + 0.2 * sx) - 0.3 * time_index)
    )
    broad = 0.72 * u_component + 0.58 * v_component
    bands = 0.22 * np.cos(9.0 * (sx * sy + 0.55 * sz) - 0.4 * level_index)
    detail = 0.12 * np.sin(17.0 * sx + 11.0 * sy - 7.0 * sz + 0.2 * time_index)
    level_offset = 0.2 * level_index
    value = broad + bands + detail + level_offset
    return {
        "value": value.astype(np.float32),
        "u": u_component.astype(np.float32),
        "v": v_component.astype(np.float32),
    }


FACE_RING_ANCHORS = np.array([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], dtype=np.float32)
FACE_PHI_ANCHORS = np.array([1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7], dtype=np.float32)


def face_uv_to_vector(face: int, u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    safe_u = np.clip(u, 0, 1)
    safe_v = np.clip(v, 0, 1)
    ring_norm = np.clip(FACE_RING_ANCHORS[face] - safe_u - safe_v, 0, 4)
    raw_norm = FACE_PHI_ANCHORS[face] - safe_u + safe_v
    phi = np.mod(phi_raw_from_grid_norm(raw_norm, ring_norm) * np.pi / 4, 2 * np.pi)
    sy = height_from_ring_norm(ring_norm)
    horizontal = np.sqrt(np.maximum(0, 1 - sy * sy))
    return np.cos(phi) * horizontal, sy, np.sin(phi) * horizontal


def height_from_ring_norm(ring_norm: np.ndarray) -> np.ndarray:
    polar = 1 - (ring_norm * ring_norm) / 3
    equatorial = ((2 - ring_norm) * 2) / 3
    mirror = 4 - ring_norm
    south = -1 + (mirror * mirror) / 3
    return np.where(ring_norm <= 1, polar, np.where(ring_norm <= 3, equatorial, south))


def phi_raw_from_grid_norm(raw_norm: np.ndarray, ring_norm: np.ndarray) -> np.ndarray:
    eps = 1e-6
    anchor = nearest_polar_anchor_norm(raw_norm)
    north = anchor + (raw_norm - anchor) / np.maximum(ring_norm, eps)
    south = anchor + (raw_norm - anchor) / np.maximum(4 - ring_norm, eps)
    return np.where(
        (ring_norm <= eps) | (ring_norm >= 4 - eps),
        anchor,
        np.where(ring_norm < 1, north, np.where(ring_norm > 3, south, raw_norm)),
    )


def nearest_polar_anchor_norm(raw_norm: np.ndarray) -> np.ndarray:
    anchors = np.array([1, 3, 5, 7], dtype=np.float32)
    wrapped = anchors[:, None, None] + np.round((raw_norm[None, :, :] - anchors[:, None, None]) / 8) * 8
    distances = np.abs(raw_norm[None, :, :] - wrapped)
    indices = np.argmin(distances, axis=0)
    return np.take_along_axis(wrapped, indices[None, :, :], axis=0)[0]


def validate_power_of_two(value: int, label: str) -> None:
    if value <= 0 or value & (value - 1):
        raise SystemExit(f"{label} must be a positive power of two")


if __name__ == "__main__":
    main()
