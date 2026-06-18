#!/usr/bin/env python3
"""Generate a spherical-harmonic spectral-noise hpxmap-v1 dataset.

This generator draws real scalar alm coefficients and fixes the realized
per-degree energy

    E_l = |a_l0|^2 + 2 * sum_{m=1..l} |a_lm|^2

to be proportional to l^-5/3. In healpy's angular power convention this means
C_l = E_l / (2l + 1). The output pyramid is low-pass by order: each order uses
the same alm realization truncated to that order's lmax.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path

import healpy as hp
import numpy as np

FACE_RING_ANCHORS = np.array([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], dtype=np.float64)
FACE_PHI_ANCHORS = np.array([1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7], dtype=np.float64)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--nside", type=int, default=2048)
    parser.add_argument("--min-order", type=int, default=8)
    parser.add_argument("--tile-size", type=int, default=256)
    parser.add_argument("--seed", type=int, default=20260618)
    parser.add_argument("--spectrum-slope", type=float, default=-5 / 3)
    parser.add_argument("--lmin", type=int, default=2)
    parser.add_argument("--lmax", type=int, default=None)
    parser.add_argument("--lmax-factor", type=float, default=1.0)
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

    lmax = args.lmax if args.lmax is not None else int(round(args.nside * args.lmax_factor))
    lmax = min(max(args.lmin, lmax), 3 * args.nside - 1)
    if args.lmin < 1 or args.lmin > lmax:
        raise SystemExit("--lmin must be in [1, lmax]")

    if args.output.exists() and args.force:
        shutil.rmtree(args.output)
    args.output.mkdir(parents=True, exist_ok=True)

    layer_dir = args.output / "layers" / "value"
    layer_dir.mkdir(parents=True, exist_ok=True)

    print(f"generating alm: lmin={args.lmin} lmax={lmax} slope={args.spectrum_slope:g}")
    alm = make_fixed_energy_alm(
        lmax=lmax,
        lmin=args.lmin,
        spectrum_slope=args.spectrum_slope,
        seed=args.seed,
    )

    all_min = math.inf
    all_max = -math.inf
    samples_for_percentile: list[np.ndarray] = []
    order_lmax: dict[int, int] = {}

    for order in range(args.min_order, max_order + 1):
        nside = 2**order
        local_lmax = min(lmax, int(round(nside * args.lmax_factor)), 3 * nside - 1)
        order_lmax[order] = local_lmax
        order_alm = hp.resize_alm(alm, lmax, lmax, local_lmax, local_lmax)
        print(f"alm2map order {order}: nside={nside} lmax={local_lmax}")
        ring_map = hp.alm2map(order_alm, nside, lmax=local_lmax, mmax=local_lmax, pol=False)
        ring_map = np.asarray(ring_map, dtype=np.float32)
        order_min, order_max, order_samples = write_order_from_map(
            layer_dir=layer_dir,
            order=order,
            tile_shift=tile_shift,
            tile_size=args.tile_size,
            ring_map=ring_map,
        )
        del ring_map, order_alm
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
        "description": "Deterministic scalar spherical-harmonic random field with degree energy E_l proportional to l^-5/3.",
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
                "title": "Spherical harmonic noise",
                "kind": "scalar",
                "dtype": "float32",
                "unit": "",
                "nodata": "nan",
                "aggregation": "spherical-harmonic-synthesis",
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
                "title": "Procedural scalar spherical-harmonic random field",
                "spectrum": f"E_l = sum_m |a_lm|^2 proportional to l^{args.spectrum_slope:g}",
                "angularPowerConvention": "C_l = E_l / (2l + 1)",
                "lmin": int(args.lmin),
                "lmax": int(lmax),
                "orderLmax": {str(order): int(value) for order, value in order_lmax.items()},
                "seed": int(args.seed),
                "note": "The same fixed-energy alm realization is truncated per order; tiles are sampled from healpy alm2map output onto the viewer face-local grid.",
            }
        ],
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output / 'manifest.json'}")


def make_fixed_energy_alm(lmax: int, lmin: int, spectrum_slope: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    size = hp.Alm.getsize(lmax, lmax)
    ell, emm = hp.Alm.getlm(lmax, np.arange(size))
    real = rng.normal(size=size)
    imag = rng.normal(size=size)
    imag[emm == 0] = 0.0
    alm = real + 1j * imag
    alm[ell < lmin] = 0.0

    weights = np.abs(alm) ** 2
    weights = np.where(emm == 0, weights, 2.0 * weights)
    realized = np.bincount(ell, weights=weights, minlength=lmax + 1)

    target_energy = np.zeros(lmax + 1, dtype=np.float64)
    degrees = np.arange(lmin, lmax + 1, dtype=np.float64)
    unnormalized = degrees ** spectrum_slope
    variance = float(np.sum(unnormalized) / (4.0 * math.pi))
    target_energy[lmin:] = unnormalized / variance

    scale = np.zeros(lmax + 1, dtype=np.float64)
    valid = realized > 0
    scale[valid] = np.sqrt(target_energy[valid] / realized[valid])
    alm *= scale[ell]
    return alm


def write_order_from_map(
    layer_dir: Path,
    order: int,
    tile_shift: int,
    tile_size: int,
    ring_map: np.ndarray,
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
                theta, phi = face_uv_to_healpy_angles(face, uu, vv)
                values = hp.get_interp_val(ring_map, theta, phi, nest=False).astype("<f4", copy=False)
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


def face_uv_to_healpy_angles(face: int, u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    x, y, z = face_uv_to_vector(face, u, v)
    theta = np.arccos(np.clip(y, -1.0, 1.0))
    phi = np.mod(np.arctan2(z, x), 2.0 * np.pi)
    return theta, phi


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
