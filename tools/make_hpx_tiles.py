#!/usr/bin/env python3
"""Convert a full-sky HEALPix scalar array into an hpxmap-v1 tile pyramid.

Supported inputs:

- Zarr v3 root arrays or groups. For groups, select the variable with --array.
- NumPy .npy/.npz or raw binary inputs for smaller and legacy workflows.

The preferred Zarr array layout is
(12 * nside_block**2, (nside / nside_block)**2). The first axis is the global
HEALPix NESTED block id at the block order, and the second axis is the local
NESTED subcell id inside that block. Extra axes such as time must be selected
with --select before conversion.

Output tiles always use the viewer layout: face-local row-major scalar tiles at
layers/{layer}/o{order}/f{face}/x{x}/y{y}.bin.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path
from typing import Any, Iterable

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--title", default=None)
    parser.add_argument("--description", default=None)
    parser.add_argument("--layer-id", default="value")
    parser.add_argument("--layer-title", default="Value")
    parser.add_argument("--unit", default="")
    parser.add_argument("--ordering", choices=["nested", "ring"], default="nested")
    parser.add_argument("--array", default=None, help="Array path for Zarr groups or .npz archives")
    parser.add_argument(
        "--dims",
        default=None,
        help="Comma-separated dimension names when the input array has no stored names, e.g. time,block,cell",
    )
    parser.add_argument(
        "--select",
        action="append",
        default=[],
        metavar="DIM=INDEX",
        help="Select one non-HEALPix axis before conversion, e.g. --select time=0. Repeatable.",
    )
    parser.add_argument("--dtype", default="float32", help="Input dtype for raw binary inputs")
    parser.add_argument("--nside", type=int, default=None, help="Required for ambiguous raw inputs; otherwise inferred")
    parser.add_argument(
        "--nside-block",
        type=int,
        default=None,
        help="Blocks per base-face side for block/cell inputs; inferred from the block axis when omitted.",
    )
    parser.add_argument(
        "--block-order",
        type=int,
        default=None,
        help="HEALPix order of the block axis for block/cell inputs; equivalent to --nside-block 2**order.",
    )
    parser.add_argument("--min-order", type=int, default=None)
    parser.add_argument("--max-order", type=int, default=None)
    parser.add_argument("--tile-size", type=int, default=256)
    parser.add_argument("--default-view", choices=["net", "globe"], default="globe")
    parser.add_argument("--colormap", default="viridis")
    parser.add_argument("--scale", choices=["linear", "log", "symlog"], default="linear")
    parser.add_argument("--tile-dtype", choices=["float32", "uint16", "int16"], default="float32")
    parser.add_argument("--quantize-min", type=float, default=None)
    parser.add_argument("--quantize-max", type=float, default=None)
    parser.add_argument("--quantize-step", type=float, default=None)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    values = load_input(args.input, args.array, args.dtype)
    dims = dimension_names(values, args.dims)
    selected, selected_dims = apply_selectors(values, dims, parse_selectors(args.select))
    nested, input_nside, input_layout, input_layout_metadata = to_face_grid(
        selected,
        explicit_nside=args.nside,
        explicit_nside_block=args.nside_block,
        explicit_block_order=args.block_order,
        ordering=args.ordering,
        dims=selected_dims,
    )
    input_order = int(round(math.log2(input_nside)))
    tile_shift = int(round(math.log2(args.tile_size)))
    if 2**tile_shift != args.tile_size:
        raise SystemExit("--tile-size must be a power of two")

    min_order = args.min_order if args.min_order is not None else max(tile_shift, input_order - 2)
    max_order = args.max_order if args.max_order is not None else input_order
    if min_order < tile_shift:
        raise SystemExit("--min-order must be >= log2(tile-size)")
    if min_order > max_order:
        raise SystemExit("--min-order must be <= max-order")
    if max_order > input_order:
        raise SystemExit("--max-order cannot exceed the input nside order")

    encoding = make_encoding(
        args.tile_dtype,
        nested,
        quantize_min=args.quantize_min,
        quantize_max=args.quantize_max,
        quantize_step=args.quantize_step,
    )

    if args.output.exists() and args.force:
        shutil.rmtree(args.output)
    args.output.mkdir(parents=True, exist_ok=True)

    layer_dir = args.output / "layers" / args.layer_id
    layer_dir.mkdir(parents=True, exist_ok=True)

    all_min = math.inf
    all_max = -math.inf
    percentile_samples: list[np.ndarray] = []

    for order in range(min_order, max_order + 1):
        order_values = nested_for_order(nested, input_order, order)
        order_min, order_max, samples = write_order(
            layer_dir=layer_dir,
            values=order_values,
            order=order,
            tile_shift=tile_shift,
            tile_size=args.tile_size,
            encoding=encoding,
        )
        all_min = min(all_min, order_min)
        all_max = max(all_max, order_max)
        percentile_samples.append(samples)
        print(f"order {order}: min={order_min:.6g} max={order_max:.6g}")

    p_source = np.concatenate(percentile_samples)
    p1, p50, p99 = np.percentile(p_source, [1, 50, 99])
    layer = {
        "id": args.layer_id,
        "title": args.layer_title,
        "kind": "scalar",
        "dtype": encoding["dtype"],
        "unit": args.unit,
        "nodata": encoding["nodata"],
        "aggregation": "mean-downsample" if min_order < max_order else "direct-sample",
        "source": {
            "type": "directory",
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
    if encoding["dtype"] != "float32":
        layer["quantization"] = {
            "scale": encoding["scale"],
            "offset": encoding["offset"],
            "nodata": encoding["nodata"],
        }

    source = {
        "title": args.title or args.dataset_id,
        "asset": str(args.input),
        "inputOrdering": args.ordering,
        "inputLayout": input_layout,
        "inputArray": args.array,
        "inputSelection": args.select,
        "inputNside": input_nside,
        "note": "Converted from a full-sky HEALPix scalar array. Coarser orders are block-mean downsampled in face-local space.",
    }
    source.update(input_layout_metadata)

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
        "description": args.description or f"{args.dataset_id} converted from {args.input}",
        "defaultView": {
            "mode": args.default_view,
            "layer": args.layer_id,
            "order": max_order,
            "scale": args.scale,
            "colormap": args.colormap,
        },
        "layers": [layer],
        "sources": [source],
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output / 'manifest.json'}")


def load_input(path: Path, array_name: str | None, dtype: str) -> Any:
    if is_zarr_store(path):
        return open_zarr_array(path, array_name)
    if path.suffix == ".npy":
        return np.load(path, mmap_mode="r")
    if path.suffix == ".npz":
        archive = np.load(path)
        if array_name is None:
            keys = list(archive.keys())
            if len(keys) != 1:
                raise SystemExit(f"--array is required for {path}; arrays: {', '.join(keys)}")
            array_name = keys[0]
        return archive[array_name]
    return np.fromfile(path, dtype=np.dtype(dtype))


def is_zarr_store(path: Path) -> bool:
    return path.suffix == ".zarr" or (path.is_dir() and (path / "zarr.json").exists())


def open_zarr_array(path: Path, array_name: str | None) -> Any:
    try:
        import zarr
    except ImportError as exc:
        raise SystemExit("zarr>=3 is required for Zarr input; install python[array] or python[all].") from exc

    root = zarr.open(path, mode="r")
    if hasattr(root, "shape"):
        if array_name is not None:
            raise SystemExit("--array is only valid when --input is a Zarr group, not a root array")
        return root

    if array_name is None:
        keys = sorted(str(key) for key in root.array_keys())
        if len(keys) != 1:
            shown = ", ".join(keys) if keys else "none at the group root"
            raise SystemExit(f"--array is required for Zarr group {path}; root arrays: {shown}")
        array_name = keys[0]
    try:
        array = root[array_name]
    except KeyError as exc:
        raise SystemExit(f"Zarr array {array_name!r} was not found in {path}") from exc
    if not hasattr(array, "shape"):
        raise SystemExit(f"Zarr path {array_name!r} is a group, not an array")
    return array


def dimension_names(values: Any, dims_arg: str | None) -> list[str] | None:
    shape = array_shape(values)
    if dims_arg:
        dims = [item.strip() for item in dims_arg.split(",") if item.strip()]
        if len(dims) != len(shape):
            raise SystemExit(f"--dims has {len(dims)} names but input has {len(shape)} dimensions")
        return dims

    metadata = getattr(values, "metadata", None)
    metadata_names = getattr(metadata, "dimension_names", None)
    if metadata_names is not None:
        dims = [str(item) for item in metadata_names]
        if len(dims) == len(shape):
            return dims

    attrs = getattr(values, "attrs", None)
    if attrs is not None:
        for key in ("_ARRAY_DIMENSIONS", "dimension_names", "dims"):
            names = attrs.get(key)
            if names is None:
                continue
            dims = [str(item) for item in names]
            if len(dims) == len(shape):
                return dims
    return None


def parse_selectors(select_args: Iterable[str]) -> list[tuple[str, int]]:
    selectors = []
    for raw in select_args:
        if "=" not in raw:
            raise SystemExit(f"--select must use DIM=INDEX syntax, got {raw!r}")
        dim, index_text = raw.split("=", 1)
        dim = dim.strip()
        if not dim:
            raise SystemExit(f"--select has an empty dimension name: {raw!r}")
        try:
            index = int(index_text)
        except ValueError as exc:
            raise SystemExit(f"--select index must be an integer, got {raw!r}") from exc
        selectors.append((dim, index))
    return selectors


def apply_selectors(
    values: Any,
    dims: list[str] | None,
    selectors: list[tuple[str, int]],
) -> tuple[Any, list[str] | None]:
    if not selectors:
        return values, dims

    shape = array_shape(values)
    axis_by_name = {name: axis for axis, name in enumerate(dims or [])}
    indexer: list[int | slice] = [slice(None)] * len(shape)
    selected_axes: set[int] = set()

    for dim, index in selectors:
        if dim in axis_by_name:
            axis = axis_by_name[dim]
        else:
            try:
                axis = int(dim)
            except ValueError as exc:
                if dims is None:
                    raise SystemExit(f"--select {dim}=... needs --dims or a numeric axis") from exc
                raise SystemExit(f"--select dimension {dim!r} was not found in dimensions: {', '.join(dims)}") from exc
        if axis < 0:
            axis += len(shape)
        if axis < 0 or axis >= len(shape):
            raise SystemExit(f"--select axis {axis} is outside input shape {shape}")
        if axis in selected_axes:
            raise SystemExit(f"--select targets axis {axis} more than once")
        axis_size = int(shape[axis])
        if index < 0:
            index += axis_size
        if index < 0 or index >= axis_size:
            raise SystemExit(f"--select {dim} index {index} is outside axis size {axis_size}")
        indexer[axis] = index
        selected_axes.add(axis)

    selected = values[tuple(indexer)]
    selected_dims = None if dims is None else [name for axis, name in enumerate(dims) if axis not in selected_axes]
    return selected, selected_dims


def to_face_grid(
    values: Any,
    *,
    explicit_nside: int | None,
    explicit_nside_block: int | None,
    explicit_block_order: int | None,
    ordering: str,
    dims: list[str] | None,
) -> tuple[np.ndarray, int, str, dict[str, int]]:
    shape = array_shape(values)
    if ordering == "ring":
        input_nside = infer_nside(math.prod(shape), explicit_nside)
        vector = np.asarray(values, dtype=np.float32).reshape(-1)
        nested_vector = ring_to_nested(vector, input_nside)
        return nested_flat_source_to_grid(nested_vector, input_nside), input_nside, "ring-vector", {}

    layout = classify_nested_layout(shape, dims, explicit_nside_block, explicit_block_order)
    if layout.kind == "face-grid":
        input_nside = infer_grid_nside(shape, layout.axes, explicit_nside)
        grid = np.asarray(values, dtype=np.float32)
        grid = np.moveaxis(grid, layout.axes, (0, 1, 2))
        return np.asarray(grid, dtype=np.float32).reshape(12, input_nside, input_nside), input_nside, "face-grid", {}

    if layout.kind == "block-cell":
        input_nside, nside_block, block_order = infer_block_cell_nside(
            shape,
            layout.axes,
            explicit_nside,
            explicit_nside_block,
            explicit_block_order,
        )
        grid = nested_block_cell_source_to_grid(values, input_nside, nside_block, layout.axes)
        return (
            grid,
            input_nside,
            "block-cell-nested",
            {"inputNsideBlock": nside_block, "inputBlockOrder": block_order},
        )

    input_nside = infer_nside(math.prod(shape), explicit_nside)
    return nested_flat_source_to_grid(values, input_nside), input_nside, "flat-nested", {}


class NestedLayout:
    def __init__(self, kind: str, axes: tuple[int, ...] = ()) -> None:
        self.kind = kind
        self.axes = axes


def classify_nested_layout(
    shape: tuple[int, ...],
    dims: list[str] | None,
    explicit_nside_block: int | None,
    explicit_block_order: int | None,
) -> NestedLayout:
    if dims is not None:
        axes = classify_named_axes(shape, dims)
        if axes is not None:
            return axes
        if len(shape) > 1:
            raise SystemExit(
                "input still has unsupported dimensions "
                f"{list(zip(dims, shape))}; pass --select for time/level axes or use --dims with face/cell names"
            )

    if len(shape) == 1:
        return NestedLayout("flat")
    if len(shape) == 2 and looks_like_block_cell_shape(shape, explicit_nside_block, explicit_block_order):
        return NestedLayout("block-cell", (0, 1))
    if len(shape) == 3 and shape[0] == 12 and shape[1] == shape[2]:
        return NestedLayout("face-grid", (0, 1, 2))
    raise SystemExit(
        "unsupported selected input shape "
        f"{shape}; expected flat 12*nside^2, "
        "(12*nside_block^2, (nside/nside_block)^2), or (12, nside, nside). "
        "For extra axes such as time, pass --select."
    )


def classify_named_axes(shape: tuple[int, ...], dims: list[str]) -> NestedLayout | None:
    normalized = [normalize_dim_name(name) for name in dims]
    face_axis = find_axis(normalized, {"face", "hpxface", "healpixface"})
    block_axis = find_axis(normalized, {"block", "hpxblock", "healpixblock", "parent", "parentcell", "coarsecell"})
    cell_axis = find_axis(normalized, {"cell", "pixel", "pix", "hpxcell", "healpixcell", "nested", "nestedid"})
    y_axis = find_axis(normalized, {"y", "iy", "row"})
    x_axis = find_axis(normalized, {"x", "ix", "col", "column"})

    if block_axis is not None and cell_axis is not None:
        axes = {block_axis, cell_axis}
        if len(axes) != 2:
            raise SystemExit("block and cell dimensions must be distinct")
        if len(shape) != 2 or axes != set(range(len(shape))):
            extras = [dims[axis] for axis in range(len(shape)) if axis not in axes]
            raise SystemExit(f"unselected extra dimensions remain: {', '.join(extras)}")
        return NestedLayout("block-cell", (block_axis, cell_axis))

    if face_axis is not None and cell_axis is not None:
        axes = {face_axis, cell_axis}
        if len(axes) != 2:
            raise SystemExit("face and cell dimensions must be distinct")
        if len(shape) != 2 or axes != set(range(len(shape))):
            extras = [dims[axis] for axis in range(len(shape)) if axis not in axes]
            raise SystemExit(f"unselected extra dimensions remain: {', '.join(extras)}")
        return NestedLayout("block-cell", (face_axis, cell_axis))

    if face_axis is not None and y_axis is not None and x_axis is not None:
        axes = {face_axis, y_axis, x_axis}
        if len(axes) != 3:
            raise SystemExit("face, y, and x dimensions must be distinct")
        if len(shape) != 3 or axes != set(range(len(shape))):
            extras = [dims[axis] for axis in range(len(shape)) if axis not in axes]
            raise SystemExit(f"unselected extra dimensions remain: {', '.join(extras)}")
        return NestedLayout("face-grid", (face_axis, y_axis, x_axis))

    return None


def looks_like_block_cell_shape(
    shape: tuple[int, ...],
    explicit_nside_block: int | None,
    explicit_block_order: int | None,
) -> bool:
    if len(shape) != 2:
        return False
    block_count, cell_count = int(shape[0]), int(shape[1])
    try:
        nside_block = infer_nside_block(block_count, explicit_nside_block, explicit_block_order)
        sub_nside = perfect_square_power_of_two(cell_count)
    except ValueError:
        return False
    return nside_block > 0 and sub_nside > 0


def normalize_dim_name(name: str) -> str:
    return "".join(char for char in name.lower() if char.isalnum())


def find_axis(names: list[str], candidates: set[str]) -> int | None:
    for axis, name in enumerate(names):
        if name in candidates:
            return axis
    return None


def array_shape(values: Any) -> tuple[int, ...]:
    shape = getattr(values, "shape", None)
    if shape is None:
        shape = np.asarray(values).shape
    return tuple(int(item) for item in shape)


def infer_grid_nside(
    shape: tuple[int, ...],
    axes: tuple[int, int, int],
    explicit_nside: int | None,
) -> int:
    face_axis, y_axis, x_axis = axes
    if shape[face_axis] != 12:
        raise SystemExit(f"face dimension has size {shape[face_axis]}, expected 12")
    if shape[y_axis] != shape[x_axis]:
        raise SystemExit(f"face grid dimensions must be square, got {shape[y_axis]} x {shape[x_axis]}")
    return validate_nside(int(shape[y_axis]), explicit_nside)


def infer_block_cell_nside(
    shape: tuple[int, ...],
    axes: tuple[int, int],
    explicit_nside: int | None,
    explicit_nside_block: int | None,
    explicit_block_order: int | None,
) -> tuple[int, int, int]:
    block_axis, cell_axis = axes
    try:
        nside_block = infer_nside_block(int(shape[block_axis]), explicit_nside_block, explicit_block_order)
        sub_nside = perfect_square_power_of_two(int(shape[cell_axis]))
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    nside = validate_nside(nside_block * sub_nside, explicit_nside)
    block_order = int(round(math.log2(nside_block)))
    return nside, nside_block, block_order


def infer_nside_block(
    block_count: int,
    explicit_nside_block: int | None,
    explicit_block_order: int | None,
) -> int:
    expected_from_order = None if explicit_block_order is None else 2**explicit_block_order
    if explicit_nside_block is not None:
        validate_nside(explicit_nside_block, None)
    if expected_from_order is not None and explicit_nside_block is not None and expected_from_order != explicit_nside_block:
        raise ValueError(
            f"--block-order {explicit_block_order} implies nside_block={expected_from_order}, "
            f"but --nside-block={explicit_nside_block}"
        )

    nside_block = explicit_nside_block if explicit_nside_block is not None else expected_from_order
    if nside_block is None:
        if block_count % 12 != 0:
            raise ValueError(f"block dimension has size {block_count}, expected 12 * nside_block^2")
        nside_block = perfect_square_power_of_two(block_count // 12)
    expected_block_count = 12 * nside_block * nside_block
    if block_count != expected_block_count:
        raise ValueError(
            f"block dimension has size {block_count}, expected {expected_block_count} for nside_block={nside_block}"
        )
    return nside_block


def perfect_square_power_of_two(value: int) -> int:
    root = int(round(math.sqrt(value)))
    if root * root != value:
        raise ValueError(f"dimension has size {value}, expected a square")
    if root <= 0 or root & (root - 1):
        raise ValueError(f"square root of dimension size must be a power of two, got {root}")
    return root


def infer_nside(value_count: int, explicit_nside: int | None) -> int:
    if explicit_nside is not None:
        expected = 12 * explicit_nside * explicit_nside
        if value_count != expected:
            raise SystemExit(f"input has {value_count} values, expected {expected} for nside={explicit_nside}")
        return explicit_nside
    nside = int(round(math.sqrt(value_count / 12)))
    if 12 * nside * nside != value_count or nside <= 0 or nside & (nside - 1):
        raise SystemExit("cannot infer nside; pass --nside for raw input or check array length")
    return nside


def validate_nside(nside: int, explicit_nside: int | None) -> int:
    if explicit_nside is not None and nside != explicit_nside:
        raise SystemExit(f"input implies nside={nside}, but --nside={explicit_nside}")
    if nside <= 0 or nside & (nside - 1):
        raise SystemExit(f"nside must be a positive power of two, got {nside}")
    return nside


def ring_to_nested(values: np.ndarray, nside: int) -> np.ndarray:
    try:
        import healpy as hp
    except ImportError as exc:
        raise SystemExit("healpy is required for --ordering ring") from exc
    nested_ids = hp.ring2nest(nside, np.arange(values.size, dtype=np.int64))
    nested = np.empty_like(values, dtype=np.float32)
    nested[nested_ids] = values.astype(np.float32, copy=False)
    return nested


def nested_flat_source_to_grid(values: Any, nside: int) -> np.ndarray:
    grid = np.empty((12, nside, nside), dtype=np.float32)
    local_count = nside * nside
    for face in range(12):
        start = face * local_count
        stop = start + local_count
        local_values = np.asarray(values[start:stop], dtype=np.float32).reshape(local_count)
        scatter_nested_face(local_values, grid[face])
    return grid


def nested_block_cell_source_to_grid(values: Any, nside: int, nside_block: int, axes: tuple[int, int]) -> np.ndarray:
    grid = np.empty((12, nside, nside), dtype=np.float32)
    block_count = 12 * nside_block * nside_block
    sub_nside = nside // nside_block
    sub_count = sub_nside * sub_nside
    block_axis, cell_axis = axes

    sub_codes = np.arange(sub_count, dtype=np.uint64)
    sub_ix, sub_iy = morton_decode(sub_codes)
    block_cell_budget = 2_097_152
    block_chunk = max(1, block_cell_budget // sub_count)
    blocks_per_face = nside_block * nside_block

    for block_start in range(0, block_count, block_chunk):
        block_stop = min(block_count, block_start + block_chunk)
        block_values = read_block_cell_chunk(values, block_start, block_stop, block_axis, cell_axis, sub_count)
        block_ids = np.arange(block_start, block_stop, dtype=np.uint64)
        faces = (block_ids // np.uint64(blocks_per_face)).astype(np.intp, copy=False)
        local_blocks = block_ids % np.uint64(blocks_per_face)
        block_ix, block_iy = morton_decode(local_blocks)
        x = block_ix[:, None] * sub_nside + sub_ix[None, :]
        y = block_iy[:, None] * sub_nside + sub_iy[None, :]
        grid[faces[:, None], y, x] = block_values

    return grid


def read_block_cell_chunk(
    values: Any,
    block_start: int,
    block_stop: int,
    block_axis: int,
    cell_axis: int,
    sub_count: int,
) -> np.ndarray:
    indexer: list[int | slice] = [slice(None)] * len(array_shape(values))
    indexer[block_axis] = slice(block_start, block_stop)
    indexer[cell_axis] = slice(None)
    chunk = np.asarray(values[tuple(indexer)], dtype=np.float32)
    if block_axis > cell_axis:
        chunk = chunk.T
    return chunk.reshape(block_stop - block_start, sub_count)


def scatter_nested_face(local_values: np.ndarray, out: np.ndarray) -> None:
    local_count = local_values.size
    chunk_size = 4_194_304
    for start in range(0, local_count, chunk_size):
        stop = min(local_count, start + chunk_size)
        codes = np.arange(start, stop, dtype=np.uint64)
        ix, iy = morton_decode(codes)
        out[iy, ix] = local_values[start:stop]


def morton_decode(codes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return compact_morton_bits(codes), compact_morton_bits(codes >> np.uint64(1))


def compact_morton_bits(values: np.ndarray) -> np.ndarray:
    values = values & np.uint64(0x5555555555555555)
    values = (values | (values >> np.uint64(1))) & np.uint64(0x3333333333333333)
    values = (values | (values >> np.uint64(2))) & np.uint64(0x0F0F0F0F0F0F0F0F)
    values = (values | (values >> np.uint64(4))) & np.uint64(0x00FF00FF00FF00FF)
    values = (values | (values >> np.uint64(8))) & np.uint64(0x0000FFFF0000FFFF)
    values = (values | (values >> np.uint64(16))) & np.uint64(0x00000000FFFFFFFF)
    return values.astype(np.intp, copy=False)


def make_encoding(
    tile_dtype: str,
    values: np.ndarray,
    quantize_min: float | None,
    quantize_max: float | None,
    quantize_step: float | None,
) -> dict[str, float | int | str]:
    if tile_dtype == "float32":
        return {"dtype": "float32", "nodata": "nan", "scale": 1.0, "offset": 0.0}

    inferred_min, inferred_max = finite_min_max(values)
    value_min = float(inferred_min if quantize_min is None else quantize_min)
    value_max = float(inferred_max if quantize_max is None else quantize_max)
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


def finite_min_max(values: np.ndarray) -> tuple[float, float]:
    value_min = math.inf
    value_max = -math.inf
    for row in values.reshape(-1, values.shape[-1]):
        finite = row[np.isfinite(row)]
        if finite.size:
            value_min = min(value_min, float(finite.min()))
            value_max = max(value_max, float(finite.max()))
    if not math.isfinite(value_min) or not math.isfinite(value_max):
        raise SystemExit("cannot quantize an array with no finite values")
    return value_min, value_max


def nested_for_order(values: np.ndarray, input_order: int, order: int) -> np.ndarray:
    if order == input_order:
        return values
    factor = 2 ** (input_order - order)
    face_count, nside, _ = values.shape
    coarse = values.reshape(face_count, nside // factor, factor, nside // factor, factor)
    return np.nanmean(coarse, axis=(2, 4), dtype=np.float64).astype(np.float32)


def write_order(
    layer_dir: Path,
    values: np.ndarray,
    order: int,
    tile_shift: int,
    tile_size: int,
    encoding: dict[str, float | int | str],
) -> tuple[float, float, np.ndarray]:
    grid = max(1, 2 ** max(0, order - tile_shift))
    order_min = math.inf
    order_max = -math.inf
    samples = []

    for face in range(12):
        face_values = values[face]
        for y in range(grid):
            y0 = y * tile_size
            y1 = y0 + tile_size
            for x in range(grid):
                x0 = x * tile_size
                x1 = x0 + tile_size
                tile = np.asarray(face_values[y0:y1, x0:x1], dtype=np.float32)
                out_dir = layer_dir / f"o{order}" / f"f{face}" / f"x{x}"
                out_dir.mkdir(parents=True, exist_ok=True)
                encode_tile(tile, encoding).tofile(out_dir / f"y{y}.bin")
                finite = tile[np.isfinite(tile)]
                if finite.size:
                    order_min = min(order_min, float(finite.min()))
                    order_max = max(order_max, float(finite.max()))
                    stride = max(1, finite.size // 2048)
                    samples.append(finite[::stride].astype(np.float64))

    return order_min, order_max, np.concatenate(samples)


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


if __name__ == "__main__":
    main()
