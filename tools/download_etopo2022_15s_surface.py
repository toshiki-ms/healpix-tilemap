#!/usr/bin/env python3
"""Download NOAA ETOPO 2022 15 arc-second surface tiles and build a VRT."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import re
import subprocess
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

CATALOG_URL = "https://www.ngdc.noaa.gov/thredds/catalog/global/ETOPO2022/15s/15s_surface_elev_netcdf/catalog.xml"
FILE_BASE_URL = "https://www.ngdc.noaa.gov/thredds/fileServer/"
RESOLUTION_DEGREES = 15 / 3600
TILE_DEGREES = 15
TILE_SIZE = 3600
GLOBAL_WIDTH = 86400
GLOBAL_HEIGHT = 43200


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("data/ETOPO2022_15s_surface"))
    parser.add_argument("--catalog-url", default=CATALOG_URL)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--skip-download", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    tile_dir = args.output / "tiles"
    tile_dir.mkdir(exist_ok=True)

    tiles = catalog_tiles(args.catalog_url)
    if not args.skip_download:
        jobs = max(1, args.jobs)
        with ThreadPoolExecutor(max_workers=jobs) as executor:
            futures = {
                executor.submit(download_tile, tile_dir, tile, index, len(tiles)): tile
                for index, tile in enumerate(tiles, 1)
            }
            for future in as_completed(futures):
                print(future.result())

    vrt_path = args.output / "ETOPO_2022_v1_15s_surface.vrt"
    vrt_path.write_text(build_vrt(tile_dir, tiles, vrt_path), encoding="utf-8")
    print(f"wrote {vrt_path}")


def download_tile(tile_dir: Path, tile: dict[str, str | int], index: int, total: int) -> str:
    target = tile_dir / tile["name"]
    expected_bytes = int(tile["expected_bytes"])
    if target.exists() and target.stat().st_size >= int(expected_bytes * 0.98):
        return f"[{index}/{total}] exists {target.name}"
    url = FILE_BASE_URL + tile["url_path"]
    subprocess.run(
        [
            "curl",
            "-L",
            "--fail",
            "--continue-at",
            "-",
            "--silent",
            "--show-error",
            "--output",
            str(target),
            url,
        ],
        check=True,
    )
    return f"[{index}/{total}] downloaded {target.name}"


def catalog_tiles(catalog_url: str) -> list[dict[str, str | int]]:
    data = urllib.request.urlopen(catalog_url, timeout=60).read()
    root = ET.fromstring(data)
    ns = {"t": "http://www.unidata.ucar.edu/namespaces/thredds/InvCatalog/v1.0"}
    tiles: list[dict[str, str | int]] = []
    for dataset in root.findall(".//t:dataset", ns):
        name = dataset.attrib.get("name", "")
        url_path = dataset.attrib.get("urlPath", "")
        if name.endswith("_surface.nc") and url_path:
            size = dataset.find("t:dataSize", ns)
            expected_bytes = 0
            if size is not None and size.text:
                units = size.attrib.get("units", "Mbytes")
                multiplier = 1024**3 if units.startswith("G") else 1024**2
                expected_bytes = int(float(size.text) * multiplier)
            tiles.append({"name": name, "url_path": url_path, "expected_bytes": expected_bytes})
    if len(tiles) != 288:
        raise SystemExit(f"Expected 288 ETOPO 2022 15s surface tiles, found {len(tiles)}")
    return sorted(tiles, key=lambda item: item["name"])


def build_vrt(tile_dir: Path, tiles: list[dict[str, str | int]], vrt_path: Path) -> str:
    lines = [
        f'<VRTDataset rasterXSize="{GLOBAL_WIDTH}" rasterYSize="{GLOBAL_HEIGHT}">',
        '  <SRS dataAxisToSRSAxisMapping="2,1">EPSG:4326</SRS>',
        f"  <GeoTransform>-180, {RESOLUTION_DEGREES}, 0, 90, 0, -{RESOLUTION_DEGREES}</GeoTransform>",
        '  <VRTRasterBand dataType="Float32" band="1">',
        "    <NoDataValue>-99999</NoDataValue>",
    ]
    for tile in tiles:
        name = tile["name"]
        bounds = tile_bounds_from_name(name)
        x_off = round((bounds["west"] + 180) / RESOLUTION_DEGREES)
        y_off = round((90 - bounds["north"]) / RESOLUTION_DEGREES)
        source = (tile_dir / name).relative_to(vrt_path.parent)
        lines.extend(
            [
                "    <SimpleSource>",
                f'      <SourceFilename relativeToVRT="1">{source.as_posix()}</SourceFilename>',
                "      <SourceBand>1</SourceBand>",
                f'      <SourceProperties RasterXSize="{TILE_SIZE}" RasterYSize="{TILE_SIZE}" DataType="Float32" BlockXSize="{TILE_SIZE}" BlockYSize="1" />',
                f'      <SrcRect xOff="0" yOff="0" xSize="{TILE_SIZE}" ySize="{TILE_SIZE}" />',
                f'      <DstRect xOff="{x_off}" yOff="{y_off}" xSize="{TILE_SIZE}" ySize="{TILE_SIZE}" />',
                "      <NODATA>-99999</NODATA>",
                "    </SimpleSource>",
            ]
        )
    lines.extend(["  </VRTRasterBand>", "</VRTDataset>", ""])
    return "\n".join(lines)


def tile_bounds_from_name(name: str) -> dict[str, int]:
    # Example: ETOPO_2022_v1_15s_N15W030_surface.nc names the north-west corner.
    match = re.search(r"_([NS]\d{2})([EW]\d{3})_", name)
    if not match:
        raise ValueError(f"Could not parse ETOPO tile name: {name}")
    lat_token = match.group(1)
    lon_token = match.group(2)
    north = signed_coordinate(lat_token, "N", "S")
    west = signed_coordinate(lon_token, "E", "W")
    return {
        "north": north,
        "south": north - TILE_DEGREES,
        "west": west,
        "east": west + TILE_DEGREES,
    }


def signed_coordinate(token: str, positive: str, negative: str) -> int:
    prefix = token[0]
    value = int(token[1:])
    if prefix == positive:
        return value
    if prefix == negative:
        return -value
    raise ValueError(f"Invalid coordinate token: {token}")


if __name__ == "__main__":
    main()
