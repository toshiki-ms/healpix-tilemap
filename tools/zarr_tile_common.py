#!/usr/bin/env python3
"""Shared helpers for HEALPix tile cache generation from Zarr sources."""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any

import numpy as np


ZARR_TILE_CACHE_SCHEMA = "hpxmap-zarr-tile-cache-v1"


def load_manifest(manifest_path: Path) -> dict[str, Any]:
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def zarr_tile_layer(manifest: dict[str, Any], layer_id: str) -> dict[str, Any]:
    for layer in manifest.get("layers", []):
        if layer.get("id") == layer_id:
            source = layer.get("source", {})
            if source.get("type") != "zarr-tile":
                raise SystemExit(f"Layer {layer_id!r} is not a zarr-tile layer.")
            return layer
    raise SystemExit(f"Layer {layer_id!r} was not found in manifest.")


def zarr_tile_cache_descriptor(
    manifest: dict[str, Any],
    layer: dict[str, Any],
    *,
    select: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema": ZARR_TILE_CACHE_SCHEMA,
        "dataset": manifest.get("name"),
        "layer": layer.get("id"),
        "manifestMaxOrder": manifest.get("maxOrder"),
        "manifestNside": manifest.get("nside"),
        "manifestTileShift": manifest.get("tileShift"),
        "manifestTileSize": manifest.get("tileSize"),
        "dtype": layer.get("dtype"),
        "quantization": layer.get("quantization"),
        "select": effective_select(layer.get("source", {}), select),
        "source": layer.get("source"),
    }


