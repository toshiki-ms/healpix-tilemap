# MCP and Jupyter Integration

This viewer can be controlled by language models and notebooks without moving
large tile binaries through MCP. The separation is:

- HTTP/static files serve manifests, WASM, and tile binaries.
- Browser remote control changes view state, samples points, and captures
  screenshots.
- MCP exposes compact metadata and control tools to language models.
- Python helpers generate/register tile pyramids and embed the viewer in
  notebooks.

## Browser Remote API

Open the viewer with `remote=1`:

```text
http://127.0.0.1:4181/?remote=1&dataset=spectral-noise-n8192&view=globe
```

The page exposes `window.__hpxRemote`:

```js
await window.__hpxRemote.get_state()
await window.__hpxRemote.set_view_state({ cmap: "turbo", scale: "symlog" })
await window.__hpxRemote.goto_lonlat({ lon: 86.925, lat: 27.9881, distance: 1.18 })
await window.__hpxRemote.inspect_lonlat({ lon: 86.925, lat: 27.9881, order: 13 })
await window.__hpxRemote.inspect_screen({})
await window.__hpxRemote.wait_for_idle({ timeoutMs: 10000 })
```

This API is intentionally small and state-oriented. Screenshot capture is done
outside the page by Chrome DevTools Protocol.

## MCP Server

Install dependencies once:

```sh
cd mcp-server
npm install
```

Run from the repository root:

```sh
npm run mcp:start
```

Smoke test:

```sh
npm run mcp:smoke
```

Useful environment variables:

```sh
HPX_VIEWER_ROOT=/path/to/healpix-tile-map-viewer
HPX_VIEWER_URL=http://127.0.0.1:4181/
CHROME_BIN=/path/to/google-chrome
```

The server provides these tools:

- `list_datasets`
- `summarize_dataset`
- `start_viewer`
- `open_view`
- `get_view_state`
- `set_view_state`
- `goto_lonlat`
- `inspect_point`
- `capture_screenshot`
- `register_dataset`
- `make_tiles_from_healpix`
- `close_viewer`

Example MCP workflow:

1. `start_viewer`
2. `open_view` with dataset/layer/view/order/cmap/scale
3. `goto_lonlat` for an area of interest
4. `inspect_point` with lon/lat
5. `capture_screenshot`
6. `close_viewer`

## Jupyter

Use the local Python package by adding the repo's `python/` directory to
`PYTHONPATH`, or install it editable:

```sh
pip install -e "python[analysis,notebook,array]"
```

Notebook example:

```python
from hpxviewer import Viewer, write_tiles, register_dataset

v = Viewer(
    "spectral-noise-n8192",
    view="globe",
    order=13,
    cmap="turbo",
    scale="symlog",
)
v.show(height=720)
```

`show()` displays a notebook iframe plus an "Open HEALPix viewer in new tab"
link. The separate tab is usually more comfortable for globe navigation. To
show only the link:

```python
v.show(iframe=False)
```

The viewer records the last clicked cell or right-dragged tile selection on the
viewer server. Keep the returned object and query it from Python:

```python
v = Viewer("spectral-noise-n8192", view="globe", order=13)
v.show()

# Click the globe/net, or right-drag across tiles, then:
selection = v.selection()
selection
```

For a point, `selection["selectionType"] == "point"` and the dictionary contains
`datasetId`, `layerId`, `cell`, `nestedId`, `lonLat`, `value`, `tile`, and
`tileKey`. For a tile selection, `selection["selectionType"] == "tiles"` and
`selection["tiles"]["coverage"]` contains compact HEALPix `tileRanges` and
`cellRanges` grouped by face and tile row. It does not return point probes or
sampled values; use the returned cell ranges in Python if you need exact values
or statistics.

When the viewer is opened from the notebook's "Open HEALPix viewer in new tab"
link, the separate tab posts selection updates back to the original notebook
output panel. Programmatic access still uses the viewer server:

```python
tiles = v.tile_selection(timeout=30)
tiles.to_dataframe("cell_ranges", order=13)
```

For a full-sky nested HEALPix array, selected values can be sliced directly:

