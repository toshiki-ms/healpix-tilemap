#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: validate_tiles.py path/to/manifest.json [...]")
    total = 0
    for argument in sys.argv[1:]:
        total += validate_manifest(Path(argument))
    print(f"validated {total} tiles total")


def validate_manifest(manifest_path: Path) -> int:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "hpxmap-v1":
        raise SystemExit("invalid schema")
    tile_size = int(manifest["tileSize"])
    min_order = int(manifest.get("minOrder", manifest["tileShift"]))
    max_order = int(manifest["maxOrder"])
    root = manifest_path.parent
    missing = []
    checked = 0
    for layer in manifest["layers"]:
        template = layer["source"]["template"]
        sparse = bool(layer.get("source", {}).get("sparse"))
        expected_bytes = tile_size * tile_size * bytes_per_sample(layer.get("dtype", "float32"))
        for order in range(min_order, max_order + 1):
            grid = max(1, 2 ** max(0, order - int(manifest["tileShift"])))
            for face in range(12):
                for y in range(grid):
                    for x in range(grid):
                        rel = template.format(order=order, face=face, x=x, y=y)
                        path = root / rel
                        if not path.exists():
                            if not sparse:
                                missing.append(str(path))
                            continue
                        size = path.stat().st_size
                        if size != expected_bytes:
                            raise SystemExit(f"{path} has {size} bytes, expected {expected_bytes}")
                        checked += 1
    if missing:
        for path in missing[:20]:
            print(f"missing {path}")
        raise SystemExit(f"{len(missing)} tiles missing")
    print(f"validated {checked} tiles in {manifest_path}")
    return checked


def bytes_per_sample(dtype: str) -> int:
    if dtype == "float32":
        return 4
    if dtype in {"uint16", "int16"}:
        return 2
    raise SystemExit(f"unsupported layer dtype: {dtype}")


if __name__ == "__main__":
    main()
