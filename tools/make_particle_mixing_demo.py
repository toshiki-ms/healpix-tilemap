#!/usr/bin/env python3
"""Generate a global particle mixing-ratio Zarr store for demos.

The output is intentionally a particle table, not a dense HEALPix map. Every
coarse HEALPix NESTED cell at --base-order receives the same number of
particles, but those particles are distributed across child cells at
--particle-order. Use tools/make_particle_tiles.py with --aggregation mean to
visualize it.
"""

from __future__ import annotations

import argparse
import math
import shutil
from pathlib import Path

import numpy as np

from make_hpx_tiles import morton_decode

FACE_RING_ANCHORS = np.array([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], dtype=np.float64)
FACE_PHI_ANCHORS = np.array([1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7], dtype=np.float64)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--base-order", type=int, default=8)
    parser.add_argument("--particle-order", type=int, default=10)
    parser.add_argument("--particles-per-cell", type=int, default=16)
    parser.add_argument("--cell-chunk-size", type=int, default=262_144)
    parser.add_argument("--seed", type=int, default=20260618)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.base_order < 0 or args.particle_order < 0:
        raise SystemExit("--base-order and --particle-order must be non-negative")
    if args.base_order > args.particle_order:
        raise SystemExit("--base-order must be <= --particle-order")
    if args.particles_per_cell <= 0:
        raise SystemExit("--particles-per-cell must be positive")
    if args.cell_chunk_size <= 0:
        raise SystemExit("--cell-chunk-size must be positive")
    if args.output.exists():
        if not args.force:
            raise SystemExit(f"{args.output} already exists; pass --force to overwrite")
        shutil.rmtree(args.output)

    try:
        import zarr
    except ImportError as exc:
        raise SystemExit("zarr>=3 is required; install python[array] or python[all].") from exc

    base_nside = 2**args.base_order
    particle_nside = 2**args.particle_order
    base_cell_count = 12 * base_nside * base_nside
    particle_count = base_cell_count * args.particles_per_cell
    particle_chunk_size = args.cell_chunk_size * args.particles_per_cell

    root = zarr.open_group(args.output, mode="w", zarr_format=3)
    cells = root.create_array(
        "cell",
        shape=(particle_count,),
        chunks=(particle_chunk_size,),
        dtype="uint64",
    )
    mixing_ratio = root.create_array(
        "mixing_ratio",
        shape=(particle_count,),
        chunks=(particle_chunk_size,),
        dtype="float32",
    )
    cells.attrs["_ARRAY_DIMENSIONS"] = ["particle"]
    mixing_ratio.attrs["_ARRAY_DIMENSIONS"] = ["particle"]
    root.attrs["particle_order"] = args.particle_order
    root.attrs["base_order"] = args.base_order
    root.attrs["particles_per_cell"] = args.particles_per_cell
    root.attrs["description"] = (
        "Global HEALPix-indexed particles with per-particle mixing_ratio values. "
        "Aggregate with mean to draw a cell-averaged scalar field."
    )

    rng = np.random.default_rng(args.seed)
    value_min = math.inf
    value_max = -math.inf
    value_sum = 0.0

    child_shift = np.uint64(2 * (args.particle_order - args.base_order))
    child_cell_count = 1 << int(child_shift)
    for cell_start in range(0, base_cell_count, args.cell_chunk_size):
        cell_stop = min(base_cell_count, cell_start + args.cell_chunk_size)
        base_cells = np.arange(cell_start, cell_stop, dtype=np.uint64)
        subcell_offsets = random_child_offsets(
            rng=rng,
            parent_count=base_cells.size,
            child_cell_count=child_cell_count,
            count=args.particles_per_cell,
        )
        particle_cells = ((base_cells[:, None] << child_shift) + subcell_offsets).reshape(-1)
        particle_values = mixing_field(particle_cells, args.particle_order)
        particle_values += rng.normal(0.0, 0.045, size=particle_values.size)
        particle_values += rng.uniform(-0.018, 0.018, size=particle_values.size)
        particle_values = np.clip(particle_values, 0.0, 1.0).astype(np.float32)

        particle_start = cell_start * args.particles_per_cell
        particle_stop = cell_stop * args.particles_per_cell
        cells[particle_start:particle_stop] = particle_cells
        mixing_ratio[particle_start:particle_stop] = particle_values

        finite = particle_values[np.isfinite(particle_values)]
        if finite.size:
            value_min = min(value_min, float(finite.min()))
            value_max = max(value_max, float(finite.max()))
            value_sum += float(finite.sum(dtype=np.float64))
        print(
            f"base cells {cell_start:,}-{cell_stop:,} / {base_cell_count:,}; "
            f"particles {particle_stop:,} / {particle_count:,}"
        )

    print(
        f"wrote {args.output} with {particle_count:,} particles "
        f"(base_order={args.base_order}, base_nside={base_nside}, "
        f"particle_order={args.particle_order}, particle_nside={particle_nside}, "
        f"particles_per_cell={args.particles_per_cell}, "
        f"min={value_min:.5f}, max={value_max:.5f}, mean={value_sum / particle_count:.5f})"
    )


