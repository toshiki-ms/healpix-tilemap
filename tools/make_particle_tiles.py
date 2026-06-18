#!/usr/bin/env python3
"""Build an hpxmap-v1 sparse tile pyramid from HEALPix-indexed particles.

The input is a Zarr v3 group with a one-dimensional particle cell array and an
optional one-dimensional value array. Cells must be global NESTED ids at
--particle-order. The converter aggregates particles directly into tile arrays
for each output order and does not build a dense full-sky map.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path
from typing import Any

import numpy as np

from make_hpx_tiles import morton_decode


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path, help="Zarr v3 group containing particle arrays.")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--title", default=None)
    parser.add_argument("--description", default=None)
    parser.add_argument("--layer-id", default="value")
    parser.add_argument("--layer-title", default="Particle value")
    parser.add_argument("--unit", default="")
    parser.add_argument("--cell-array", default="cell", help="Array containing global NESTED cell ids.")
    parser.add_argument("--value-array", default=None, help="Particle value array. Omit for count aggregation.")
    parser.add_argument("--aggregation", choices=["mean", "sum", "count"], default="mean")
    parser.add_argument("--particle-order", required=True, type=int)
    parser.add_argument("--target-particles-per-cell", type=float, default=1.0)
    parser.add_argument("--min-order", type=int, default=None)
    parser.add_argument("--max-order", type=int, default=None)
    parser.add_argument("--tile-size", type=int, default=256)
    parser.add_argument("--chunk-size", type=int, default=2_000_000)
    parser.add_argument("--default-view", choices=["net", "globe"], default="globe")
    parser.add_argument("--colormap", default="viridis")
    parser.add_argument("--scale", choices=["linear", "log", "symlog"], default="linear")
    parser.add_argument("--body-name", default=None, help="Optional physical body name for globe scale bars.")
    parser.add_argument("--body-radius-km", type=float, default=None, help="Optional body mean radius in kilometers.")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.aggregation in {"mean", "sum"} and args.value_array is None:
        raise SystemExit(f"--value-array is required for --aggregation {args.aggregation}")
    if args.aggregation == "count" and args.value_array is not None:
        print("--value-array is ignored for --aggregation count")

    root = open_zarr_group(args.input)
    cells = open_zarr_array(root, args.cell_array)
    values = open_zarr_array(root, args.value_array) if args.value_array else None
    particle_count = validate_particle_arrays(cells, values)

    tile_shift = int(round(math.log2(args.tile_size)))
    if 2**tile_shift != args.tile_size:
        raise SystemExit("--tile-size must be a power of two")
    if args.particle_order < tile_shift:
        raise SystemExit("--particle-order must be >= log2(tile-size)")

    min_order = args.min_order if args.min_order is not None else tile_shift
    max_order = args.max_order if args.max_order is not None else automatic_max_order(
        particle_count,
        args.particle_order,
        tile_shift,
        args.target_particles_per_cell,
    )
    if min_order < tile_shift:
        raise SystemExit("--min-order must be >= log2(tile-size)")
    if max_order > args.particle_order:
        raise SystemExit("--max-order cannot exceed --particle-order")
    if min_order > max_order:
        raise SystemExit("--min-order must be <= --max-order")

    if args.output.exists() and args.force:
        shutil.rmtree(args.output)
    args.output.mkdir(parents=True, exist_ok=True)
    layer_dir = args.output / "layers" / args.layer_id
    layer_dir.mkdir(parents=True, exist_ok=True)

    all_min = math.inf
    all_max = -math.inf
    percentile_samples: list[np.ndarray] = []
    written_total = 0

    for order in range(min_order, max_order + 1):
        order_min, order_max, samples, written = write_particle_order(
            layer_dir=layer_dir,
            cells=cells,
            values=values,
            order=order,
            particle_order=args.particle_order,
            tile_shift=tile_shift,
            tile_size=args.tile_size,
            chunk_size=args.chunk_size,
            aggregation=args.aggregation,
        )
        all_min = min(all_min, order_min)
        all_max = max(all_max, order_max)
        if samples.size:
            percentile_samples.append(samples)
        written_total += written
        print(f"order {order}: wrote={written} min={order_min:.6g} max={order_max:.6g}")

    if not percentile_samples:
        raise SystemExit("no finite particle aggregate values were produced")
    p_source = np.concatenate(percentile_samples)
    p1, p50, p99 = np.percentile(p_source, [1, 50, 99])
    empty_value: float | str = 0.0 if args.aggregation in {"count", "sum"} else "nan"

    layer = {
        "id": args.layer_id,
        "title": args.layer_title,
        "kind": "scalar",
        "dtype": "float32",
        "unit": args.unit,
        "nodata": "nan",
        "emptyValue": empty_value,
        "aggregation": f"particle-{args.aggregation}",
        "source": {
            "type": "directory",
            "sparse": True,
            "template": f"layers/{args.layer_id}/o{{order}}/f{{face}}/x{{x}}/y{{y}}.bin",
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

    manifest = {
        "schema": "hpxmap-v1",
        "name": args.dataset_id,
        "ordering": "nested",
        "minOrder": min_order,
        "maxOrder": max_order,
        "nside": 2**max_order,
        "tileShift": tile_shift,
        "tileSize": args.tile_size,
        "tileLayout": "face-local-row-major",
        "description": args.description or f"{args.dataset_id} built from HEALPix-indexed particles",
        "defaultView": {
            "mode": args.default_view,
            "layer": args.layer_id,
            "order": max_order,
            "scale": args.scale,
            "colormap": args.colormap,
        },
        "layers": [layer],
        "sources": [
            {
                "title": args.title or args.dataset_id,
                "asset": str(args.input),
                "inputLayout": "particle-cells-nested",
                "cellArray": args.cell_array,
                "valueArray": args.value_array,
                "particleOrder": args.particle_order,
                "particleCount": int(particle_count),
                "targetParticlesPerCell": args.target_particles_per_cell,
                "writtenTileCount": int(written_total),
                "note": "Sparse particle aggregate tiles; missing sparse tiles are interpreted as empty.",
            }
        ],
    }
    body = body_metadata(args.body_name, args.body_radius_km)
    if body:
        manifest["body"] = body
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output / 'manifest.json'}")


def body_metadata(name: str | None, radius_km: float | None) -> dict[str, object] | None:
    if radius_km is None and not name:
        return None
    body: dict[str, object] = {}
    if name:
        body["name"] = name
    if radius_km is not None:
        if not math.isfinite(radius_km) or radius_km <= 0:
            raise SystemExit("--body-radius-km must be a positive finite number")
        body["radiusKm"] = float(radius_km)
    return body


def open_zarr_group(path: Path) -> Any:
    try:
        import zarr
    except ImportError as exc:
        raise SystemExit("zarr>=3 is required for particle input; install python[array] or python[all].") from exc
    root = zarr.open_group(path, mode="r")
    return root


def open_zarr_array(root: Any, name: str | None) -> Any:
    if name is None:
        return None
    try:
        array = root[name]
    except KeyError as exc:
        raise SystemExit(f"Zarr array {name!r} was not found") from exc
    if not hasattr(array, "shape"):
        raise SystemExit(f"Zarr path {name!r} is a group, not an array")
    return array


def validate_particle_arrays(cells: Any, values: Any | None) -> int:
    if len(cells.shape) != 1:
        raise SystemExit(f"cell array must be one-dimensional, got shape {cells.shape}")
    particle_count = int(cells.shape[0])
    if values is not None:
        if len(values.shape) != 1:
            raise SystemExit(f"value array must be one-dimensional, got shape {values.shape}")
        if int(values.shape[0]) != particle_count:
            raise SystemExit(f"value array has {values.shape[0]} entries, expected {particle_count}")
    return particle_count


def automatic_max_order(
    particle_count: int,
    particle_order: int,
    tile_shift: int,
    target_particles_per_cell: float,
) -> int:
    if target_particles_per_cell <= 0:
        raise SystemExit("--target-particles-per-cell must be positive")
    if particle_count <= 0:
        return tile_shift
    target_cells = particle_count / target_particles_per_cell
    order = max(0, math.ceil(math.log(max(1.0, target_cells / 12.0), 4)))
    return min(particle_order, max(tile_shift, int(order)))


def write_particle_order(
    *,
    layer_dir: Path,
    cells: Any,
    values: Any | None,
    order: int,
    particle_order: int,
    tile_shift: int,
    tile_size: int,
    chunk_size: int,
    aggregation: str,
) -> tuple[float, float, np.ndarray, int]:
    tile_accumulators: dict[int, TileAccumulator] = {}
    particle_count = int(cells.shape[0])
    max_cell = np.uint64(12) * (np.uint64(1) << np.uint64(2 * particle_order))
    shift = np.uint64(2 * (particle_order - order))
    grid = 2 ** max(0, order - tile_shift)
    face_cell_count = np.uint64(1) << np.uint64(2 * order)
    local_mask = tile_size - 1

    for start in range(0, particle_count, chunk_size):
        stop = min(particle_count, start + chunk_size)
        chunk_cells = np.asarray(cells[start:stop], dtype=np.uint64)
        valid = chunk_cells < max_cell
        if values is not None:
            chunk_values = np.asarray(values[start:stop], dtype=np.float32)
            valid &= np.isfinite(chunk_values)
        else:
            chunk_values = None
        if not np.any(valid):
            continue
        chunk_cells = chunk_cells[valid]
        if chunk_values is not None:
            chunk_values = chunk_values[valid]

        parent = chunk_cells >> shift
        face = (parent // face_cell_count).astype(np.int64, copy=False)
        local = parent % face_cell_count
        ix, iy = morton_decode(local)
        tile_x = ix >> tile_shift
        tile_y = iy >> tile_shift
        local_index = ((iy & local_mask) * tile_size + (ix & local_mask)).astype(np.intp, copy=False)
        tile_code = ((face * grid + tile_y) * grid + tile_x).astype(np.int64, copy=False)
        add_chunk(
            tile_accumulators=tile_accumulators,
            tile_code=tile_code,
            local_index=local_index,
            values=chunk_values,
            tile_cell_count=tile_size * tile_size,
            aggregation=aggregation,
        )

    order_min = math.inf
    order_max = -math.inf
    samples = []
    for code, accumulator in sorted(tile_accumulators.items()):
        tile = accumulator.to_tile(aggregation)
        face, x, y = decode_tile_code(code, grid)
        out_dir = layer_dir / f"o{order}" / f"f{face}" / f"x{x}"
        out_dir.mkdir(parents=True, exist_ok=True)
        np.asarray(tile, dtype="<f4").tofile(out_dir / f"y{y}.bin")
        finite = tile[np.isfinite(tile)]
        if finite.size:
            order_min = min(order_min, float(finite.min()))
            order_max = max(order_max, float(finite.max()))
            stride = max(1, finite.size // 2048)
            samples.append(finite[::stride].astype(np.float64))

    if not math.isfinite(order_min):
        order_min = math.nan
        order_max = math.nan
    return order_min, order_max, np.concatenate(samples) if samples else np.array([], dtype=np.float64), len(tile_accumulators)


def add_chunk(
    *,
    tile_accumulators: dict[int, "TileAccumulator"],
    tile_code: np.ndarray,
    local_index: np.ndarray,
    values: np.ndarray | None,
    tile_cell_count: int,
    aggregation: str,
) -> None:
    order = np.argsort(tile_code, kind="stable")
    sorted_codes = tile_code[order]
    cuts = np.flatnonzero(sorted_codes[1:] != sorted_codes[:-1]) + 1
    starts = np.concatenate(([0], cuts))
    stops = np.concatenate((cuts, [sorted_codes.size]))
    for begin, end in zip(starts, stops):
        code = int(sorted_codes[begin])
        accumulator = tile_accumulators.get(code)
        if accumulator is None:
            accumulator = TileAccumulator(tile_cell_count, needs_count=aggregation in {"mean", "count"})
            tile_accumulators[code] = accumulator
        indices = local_index[order[begin:end]]
        if aggregation == "count":
            accumulator.count += np.bincount(indices, minlength=tile_cell_count).astype(np.uint32)
            continue
        weights = values[order[begin:end]] if values is not None else np.ones(end - begin, dtype=np.float32)
        accumulator.sum += np.bincount(indices, weights=weights, minlength=tile_cell_count).astype(np.float64)
        if aggregation == "mean":
            accumulator.count += np.bincount(indices, minlength=tile_cell_count).astype(np.uint32)


class TileAccumulator:
    def __init__(self, tile_cell_count: int, *, needs_count: bool) -> None:
        self.sum = np.zeros(tile_cell_count, dtype=np.float64)
        self.count = np.zeros(tile_cell_count, dtype=np.uint32) if needs_count else None

    def to_tile(self, aggregation: str) -> np.ndarray:
        if aggregation == "mean":
            assert self.count is not None
            tile = np.full(self.sum.shape, np.nan, dtype=np.float32)
            nonempty = self.count > 0
            tile[nonempty] = (self.sum[nonempty] / self.count[nonempty]).astype(np.float32)
            return tile
        if aggregation == "count":
            assert self.count is not None
            return self.count.astype(np.float32)
        return self.sum.astype(np.float32)


def decode_tile_code(code: int, grid: int) -> tuple[int, int, int]:
    x = code % grid
    row = code // grid
    y = row % grid
    face = row // grid
    return face, x, y


if __name__ == "__main__":
    main()
