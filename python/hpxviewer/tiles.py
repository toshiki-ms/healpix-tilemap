from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .paths import repo_root, resolve_in_repo


def write_tiles(
    data: Any | None = None,
    *,
    input: str | Path | None = None,
    output: str | Path,
    dataset_id: str | None = None,
    title: str | None = None,
    description: str | None = None,
    layer_id: str = "value",
    layer_title: str | None = None,
    unit: str | None = None,
    ordering: str = "nested",
    array: str | None = None,
    dims: str | list[str] | tuple[str, ...] | None = None,
    select: dict[str, int] | list[str] | tuple[str, ...] | None = None,
    dtype: str | None = None,
    nside: int | None = None,
    nside_block: int | None = None,
    block_order: int | None = None,
    min_order: int = 11,
    max_order: int | None = None,
    tile_size: int = 256,
    default_view: str = "globe",
    colormap: str = "viridis",
    scale: str = "linear",
    tile_dtype: str = "float32",
    quantize_min: float | None = None,
    quantize_max: float | None = None,
    quantize_step: float | None = None,
    force: bool = False,
    register: bool = False,
) -> dict[str, Any]:
    """Write a HEALPix scalar array to the viewer tile pyramid format.

    Pass ``input=`` for large existing Zarr v3, ``.npy``, ``.npz``, or raw
    files to avoid copying. Zarr groups use ``array=`` for variable selection,
    ``select=`` for time/level axes, and ``block_order=`` for block/cell
    layouts. Passing ``data`` is convenient in notebooks and writes a temporary
    ``.npy`` file before invoking the repository converter.
    """

    if data is None and input is None:
        raise ValueError("write_tiles requires either data or input.")
    root = repo_root()
    output_path = resolve_in_repo(output)
    dataset_id = dataset_id or output_path.name

    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    try:
        if data is not None:
            import numpy as np

            (root / "data").mkdir(exist_ok=True)
            temp_dir = tempfile.TemporaryDirectory(prefix="hpxviewer-", dir=root / "data")
            input_path = Path(temp_dir.name) / "input.npy"
            np.save(input_path, data)
        else:
            input_path = resolve_in_repo(input)  # type: ignore[arg-type]

        args = [
            "python3",
            "tools/make_hpx_tiles.py",
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--dataset-id",
            dataset_id,
            "--layer-id",
            layer_id,
            "--ordering",
            ordering,
            "--min-order",
            str(min_order),
            "--tile-size",
            str(tile_size),
            "--default-view",
            default_view,
            "--colormap",
            colormap,
            "--scale",
            scale,
            "--tile-dtype",
            tile_dtype,
        ]
        _append(args, "--title", title)
        _append(args, "--description", description)
        _append(args, "--layer-title", layer_title)
        _append(args, "--unit", unit)
        _append(args, "--array", array)
        _append(args, "--dims", ",".join(dims) if isinstance(dims, (list, tuple)) else dims)
        _append_selectors(args, select)
        _append(args, "--dtype", dtype)
        _append(args, "--nside", nside)
        _append(args, "--nside-block", nside_block)
        _append(args, "--block-order", block_order)
        _append(args, "--max-order", max_order)
        _append(args, "--quantize-min", quantize_min)
        _append(args, "--quantize-max", quantize_max)
        _append(args, "--quantize-step", quantize_step)
        if force:
            args.append("--force")

        completed = subprocess.run(args, cwd=root, check=True, text=True, capture_output=True)
        result = {
            "dataset_id": dataset_id,
            "output": str(output_path),
            "manifest": str(output_path / "manifest.json"),
            "stdout": completed.stdout,
            "stderr": completed.stderr,
        }
        if register:
            manifest_rel = (output_path / "manifest.json").relative_to(root / "public" / "datasets")
            result["registration"] = register_dataset(
                id=dataset_id,
                title=title or dataset_id,
                manifest=str(manifest_rel),
            )
        return result
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()


def register_dataset(
    *,
    id: str,
    title: str | None = None,
    manifest: str,
    make_default: bool = False,
    index: str | Path = "public/datasets/index.json",
) -> dict[str, Any]:
    index_path = resolve_in_repo(index)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"datasets": []}
    entry = {"id": id, "title": title or id, "manifest": manifest}
    catalog["datasets"] = [item for item in catalog.get("datasets", []) if item.get("id") != id]
    catalog["datasets"].append(entry)
    if make_default or not catalog.get("default"):
        catalog["default"] = id
    index_path.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    return {"index": str(index_path), "entry": entry, "default": catalog.get("default")}


def _append(args: list[str], flag: str, value: Any | None) -> None:
    if value is not None:
        args.extend([flag, str(value)])


def _append_selectors(args: list[str], select: dict[str, int] | list[str] | tuple[str, ...] | None) -> None:
    if select is None:
        return
    if isinstance(select, dict):
        for key, value in select.items():
            args.extend(["--select", f"{key}={value}"])
        return
    for item in select:
        args.extend(["--select", str(item)])
