#!/usr/bin/env python3
"""Prefill Zarr tile cache, optionally under MPI.

Run with one process:

    python3 tools/prefill_zarr_tile_cache.py --manifest public/datasets/foo/manifest.json --layer-id value --select time=0

Run on an MPI-capable machine:

    mpirun -n 32 python3 tools/prefill_zarr_tile_cache.py --manifest public/datasets/foo/manifest.json --layer-id value --select time=0
"""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path
from typing import Iterator

from zarr_tile_common import zarr_tile_cache_path, zarr_tile_layer, generate_zarr_tile, load_manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--layer-id", required=True)
    parser.add_argument("--min-order", type=int, default=None)
    parser.add_argument("--max-order", type=int, default=None)
    parser.add_argument("--order", type=int, action="append", default=[], help="Generate one order. Repeatable.")
    parser.add_argument("--select", action="append", default=[], help="Select one non-spatial axis, e.g. time=0.")
    parser.add_argument("--cache-root", type=Path, default=None)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--progress-interval", type=int, default=250)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    mpi = mpi_context()
    manifest = load_manifest(args.manifest)
    layer = zarr_tile_layer(manifest, args.layer_id)
    selectors = parse_selectors(args.select)
    orders = selected_orders(manifest, args)
    tiles = list(iter_tiles(orders, int(manifest["tileShift"])))
    started = time.time()
    local_done = 0
    local_skipped = 0
    local_errors = 0

    if mpi.rank == 0:
        mode = "MPI" if mpi.size > 1 else "single-process"
        print(f"prefill Zarr tile cache: {mode}, ranks={mpi.size}, tiles={len(tiles):,}, orders={orders}")

    for index, tile in enumerate(tiles):
        if index % mpi.size != mpi.rank:
            continue
        order, face, x, y = tile
        output = zarr_tile_cache_path(
            manifest,
            layer,
            order=order,
            face=face,
            x=x,
            y=y,
            select=selectors,
            cache_root=args.cache_root,
        )
        if output.exists() and not args.force:
            local_skipped += 1
            continue
        try:
            generate_zarr_tile(
                manifest_path=args.manifest,
                layer_id=args.layer_id,
                order=order,
                face=face,
                x=x,
                y=y,
                output=output,
                select=selectors,
                force=args.force,
            )
            local_done += 1
        except Exception as error:  # noqa: BLE001 - keep MPI jobs alive long enough to report all failures.
            local_errors += 1
            print(f"[rank {mpi.rank}] failed o{order} f{face} x{x} y{y}: {error}", flush=True)
        total_local = local_done + local_skipped + local_errors
        if args.progress_interval > 0 and total_local % args.progress_interval == 0:
            print(
                f"[rank {mpi.rank}] processed={total_local:,} generated={local_done:,} "
                f"skipped={local_skipped:,} errors={local_errors:,}",
                flush=True,
            )

    totals = mpi.reduce((local_done, local_skipped, local_errors), root=0)
    if mpi.comm is None and mpi.size > 1:
        print(
            f"[rank {mpi.rank}] complete generated={local_done:,} skipped={local_skipped:,} "
            f"errors={local_errors:,}",
            flush=True,
        )
        if mpi.rank == 0:
            print("prefill complete: MPI environment fallback used; install mpi4py for aggregate totals.")
        if local_errors:
            raise SystemExit(1)
        return
    if mpi.rank == 0:
        done = sum(item[0] for item in totals)
        skipped = sum(item[1] for item in totals)
        errors = sum(item[2] for item in totals)
        elapsed = max(time.time() - started, 1e-6)
        print(
            f"prefill complete: generated={done:,} skipped={skipped:,} errors={errors:,} "
            f"elapsed={elapsed:.1f}s rate={(done + skipped) / elapsed:.1f} tiles/s"
        )
        if errors:
            raise SystemExit(1)


def selected_orders(manifest: dict, args: argparse.Namespace) -> list[int]:
    if args.order:
        orders = sorted(set(int(order) for order in args.order))
    else:
        min_order = int(args.min_order if args.min_order is not None else manifest.get("minOrder", manifest["tileShift"]))
        max_order = int(args.max_order if args.max_order is not None else manifest["maxOrder"])
        orders = list(range(min_order, max_order + 1))
    manifest_min = int(manifest.get("minOrder", manifest["tileShift"]))
    manifest_max = int(manifest["maxOrder"])
    for order in orders:
        if order < manifest_min or order > manifest_max:
            raise SystemExit(f"order {order} is outside manifest range {manifest_min}..{manifest_max}")
    return orders


def iter_tiles(orders: list[int], tile_shift: int) -> Iterator[tuple[int, int, int, int]]:
    for order in orders:
        if order < tile_shift:
            raise SystemExit(f"order {order} must be >= tileShift {tile_shift}")
        grid = 1 << (order - tile_shift)
        for face in range(12):
            for y in range(grid):
                for x in range(grid):
                    yield order, face, x, y


def parse_selectors(items: list[str]) -> dict[str, int]:
    selectors: dict[str, int] = {}
    for item in items:
        if "=" not in item:
            raise SystemExit(f"--select must be formatted as dim=index, got {item!r}")
        dim, value = item.split("=", 1)
        dim = dim.strip()
        if not dim:
            raise SystemExit("--select dimension name cannot be empty")
        try:
            selectors[dim] = int(value)
        except ValueError as exc:
            raise SystemExit(f"--select value for {dim!r} must be an integer, got {value!r}") from exc
    return selectors


class MpiContext:
    def __init__(self) -> None:
        try:
            from mpi4py import MPI  # type: ignore
        except ImportError:
            env_mpi = env_mpi_context()
            self.comm = None
            self.rank = env_mpi[0]
            self.size = env_mpi[1]
            self.MPI = None
            return
        self.comm = MPI.COMM_WORLD
        self.rank = int(self.comm.Get_rank())
        self.size = int(self.comm.Get_size())
        self.MPI = MPI

    def reduce(self, value: tuple[int, int, int], *, root: int) -> list[tuple[int, int, int]]:
        if self.comm is None:
            return [value]
        return self.comm.gather(value, root=root)


def mpi_context() -> MpiContext:
    return MpiContext()


def env_mpi_context() -> tuple[int, int]:
    candidates = (
        ("OMPI_COMM_WORLD_RANK", "OMPI_COMM_WORLD_SIZE"),
        ("PMI_RANK", "PMI_SIZE"),
        ("PMIX_RANK", "PMIX_SIZE"),
        ("MV2_COMM_WORLD_RANK", "MV2_COMM_WORLD_SIZE"),
    )
    for rank_name, size_name in candidates:
        if rank_name in os.environ and size_name in os.environ:
            rank = int(os.environ[rank_name])
            size = int(os.environ[size_name])
            if size > 0 and 0 <= rank < size:
                return rank, size
    return 0, 1


if __name__ == "__main__":
    main()