```python
values = tiles.values_from_nested(my_nested_map, order=13)
values.mean(), values.min(), values.max()
```

For the recommended Zarr layout `(..., block, cell)`, keep the Zarr array open
and pass leading-axis indices with `prefix` so only the selected ranges are
read:

```python
import zarr

temperature = zarr.open_group("data/my-map-n8192.zarr", mode="r")["temperature"]
values = tiles.values_from_block_cell(temperature, order=13, block_order=11, prefix=(0,))
values.mean()
```

Or use nested id ranges without concatenating:

```python
for r in tiles.nested_id_ranges(order=13):
    chunk = my_nested_map[r["start"]:r["stop"]]
    ...
```

To wait for the next available selection:

```python
selection = v.selection(timeout=30)
```

For an existing Zarr v3 HEALPix store:

```python
write_tiles(
    input="data/my-map-n8192.zarr",
    array="temperature",
    select={"time": 0},
    block_order=11,
    output="public/datasets/my-map-n8192",
    dataset_id="my-map-n8192",
    title="My map nside 8192",
    ordering="nested",
    layer_id="value",
    min_order=11,
    tile_size=256,
    tile_dtype="uint16",
    quantize_min=-8,
    quantize_max=8,
    default_view="globe",
    colormap="turbo",
    scale="symlog",
    force=True,
    register=True,
)

Viewer("my-map-n8192", view="globe", order=13, cmap="turbo", scale="symlog").show()
```

The preferred selected Zarr layout is `(12 * nside_block**2, (nside / nside_block)**2)`
with dimensions `block, cell`. `block` is the global HEALPix NESTED id at
`block_order`, and `cell` is the local NESTED subcell id inside that block.
Arrays with leading axes such as `(time, block, cell)` should be sliced with
`select=`.

Passing `data=<numpy array>` is supported for convenience. For large nside 8192+
arrays, prefer Zarr `input=` to avoid writing an additional temporary copy and
to keep variables/time axes explicit.

## SSH Port Forwarding

Assume the processing machine runs both Jupyter and this viewer, and you open
Jupyter from another machine's browser. The browser renders both the notebook
page and the viewer iframe locally, so SSH must forward both ports:

- Jupyter server port, usually `8888`
- HEALPix viewer port, usually `4181`

Start Jupyter on the processing machine:

```sh
jupyter lab --no-browser --ip 127.0.0.1 --port 8888
```

From the browser/client machine, open one SSH tunnel with both forwards:

```sh
ssh -N \
  -L 8888:127.0.0.1:8888 \
  -L 4181:127.0.0.1:4181 \
  user@processing-host
```

Then open Jupyter locally:

```text
http://127.0.0.1:8888/
```

Inside that notebook:

```python
from hpxviewer import Viewer

Viewer(
    "spectral-noise-n8192",
    view="globe",
    order=13,
    cmap="turbo",
    scale="symlog",
).show()
```

`show()` starts the viewer server on the processing machine at
`127.0.0.1:4181`. The browser/client machine sees the iframe as
`http://127.0.0.1:4181/`, which is forwarded back to the processing machine.

If local port 4181 is already used, forward a different local port:

```sh
ssh -N \
  -L 8888:127.0.0.1:8888 \
  -L 14181:127.0.0.1:4181 \
  user@processing-host
```

Then tell the notebook which URL the local browser should use:

```python
Viewer(
    "spectral-noise-n8192",
    base_url="http://127.0.0.1:14181/",
    server_port=4181,
    view="globe",
    order=13,
).show()
```

You can generate the SSH command string from Python:

```python
from hpxviewer import ssh_forward_command

print(
    ssh_forward_command(
        "user@processing-host",
        jupyter_local_port=8888,
        jupyter_remote_port=8888,
        local_port=14181,
        remote_port=4181,
    )
)
```

## Notes

- MCP tool payloads are metadata/control only. Tile binary transfer remains HTTP.
- `capture_screenshot` writes PNGs under the repository root by default.
- `inspect_point` with lon/lat loads the target tile directly if it is not
  currently visible, so it can sample arbitrary locations without fighting the
  render loop's request cancellation.
