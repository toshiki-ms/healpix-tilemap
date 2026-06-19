#!/usr/bin/env python3
"""Generate one hpxmap tile from a Zarr-backed manifest layer."""

from __future__ import annotations

import argparse
from pathlib import Path

from zarr_tile_common import generate_zarr_tile


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--layer-id", required=True)
    parser.add_argument("--order", required=True, type=int)
    parser.add_argument("--face", required=True, type=int)
    parser.add_argument("--x", required=True, type=int)
    parser.add_argument("--y", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    generate_zarr_tile(
        manifest_path=args.manifest,
        layer_id=args.layer_id,
        order=args.order,
        face=args.face,
        x=args.x,
        y=args.y,
        output=args.output,
        force=args.force,
    )


if __name__ == "__main__":
    main()