def zarr_tile_cache_hash(
    manifest: dict[str, Any],
    layer: dict[str, Any],
    *,
    select: dict[str, Any] | None = None,
) -> str:
    payload = json.dumps(
        zarr_tile_cache_descriptor(manifest, layer, select=select),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def zarr_tile_cache_path(
    manifest: dict[str, Any],
    layer: dict[str, Any],
    *,
    order: int,
    face: int,
    x: int,
    y: int,
    select: dict[str, Any] | None = None,
    cache_root: Path | None = None,
) -> Path:
    source = layer.get("source", {})
    root = cache_root or Path(str(source.get("cacheDir") or "cache/zarr-tiles"))
    return (
        root
        / safe_path_segment(str(manifest.get("name") or "dataset"))
        / safe_path_segment(str(layer.get("id") or "layer"))
        / zarr_tile_cache_hash(manifest, layer, select=select)
        / f"o{order}"
        / f"f{face}"
        / f"x{x}"
        / f"y{y}.bin"
    )


def safe_path_segment(value: str) -> str:
    return "".join(char if char.isalnum() or char in "._-" else "_" for char in value)


def generate_zarr_tile(
    *,
    manifest_path: Path,
    layer_id: str,
    order: int,
    face: int,
    x: int,
    y: int,
    output: Path,
    select: dict[str, Any] | None = None,
    force: bool = False,
) -> Path:
    if output.exists() and not force:
        return output
    manifest = load_manifest(manifest_path)
    layer = zarr_tile_layer(manifest, layer_id)
    validate_tile_address(manifest, order, face, x, y)

    tile = read_zarr_tile(manifest_path, manifest, layer, order=order, face=face, x=x, y=y, select=select)
    encoded = encode_tile(tile, layer)
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    tmp.write_bytes(encoded)
    os.replace(tmp, output)
    return output


def validate_tile_address(manifest: dict[str, Any], order: int, face: int, x: int, y: int) -> None:
    tile_shift = int(manifest["tileShift"])
    min_order = int(manifest.get("minOrder", tile_shift))
    max_order = int(manifest["maxOrder"])
    if order < min_order or order > max_order:
        raise SystemExit(f"order {order} is outside manifest range {min_order}..{max_order}")
    if face < 0 or face >= 12:
        raise SystemExit(f"face must be in 0..11, got {face}")
    if order < tile_shift:
        raise SystemExit(f"order {order} must be >= tileShift {tile_shift}")
    grid = 2 ** (order - tile_shift)
    if x < 0 or x >= grid or y < 0 or y >= grid:
        raise SystemExit(f"tile x/y must be in 0..{grid - 1} for order {order}")


def read_zarr_tile(
    manifest_path: Path,
    manifest: dict[str, Any],
    layer: dict[str, Any],
    *,
    order: int,
    face: int,
    x: int,
    y: int,
    select: dict[str, Any] | None = None,
) -> np.ndarray:
    source = layer["source"]
    array = open_zarr_array(resolve_zarr_location(manifest_path, str(source["zarr"])), source.get("array"))
    dims = source_dimension_names(array, source)
    return read_face_grid_tile(array, dims, source, manifest, order=order, face=face, x=x, y=y, select=select)


def resolve_zarr_location(manifest_path: Path, location: str) -> str | Path:
    if "://" in location:
        return location
    path = Path(location)
    if path.is_absolute():
        return path
    manifest_candidate = (manifest_path.parent / path).resolve()
    if manifest_candidate.exists():
        return manifest_candidate
    cwd_candidate = (Path.cwd() / path).resolve()
    return cwd_candidate


def open_zarr_array(location: str | Path, array_name: str | None) -> Any:
    try:
        import zarr
    except ImportError as exc:
        raise SystemExit("zarr>=3 is required for zarr-tile tile generation.") from exc

    root = zarr.open(location, mode="r")
    if hasattr(root, "shape"):
        if array_name:
            raise SystemExit("source.array is only valid when source.zarr points to a Zarr group.")
        return root
    if not array_name:
        keys = sorted(str(key) for key in root.array_keys())
        if len(keys) != 1:
            shown = ", ".join(keys) if keys else "none"
            raise SystemExit(f"source.array is required for Zarr group; root arrays: {shown}")
        array_name = keys[0]
    try:
        array = root[array_name]
    except KeyError as exc:
        raise SystemExit(f"Zarr array {array_name!r} was not found.") from exc
    if not hasattr(array, "shape"):
        raise SystemExit(f"Zarr path {array_name!r} is a group, not an array.")
    return array


def source_dimension_names(array: Any, source: dict[str, Any]) -> list[str] | None:
    shape = tuple(int(item) for item in getattr(array, "shape"))
    source_dims = source.get("dims")
    if source_dims is not None:
        dims = [str(item) for item in source_dims]
        if len(dims) != len(shape):
            raise SystemExit(f"source.dims has {len(dims)} names but array shape has {len(shape)} axes")
        return dims

    metadata = getattr(array, "metadata", None)
    metadata_names = getattr(metadata, "dimension_names", None)
    if metadata_names is not None:
        dims = [str(item) for item in metadata_names]
        if len(dims) == len(shape):
            return dims

    attrs = getattr(array, "attrs", None)
    if attrs is not None:
        for key in ("_ARRAY_DIMENSIONS", "dimension_names", "dims"):
            names = attrs.get(key)
            if names is None:
                continue
            dims = [str(item) for item in names]
            if len(dims) == len(shape):
                return dims
    return None


def read_face_grid_tile(
    array: Any,
    dims: list[str] | None,
    source: dict[str, Any],
    manifest: dict[str, Any],
    *,
    order: int,
    face: int,
    x: int,
    y: int,
    select: dict[str, Any] | None = None,
) -> np.ndarray:
    shape = tuple(int(item) for item in getattr(array, "shape"))
    face_axis, y_axis, x_axis = face_grid_axes(shape, dims)
    nside = shape[y_axis]
    native_order = int(round(math.log2(nside)))
    if 2**native_order != nside:
        raise SystemExit(f"face grid nside must be a power of two, got {nside}")
    if order > native_order:
        raise SystemExit(f"order {order} exceeds Zarr source native order {native_order}")

    tile_size = int(manifest["tileSize"])
    factor = 2 ** (native_order - order)
    read_size = tile_size * factor
    max_read_cells = int(source.get("maxReadCells") or os.environ.get("HPX_ZARR_TILE_MAX_READ_CELLS") or 4_194_304)
    if read_size * read_size > max_read_cells:
        raise SystemExit(
            f"Zarr tile read would touch {read_size * read_size:,} source cells; "
            f"raise source.maxReadCells or HPX_ZARR_TILE_MAX_READ_CELLS if this is intentional"
        )

    x0 = x * tile_size * factor
    y0 = y * tile_size * factor
    indexer: list[int | slice] = []
    axis_select = effective_select(source, select)
    for axis, size in enumerate(shape):
        if axis == face_axis:
            indexer.append(face)
        elif axis == y_axis:
            indexer.append(slice(y0, y0 + read_size))
        elif axis == x_axis:
            indexer.append(slice(x0, x0 + read_size))
        else:
            indexer.append(selected_axis_index(axis, size, dims, axis_select))

    data = np.asarray(array[tuple(indexer)], dtype=np.float32)
    remaining = [axis for axis, value in enumerate(indexer) if isinstance(value, slice)]
    if remaining == [x_axis, y_axis]:
        data = data.T
    elif remaining != [y_axis, x_axis]:
        raise SystemExit(f"Zarr tile read produced unexpected axes {remaining}; expected y/x")
    if data.shape != (read_size, read_size):
        raise SystemExit(f"Zarr tile read produced shape {data.shape}, expected {(read_size, read_size)}")
    if factor == 1:
        return np.asarray(data, dtype=np.float32)
    coarse = data.reshape(tile_size, factor, tile_size, factor)
    return np.nanmean(coarse, axis=(1, 3), dtype=np.float64).astype(np.float32)


def effective_select(source: dict[str, Any], select: dict[str, Any] | None = None) -> dict[str, Any]:
    merged = dict(source.get("select") or {})
    if select:
        merged.update({str(key): value for key, value in select.items()})
    return merged


def face_grid_axes(shape: tuple[int, ...], dims: list[str] | None) -> tuple[int, int, int]:
    if dims is None:
        if len(shape) == 3 and shape[0] == 12 and shape[1] == shape[2]:
            return 0, 1, 2
        raise SystemExit("zarr-tile sources with extra axes must provide source.dims or array dimension names.")

    normalized = [normalize_dim_name(name) for name in dims]
    face_axis = find_axis(normalized, {"face", "hpxface", "healpixface"})
    y_axis = find_axis(normalized, {"y", "iy", "row", "latindex"})
    x_axis = find_axis(normalized, {"x", "ix", "col", "column", "lonindex"})
    if face_axis is None or y_axis is None or x_axis is None:
        raise SystemExit("zarr-tile currently requires face, y, and x dimensions.")
    if len({face_axis, y_axis, x_axis}) != 3:
        raise SystemExit("face, y, and x dimensions must be distinct.")
    if shape[face_axis] != 12:
        raise SystemExit(f"face dimension has size {shape[face_axis]}, expected 12")
    if shape[y_axis] != shape[x_axis]:
        raise SystemExit(f"face grid dimensions must be square, got {shape[y_axis]} x {shape[x_axis]}")
    return face_axis, y_axis, x_axis


def selected_axis_index(axis: int, size: int, dims: list[str] | None, select: dict[str, Any]) -> int:
    keys = [str(axis)]
    if dims is not None:
        keys.extend([dims[axis], normalize_dim_name(dims[axis])])
    value = None
    for key in keys:
        if key in select:
            value = select[key]
            break
    if value is None:
        name = dims[axis] if dims is not None else str(axis)
        raise SystemExit(f"source.select must choose non-spatial dimension {name!r}.")
    try:
        index = int(value)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"source.select value for axis {axis} must be an integer, got {value!r}") from exc
    if index < 0:
        index += size
    if index < 0 or index >= size:
        raise SystemExit(f"source.select index {index} is outside axis size {size}")
    return index


