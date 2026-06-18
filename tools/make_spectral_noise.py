#!/usr/bin/env python3
"""Generate a spherical spectral-noise hpxmap-v1 dataset.

The field is a deterministic octave sum of 3D value-noise bands sampled on the
unit sphere. Each order limits the highest octave to that order's nominal
Nyquist scale, so parent tiles stay smoother and higher orders reveal detail.
The octave band amplitudes are chosen so the per-octave energy follows the
integral of E(k) proportional to k^-5/3.
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
HASH_MASK = np.uint64((1 << 53) - 1)
HASH_SCALE = 1.0 / float(1 << 52)
UINT64_MASK = (1 << 64) - 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--nside", type=int, default=2048)
    parser.add_argument("--min-order", type=int, default=8)
    parser.add_argument("--tile-size", type=int, default=256)
    parser.add_argument("--seed", type=int, default=20260618)
    parser.add_argument("--spectrum-slope", type=float, default=-5 / 3)
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
        order_min, order_max, order_samples = write_order(
            layer_dir=layer_dir,
            order=order,
            tile_shift=tile_shift,
            tile_size=args.tile_size,
            seed=args.seed,
            spectrum_slope=args.spectrum_slope,
        )
        all_min = min(all_min, order_min)
        all_max = max(all_max, order_max)
        samples_for_percentile.append(order_samples)
        print(f"order {order}: min={order_min:.6f} max={order_max:.6f}")

    percentile_source = np.concatenate(samples_for_percentile)
    p1, p50, p99 = np.percentile(percentile_source, [1, 50, 99])

    manifest = {
        "schema": "hpxmap-v1",
        "name": f"spectral-noise-n{args.nside}",
        "ordering": "nested",
        "minOrder": args.min_order,
        "maxOrder": max_order,
        "nside": args.nside,
        "tileShift": tile_shift,
        "tileSize": args.tile_size,
        "tileLayout": "face-local-row-major",
        "description": "Deterministic spherical octave noise with energy spectrum E(k) proportional to k^-5/3.",
        "defaultView": {
            "mode": "net",
            "layer": "value",
            "order": max_order,
            "scale": "symlog",
            "colormap": "turbo",
        },
        "layers": [
            {
                "id": "value",
                "title": "Spectral noise",
                "kind": "scalar",
                "dtype": "float32",
                "unit": "",
                "nodata": "nan",
                "aggregation": "sphere-value-noise-octaves",
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
        "sources": [
            {
                "title": "Procedural spherical spectral noise",
                "spectrum": f"E(k) proportional to k^{args.spectrum_slope:g}",
                "seed": int(args.seed),
                "note": "3D value-noise octave bands sampled on the unit sphere; octave amplitude is k^-1/3 for E(k) proportional to k^-5/3, and max octave is limited per order to avoid low-order aliasing.",
            }
        ],
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output / 'manifest.json'}")


def write_order(
    layer_dir: Path,
    order: int,
    tile_shift: int,
    tile_size: int,
    seed: int,
    spectrum_slope: float,
) -> tuple[float, float, np.ndarray]:
    nside = 2**order
    grid = max(1, 2 ** max(0, order - tile_shift))
    order_min = math.inf
    order_max = -math.inf
    samples = []

    local = (np.arange(tile_size, dtype=np.float64) + 0.5) / nside
    max_octave = max(0, order - 1)

    for face in range(12):
        for y in range(grid):
            tile_v = y * tile_size / nside + local
            for x in range(grid):
                tile_u = x * tile_size / nside + local
                uu, vv = np.meshgrid(tile_u, tile_v)
                values = spectral_noise_value(
                    face=face,
                    u=uu,
                    v=vv,
                    max_octave=max_octave,
                    seed=seed,
                    spectrum_slope=spectrum_slope,
                ).astype("<f4", copy=False)
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


def spectral_noise_value(
    face: int,
    u: np.ndarray,
    v: np.ndarray,
    max_octave: int,
    seed: int,
    spectrum_slope: float,
) -> np.ndarray:
    x, y, z = face_uv_to_vector(face, u, v)
    values = np.zeros_like(x, dtype=np.float64)
    variance = 0.0

    for octave in range(max_octave + 1):
        frequency = 2**octave
        amplitude = frequency ** ((spectrum_slope + 1.0) * 0.5)
        band = value_noise3(x, y, z, frequency=frequency, seed=seed + octave * 7919)
        values += amplitude * band
        variance += amplitude * amplitude

    if variance > 0:
        values /= math.sqrt(variance)
    return values


def value_noise3(
    x: np.ndarray,
    y: np.ndarray,
    z: np.ndarray,
    frequency: int,
    seed: int,
) -> np.ndarray:
    px = x * frequency + 31.416
    py = y * frequency + 47.853
    pz = z * frequency + 59.271
    ix = np.floor(px).astype(np.int64)
    iy = np.floor(py).astype(np.int64)
    iz = np.floor(pz).astype(np.int64)
    fx = smoothstep(px - ix)
    fy = smoothstep(py - iy)
    fz = smoothstep(pz - iz)

    c000 = lattice_value(ix, iy, iz, seed)
    c100 = lattice_value(ix + 1, iy, iz, seed)
    c010 = lattice_value(ix, iy + 1, iz, seed)
    c110 = lattice_value(ix + 1, iy + 1, iz, seed)
    c001 = lattice_value(ix, iy, iz + 1, seed)
    c101 = lattice_value(ix + 1, iy, iz + 1, seed)
    c011 = lattice_value(ix, iy + 1, iz + 1, seed)
    c111 = lattice_value(ix + 1, iy + 1, iz + 1, seed)

    x00 = lerp(c000, c100, fx)
    x10 = lerp(c010, c110, fx)
    x01 = lerp(c001, c101, fx)
    x11 = lerp(c011, c111, fx)
    y0 = lerp(x00, x10, fy)
    y1 = lerp(x01, x11, fy)
    return lerp(y0, y1, fz)


def lattice_value(ix: np.ndarray, iy: np.ndarray, iz: np.ndarray, seed: int) -> np.ndarray:
    h = ix.astype(np.uint64) * np.uint64(0x9E3779B185EBCA87)
    h ^= iy.astype(np.uint64) * np.uint64(0xC2B2AE3D27D4EB4F)
    h ^= iz.astype(np.uint64) * np.uint64(0x165667B19E3779F9)
    h ^= np.uint64((int(seed) * 0x85EBCA77C2B2AE63) & UINT64_MASK)
    h ^= h >> np.uint64(33)
    h *= np.uint64(0xFF51AFD7ED558CCD)
    h ^= h >> np.uint64(33)
    h *= np.uint64(0xC4CEB9FE1A85EC53)
    h ^= h >> np.uint64(33)
    return ((h & HASH_MASK).astype(np.float64) * HASH_SCALE) - 1.0


def smoothstep(t: np.ndarray) -> np.ndarray:
    return t * t * t * (t * (t * 6 - 15) + 10)


def lerp(a: np.ndarray, b: np.ndarray, t: np.ndarray) -> np.ndarray:
    return a + (b - a) * t


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