def random_child_offsets(
    *, rng: np.random.Generator, parent_count: int, child_cell_count: int, count: int
) -> np.ndarray:
    if count <= child_cell_count:
        scores = rng.random((parent_count, child_cell_count), dtype=np.float32)
        offsets = np.argpartition(scores, count - 1, axis=1)[:, :count]
        return offsets.astype(np.uint64, copy=False)
    return rng.integers(0, child_cell_count, size=(parent_count, count), dtype=np.uint64)


def mixing_field(cells: np.ndarray, order: int) -> np.ndarray:
    nside = 2**order
    face_cell_count = np.uint64(1) << np.uint64(2 * order)
    face = (cells // face_cell_count).astype(np.int64, copy=False)
    local = cells % face_cell_count
    ix, iy = morton_decode(local)
    u = (ix.astype(np.float64) + 0.5) / nside
    v = (iy.astype(np.float64) + 0.5) / nside
    x, y, z = face_uv_to_vector(face, u, v)
    lon = np.arctan2(z, x)
    lat = np.arcsin(np.clip(y, -1.0, 1.0))

    equatorial_jet = np.exp(-((lat - 0.18 * np.sin(3.0 * lon + 0.6)) ** 2) / 0.035)
    northern_band = np.exp(-((lat - 0.72 - 0.05 * np.sin(5.0 * lon)) ** 2) / 0.018)
    southern_band = np.exp(-((lat + 0.58 + 0.08 * np.cos(2.0 * lon)) ** 2) / 0.026)
    plume_a = np.exp(-(angular_delta(lon, 0.7) ** 2 + (lat - 0.22) ** 2) / 0.055)
    plume_b = np.exp(-(angular_delta(lon, -2.25) ** 2 + (lat + 0.38) ** 2) / 0.075)
    dry_slot = np.exp(-(angular_delta(lon, 2.35) ** 2 + (lat - 0.08) ** 2) / 0.040)
    waves = 0.08 * np.sin(7.0 * lon + 2.5 * np.sin(2.0 * lat))
    filaments = 0.045 * np.sin(17.0 * lon + 11.0 * x * z) * np.cos(5.0 * lat)

    value = (
        0.32
        + 0.20 * equatorial_jet
        + 0.17 * northern_band
        + 0.14 * southern_band
        + 0.22 * plume_a
        + 0.18 * plume_b
        - 0.16 * dry_slot
        + waves
        + filaments
        + 0.07 * y
    )
    return np.clip(value, 0.0, 1.0)


def face_uv_to_vector(
    face: np.ndarray, u: np.ndarray, v: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ring_norm = np.clip(FACE_RING_ANCHORS[face] - u - v, 0.0, 4.0)
    raw_norm = FACE_PHI_ANCHORS[face] - u + v
    phi_raw = phi_raw_from_grid_norm(raw_norm, ring_norm)
    phi = np.mod(phi_raw * np.pi / 4.0, 2.0 * np.pi)
    height = height_from_ring_norm(ring_norm)
    horizontal = np.sqrt(np.maximum(0.0, 1.0 - height * height))
    return np.cos(phi) * horizontal, height, np.sin(phi) * horizontal


def height_from_ring_norm(ring_norm: np.ndarray) -> np.ndarray:
    north = 1.0 - ring_norm * ring_norm / 3.0
    equator = ((2.0 - ring_norm) * 2.0) / 3.0
    mirror = 4.0 - ring_norm
    south = -1.0 + mirror * mirror / 3.0
    return np.where(ring_norm <= 1.0, north, np.where(ring_norm <= 3.0, equator, south))


def phi_raw_from_grid_norm(raw_norm: np.ndarray, ring_norm: np.ndarray) -> np.ndarray:
    anchor = nearest_polar_anchor_norm(raw_norm)
    north = anchor + (raw_norm - anchor) / np.maximum(ring_norm, 1e-6)
    south = anchor + (raw_norm - anchor) / np.maximum(4.0 - ring_norm, 1e-6)
    return np.where(ring_norm < 1.0, north, np.where(ring_norm > 3.0, south, raw_norm))


def nearest_polar_anchor_norm(raw_norm: np.ndarray) -> np.ndarray:
    anchors = np.array([1.0, 3.0, 5.0, 7.0], dtype=np.float64)[:, None]
    expanded = raw_norm[None, :]
    candidates = anchors + np.round((expanded - anchors) / 8.0) * 8.0
    distances = np.abs(expanded - candidates)
    best = np.argmin(distances, axis=0)
    return np.take_along_axis(candidates, best[None, :], axis=0)[0]


def angular_delta(angle: np.ndarray, center: float) -> np.ndarray:
    return np.arctan2(np.sin(angle - center), np.cos(angle - center))


if __name__ == "__main__":
    main()
