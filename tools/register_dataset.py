#!/usr/bin/env python3
"""Register a generated dataset in public/datasets/index.json."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", type=Path, default=Path("public/datasets/index.json"))
    parser.add_argument("--id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--default", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.index.parent.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(args.index.read_text(encoding="utf-8")) if args.index.exists() else {"datasets": []}
    entry = {"id": args.id, "title": args.title, "manifest": args.manifest}
    datasets = [item for item in catalog.get("datasets", []) if item.get("id") != args.id]
    datasets.append(entry)
    catalog["datasets"] = datasets
    if args.default or not catalog.get("default"):
        catalog["default"] = args.id
    args.index.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"registered {args.id} in {args.index}")


if __name__ == "__main__":
    main()
