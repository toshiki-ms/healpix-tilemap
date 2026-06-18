#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--layer-id", required=True)
    parser.add_argument("--tile-dtype", choices=["uint16", "int16"], default="uint16")
    parser.add_argument("--quantize-min", type=float, required=True)
    parser.add_argument("--quantize-max", type=float, required=True)
    parser.add_argument("--quantize-step", type=float, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    layer = next((item for item in manifest["layers"] if item["id"] == args.layer_id), None)
    if layer is None:
        raise SystemExit(f"layer not found: {args.layer_id}")
    if layer.get("dtype") != "float32":
        raise SystemExit(f"only float32 layers can be quantized in place, got {layer.get('dtype')}")

    encoding = make_encoding(args.tile_dtype, args.quantize_min, args.quantize_max, args.quantize_step)
    tile_size = int(manifest["tileSize"])
    min_order = int(manifest.get("minOrder", manifest["tileShift"]))
    max_order = int(manifest["maxOrder"])
    root = args.manifest.parent
    template = layer["source"]["template"]

    converted = 0
    for order in range(min_order, max_order + 1):
        grid = max(1, 2 ** max(0, order - int(manifest["tileShift"])))
        for face in range(12):
            for y in range(grid):
                for x in range(grid):
                    rel = template.format(order=order, face=face, x=x, y=y)
                    path = root / rel
                    values = np.fromfile(path, dtype="<f4")
                    expected = tile_size * tile_size
                    if values.size != expected:
                        raise SystemExit(f"{path} has {values.size} samples, expected {expected}")
                    encoded = encode_tile(values.reshape(tile_size, tile_size), encoding)
                    tmp_path = path.with_suffix(path.suffix + ".tmp")
                    encoded.tofile(tmp_path)
                    tmp_path.replace(path)
                    converted += 1
        print(f"order {order}: converted {converted} tiles")

    layer["dtype"] = encoding["dtype"]
    layer["nodata"] = encoding["nodata"]
    layer["quantization"] = {
        "scale": encoding["scale"],
        "offset": encoding["offset"],
        "nodata": encoding["nodata"],
    }
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"updated {args.manifest}")


def make_encoding(
    tile_dtype: str,
    value_min: float,
    value_max: float,
    quantize_step: float | None,
) -> dict[str, float | int | str]:
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
            raise SystemExit("uint16 quantization range does not fit")
    else:
        if math.floor((value_min - offset) / scale) < code_min or math.ceil((value_max - offset) / scale) > code_max:
            raise SystemExit("int16 quantization range does not fit")

    print(
        f"tile encoding {tile_dtype}: value = encoded * {scale:.9g} + {offset:.9g}; "
        f"nodata={nodata}"
    )
    return {"dtype": tile_dtype, "scale": scale, "offset": offset, "nodata": nodata}


def encode_tile(tile: np.ndarray, encoding: dict[str, float | int | str]) -> np.ndarray:
    dtype = encoding["dtype"]
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
