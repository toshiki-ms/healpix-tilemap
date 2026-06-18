from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from .paths import repo_root
from .server import start_viewer


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="hpxviewer-export",
        description="Render a HEALPix Tile Map view_state.json file to an image.",
    )
    parser.add_argument("view_state", help="Path to a saved view_state.json file.")
    parser.add_argument("output", help="Output PNG or JPG path.")
    parser.add_argument("--base-url", help="Use an already running viewer instead of starting one.")
    parser.add_argument("--server-host", default="127.0.0.1", help="Viewer host used when --base-url is omitted.")
    parser.add_argument("--server-port", type=int, default=4181, help="Viewer port used when --base-url is omitted.")
    parser.add_argument("--mode", choices=["active", "left", "right", "split"], help="Export target override.")
    parser.add_argument("--format", choices=["png", "jpg", "jpeg"], help="Output format override.")
    parser.add_argument("--scale", type=int, choices=[1, 2, 4], help="Output scale override.")
    parser.add_argument("--width", type=int, help="Exact output width override.")
    parser.add_argument("--height", type=int, help="Exact output height override.")
    parser.add_argument("--viewport-width", type=int, default=1280, help="Headless browser viewport width.")
    parser.add_argument("--viewport-height", type=int, default=900, help="Headless browser viewport height.")
    parser.add_argument("--transparent", dest="transparent", action="store_true", default=None, help="Force transparent PNG.")
    parser.add_argument("--no-transparent", dest="transparent", action="store_false", help="Disable transparent PNG.")
    parser.add_argument("--metadata", dest="embed_metadata", action="store_true", default=None, help="Force metadata embedding.")
    parser.add_argument("--no-metadata", dest="embed_metadata", action="store_false", help="Disable metadata embedding.")
    parser.add_argument("--timeout", type=float, default=60.0, help="Headless export timeout in seconds.")
    parser.add_argument("--chrome", help="Chrome or Chromium executable path.")
    args = parser.parse_args(argv)

    root = repo_root()
    view_state = Path(args.view_state).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    base_url = args.base_url
    if base_url is None:
        base_url = start_viewer(port=args.server_port, host=args.server_host).url

    command = [
        "node",
        str(root / "tools" / "headless_export_image.mjs"),
        "--url",
        base_url,
        "--view-state",
        str(view_state),
        "--output",
        str(output),
        "--viewport-width",
        str(args.viewport_width),
        "--viewport-height",
        str(args.viewport_height),
        "--timeout",
        str(args.timeout),
    ]
    optional_pairs = [
        ("--mode", args.mode),
        ("--format", args.format),
        ("--scale", args.scale),
        ("--width", args.width),
        ("--height", args.height),
        ("--chrome", args.chrome),
    ]
    for flag, value in optional_pairs:
        if value is not None:
            command.extend([flag, str(value)])
    if args.transparent is True:
        command.append("--transparent")
    elif args.transparent is False:
        command.append("--no-transparent")
    if args.embed_metadata is True:
        command.append("--metadata")
    elif args.embed_metadata is False:
        command.append("--no-metadata")

    subprocess.run(command, check=True, cwd=root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