def normalize_dim_name(name: str) -> str:
    return "".join(char for char in name.lower() if char.isalnum())


def find_axis(names: list[str], candidates: set[str]) -> int | None:
    for axis, name in enumerate(names):
        if name in candidates:
            return axis
    return None


def encode_tile(tile: np.ndarray, layer: dict[str, Any]) -> bytes:
    dtype = layer.get("dtype", "float32")
    if dtype == "float32":
        return np.asarray(tile, dtype=np.float32).tobytes(order="C")
    quantization = layer.get("quantization") or {}
    scale = float(quantization.get("scale", 1.0))
    offset = float(quantization.get("offset", 0.0))
    nodata = quantization.get("nodata")
    if scale <= 0:
        raise SystemExit("quantization.scale must be positive for Zarr encoded tiles.")
    finite = np.isfinite(tile)
    if dtype == "uint16":
        nodata_value = np.uint16(int(65535 if nodata is None else nodata))
        out = np.full(tile.shape, nodata_value, dtype=np.uint16)
        encoded = np.rint((tile[finite] - offset) / scale)
        out[finite] = np.clip(encoded, 0, 65534).astype(np.uint16)
        return out.tobytes(order="C")
    if dtype == "int16":
        nodata_value = np.int16(int(-32768 if nodata is None else nodata))
        out = np.full(tile.shape, nodata_value, dtype=np.int16)
        encoded = np.rint((tile[finite] - offset) / scale)
        out[finite] = np.clip(encoded, -32767, 32767).astype(np.int16)
        return out.tobytes(order="C")
    raise SystemExit(f"unsupported Zarr tile dtype: {dtype}")
