from __future__ import annotations

from collections.abc import Mapping
from html import escape
import json
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
import urllib.error
import urllib.request

from .paths import repo_root
from .selection import TileSelection
from .server import start_viewer

VIEW_STATE_SCHEMA = "healpix-tilemap.view-state.v1"


class Viewer:
    """Small notebook wrapper for opening the HEALPix tile map viewer."""

    def __init__(
        self,
        dataset: str,
        *,
        base_url: str | None = None,
        server_host: str = "127.0.0.1",
        server_port: int = 4181,
        layer: str | None = None,
        view: str | None = None,
        order: int | None = None,
        time: int | str | None = None,
        level: int | str | None = None,
        cmap: str | None = None,
        scale: str | None = None,
        min: float | None = None,
        max: float | None = None,
        relief: bool | None = None,
        grid: bool | None = None,
        remote: bool = False,
    ) -> None:
        self._view_state: dict[str, Any] | None = None
        self.base_url = base_url
        self.server_host = server_host
        self.server_port = server_port
        self.params: dict[str, object] = {"dataset": dataset}
        self.remote = remote
        self.set(
            layer=layer,
            view=view,
            order=order,
            time=time,
            level=level,
            cmap=cmap,
            scale=scale,
            min=min,
            max=max,
            relief=relief,
            grid=grid,
        )

    def set(self, **kwargs: object) -> "Viewer":
        for key, value in kwargs.items():
            if value is None:
                continue
            query_key = "cmap" if key == "colormap" else key
            if isinstance(value, bool):
                self.params[query_key] = "1" if value else "0"
            else:
                self.params[query_key] = value
            self._view_state = None
        return self

    def view_state(self) -> dict[str, Any]:
        """Return a reusable ``view_state.json`` compatible dictionary.

        The returned object can be saved with ``json.dump`` and later restored
        with ``Viewer.from_view_state`` or the browser's ``Load JSON`` button.
        """

        if self._view_state is not None:
            return _json_copy(self._view_state)
        return _view_state_from_params(self.params)

    @classmethod
    def from_view_state(
        cls,
        state: Mapping[str, Any] | str | Path,
        *,
        base_url: str | None = None,
        server_host: str = "127.0.0.1",
        server_port: int = 4181,
        remote: bool = False,
    ) -> "Viewer":
        """Create a notebook viewer from a saved view-state dictionary or file."""

        view_state = _load_view_state(state)
        params = _params_from_view_state(view_state)
        dataset = str(params.get("dataset") or "")
        if not dataset:
            raise ValueError("View state is missing datasetId/dataset.")
        viewer = cls(
            dataset,
            base_url=base_url,
            server_host=server_host,
            server_port=server_port,
            remote=remote,
        )
        viewer.params = params
        viewer._view_state = view_state
        return viewer

    def url(self, *, start_server: bool = True) -> str:
        if start_server:
            server = start_viewer(port=self.server_port, host=self.server_host)
        else:
            server = None
        base_url = self.base_url
        if base_url is None:
            base_url = server.url if server else f"http://127.0.0.1:{self.server_port}/"
        params = dict(self.params)
        if self.remote:
            params["remote"] = "1"
        return f"{base_url}?{urlencode(params)}"

    def selection(self, *, timeout: float | None = None, interval: float = 0.25) -> dict | None:
        """Return the last point or right-drag tile selection in the viewer.

        If ``timeout`` is set, wait until a selection is available or the timeout
        expires. The viewer server must be reachable from the kernel at
        ``server_host:server_port``.
        """

        started = time.monotonic()
        while True:
            selection = self._request_selection("GET")
            if selection is not None or timeout is None:
                return selection
            if time.monotonic() - started >= timeout:
                return None
            time.sleep(interval)

    def clear_selection(self) -> None:
        self._request_selection("DELETE")

    def tile_selection(self, *, timeout: float | None = None, interval: float = 0.25) -> TileSelection | None:
        """Return the last tile selection as an analysis helper."""

        return TileSelection.from_selection(self.selection(timeout=timeout, interval=interval))

    def show(
        self,
        width: str | int = "100%",
        height: int = 780,
        *,
        start_server: bool = True,
        iframe: bool = True,
        link: bool = True,
    ) -> str:
        url = self.url(start_server=start_server)
        try:
            from IPython.display import HTML, display
        except ImportError:
            return url
        display(HTML(self.html(url=url, width=width, height=height, iframe=iframe, link=link)))
        return url

    def _request_selection(self, method: str) -> dict | None:
        request = urllib.request.Request(
            f"http://{self.server_host}:{self.server_port}/api/selection",
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.URLError as error:
            raise RuntimeError(
                f"Viewer selection API is not reachable at {self.server_host}:{self.server_port}. "
                "Run Viewer(...).show() or start the viewer server first."
            ) from error
        return payload.get("selection")

    def html(
        self,
        *,
        url: str | None = None,
        width: str | int = "100%",
        height: int = 780,
        iframe: bool = True,
        link: bool = True,
    ) -> str:
        url = url or self.url()
        safe_url = escape(url, quote=True)
        width_css = f"{width}px" if isinstance(width, int) else str(width)
        expected_dataset = json.dumps(str(self.params.get("dataset", "")))
        view_state_json = json.dumps(self.view_state(), separators=(",", ":"))
        parts: list[str] = [
            '<div style="font-family: system-ui, sans-serif; max-width: 100%;">',
        ]
        if link:
            parts.append(
                '<div style="display:flex; gap:12px; align-items:center; margin: 0 0 8px 0;">'
                f'<a href="{safe_url}" target="hpxviewer-viewer" rel="opener" '
                'style="display:inline-block; padding:6px 10px; border:1px solid #888; '
                'border-radius:6px; text-decoration:none; color:inherit;">'
                "Open HEALPix viewer in new tab"
                "</a>"
                f'<code style="font-size:12px; overflow-wrap:anywhere;">{safe_url}</code>'
                "</div>"
            )
        if iframe:
            parts.append(
                f'<iframe src="{safe_url}" width="{escape(width_css, quote=True)}" height="{int(height)}" '
                'style="border:1px solid #444; border-radius:6px; background:#202326;" '
                'allow="clipboard-read; clipboard-write"></iframe>'
            )
        parts.append(
            '<script>'
            "(function(){"
            f"const expectedDataset={expected_dataset};"
            "const root=document.currentScript.parentElement;"
            "let panel=root.querySelector('[data-hpx-selection]');"
            "if(!panel){panel=document.createElement('pre');panel.dataset.hpxSelection='1';"
            "panel.style.cssText='margin:8px 0 0 0;padding:8px;border:1px solid #666;"
            "border-radius:6px;max-height:180px;overflow:auto;font-size:12px;white-space:pre-wrap;';"
            "panel.textContent='Click for a cell, or right-drag across tiles. Then call v.selection() in Python.';"
            "root.appendChild(panel);}"
            "window.addEventListener('message',function(event){"
            "if(!event.data||event.data.type!=='hpxviewer:selected')return;"
            "if(expectedDataset&&event.data.payload&&event.data.payload.datasetId!==expectedDataset)return;"
            "panel.textContent=JSON.stringify(event.data.payload,null,2);"
            "});"
            f"const viewState={view_state_json};"
            "const frame=root.querySelector('iframe');"
            "if(frame&&viewState){"
            "let attempts=0;"
            "let applied=false;"
            "window.addEventListener('message',function(event){"
            "if(event.source===frame.contentWindow&&event.data&&event.data.type==='hpxviewer:viewStateApplied')applied=true;"
            "});"
            "const sendViewState=function(){"
            "if(applied||!frame.contentWindow||attempts>=40)return;"
            "attempts+=1;"
            "frame.contentWindow.postMessage({type:'hpxviewer:setViewState',payload:viewState},'*');"
            "setTimeout(sendViewState,250);"
            "};"
            "frame.addEventListener('load',function(){attempts=0;applied=false;setTimeout(sendViewState,100);});"
            "setTimeout(sendViewState,100);"
            "}"
            "})();"
            "</script>"
        )
        parts.append("</div>")
        return "".join(parts)

    def capture(self, output: str | Path, *, width: int = 1280, height: int = 900) -> Path:
        """Capture the viewer URL with headless Chrome.

        This does not require MCP; for richer remote control use the MCP server's
        ``open_view`` and ``capture_screenshot`` tools.
        """

        output_path = Path(output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "google-chrome",
                "--headless=new",
                "--no-sandbox",
                "--use-gl=egl",
                f"--window-size={width},{height}",
                f"--screenshot={output_path}",
                self.url(),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return output_path

    def save_image(
        self,
        output: str | Path,
        *,
        mode: str = "figure",
        format: str | None = None,
        scale: int = 1,
        width: int | None = None,
        height: int | None = None,
        viewport_width: int = 1280,
        viewport_height: int = 900,
        transparent: bool = False,
        embed_metadata: bool = True,
        start_server: bool = True,
        timeout: float = 60.0,
        chrome: str | None = None,
    ) -> Path:
        """Render the current view to an image without showing a browser window.

        The implementation starts or reuses the local viewer server, opens the
        viewer in headless Chrome, then calls the same browser-side export path
        as the interactive ``Save Image`` dialog.
        """

        output_path = Path(output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        export_format = format or output_path.suffix.lstrip(".") or "png"
        script = repo_root() / "tools" / "headless_export_image.mjs"
        view_state_path: Path | None = None
        command = [
            "node",
            str(script),
            "--url",
            self.url(start_server=start_server),
            "--output",
            str(output_path),
            "--mode",
            mode,
            "--format",
            export_format,
            "--scale",
            str(scale),
            "--viewport-width",
            str(viewport_width),
            "--viewport-height",
            str(viewport_height),
            "--timeout",
            str(timeout),
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".json", prefix="hpx-view-state-", delete=False) as file:
            json.dump(self.view_state(), file)
            view_state_path = Path(file.name)
        command.extend(["--view-state", str(view_state_path)])
        if width is not None:
            command.extend(["--width", str(width)])
        if height is not None:
            command.extend(["--height", str(height)])
        if transparent:
            command.append("--transparent")
        if not embed_metadata:
            command.append("--no-metadata")
        if chrome:
            command.extend(["--chrome", chrome])
        try:
            subprocess.run(command, check=True, cwd=repo_root())
        finally:
            if view_state_path is not None:
                view_state_path.unlink(missing_ok=True)
        return output_path

    def _repr_html_(self) -> str:
        return self.html()


def _load_view_state(state: Mapping[str, Any] | str | Path) -> dict[str, Any]:
    if isinstance(state, Mapping):
        return _json_copy(dict(state))
    if isinstance(state, Path):
        return _json_copy(json.loads(state.expanduser().read_text(encoding="utf-8")))
    text = str(state)
    stripped = text.lstrip()
    if stripped.startswith("{"):
        return _json_copy(json.loads(text))
    return _json_copy(json.loads(Path(text).expanduser().read_text(encoding="utf-8")))


def _view_state_from_params(params: Mapping[str, object]) -> dict[str, Any]:
    split = str(params.get("split") or "single")
    if split not in {"single", "vertical", "horizontal"}:
        split = "single"
    active_pane_id = str(params.get("pane") or "left")
    if active_pane_id not in {"left", "right"}:
        active_pane_id = "left"
    left = _pane_state_from_params(params, "")
    right = _pane_state_from_params(params, "right", fallback=left)
    panes = {"left": left, "right": right}
    active = panes.get(active_pane_id) or left
    export_state = {
        "mode": str(params.get("exportMode") or "active"),
        "scale": _int_or(params.get("exportScale"), 1),
        "width": str(params.get("exportWidth") or ""),
        "height": str(params.get("exportHeight") or ""),
        "embedMetadata": _bool_param(params.get("exportEmbedMetadata"), True),
        "transparent": _bool_param(params.get("exportTransparent"), False),
    }
    state: dict[str, Any] = {
        "schema": VIEW_STATE_SCHEMA,
        "type": "hpxviewer:view",
        "version": 2,
        "split": split,
        "splitMode": split,
        "activePaneId": active_pane_id,
        "linkCamera": _bool_param(params.get("linkCamera"), False),
        "linkDataset": _bool_param(params.get("linkDataset"), False),
        "linkColorScale": _bool_param(params.get("linkColorScale"), False),
        "footprint": _bool_param(params.get("footprint"), False),
        "showFootprint": _bool_param(params.get("footprint"), False),
        "footprintColor": str(params.get("footprintColor") or "#000000"),
        "overview": _bool_param(params.get("overview"), False),
        "overviewMode": _bool_param(params.get("overview"), False),
        "export": export_state,
        **active,
        "panes": panes,
    }
    return state


def _pane_state_from_params(
    params: Mapping[str, object],
    prefix: str,
    *,
    fallback: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    fallback = fallback or {}
    key = _prefixed_key(prefix)
    dataset = params.get(key("Dataset")) if prefix else params.get("dataset")
    layer = params.get(key("Layer")) if prefix else params.get("layer")
    view = params.get(key("View")) if prefix else params.get("view")
    order = params.get(key("Order")) if prefix else params.get("order")
    cmap = params.get(key("Cmap")) if prefix else params.get("cmap")
    scale = params.get(key("Scale")) if prefix else params.get("scale")
    min_value = params.get(key("Min")) if prefix else params.get("min")
    max_value = params.get(key("Max")) if prefix else params.get("max")
    camera = params.get(key("Camera")) if prefix else params.get("camera")
    time_value = params.get(key("Time")) if prefix else params.get("time")
    level_value = params.get(key("Level")) if prefix else params.get("level")
    selectors = dict(fallback.get("selectors", {})) if isinstance(fallback.get("selectors"), Mapping) else {}
    if time_value is not None:
        selectors["time"] = str(time_value)
    if level_value is not None:
        selectors["level"] = str(level_value)
    pane_id = "right" if prefix else "left"
    state: dict[str, Any] = {
        "paneId": pane_id,
        "datasetId": str(dataset or fallback.get("datasetId") or fallback.get("dataset") or ""),
        "layerId": str(layer or fallback.get("layerId") or fallback.get("layer") or ""),
        "selectors": selectors,
        "view": str(view or fallback.get("view") or "net"),
        "order": _int_or(order, _int_or(fallback.get("order"), 0)),
        "colormap": str(cmap or fallback.get("colormap") or fallback.get("cmap") or "viridis"),
        "scale": str(scale or fallback.get("scale") or "linear"),
        "min": _float_or(min_value, _float_or(fallback.get("min"), float("nan"))),
        "max": _float_or(max_value, _float_or(fallback.get("max"), float("nan"))),
        "relief": _bool_param(params.get("relief"), _bool_value(fallback.get("relief"), True)),
        "grid": _bool_param(params.get("grid"), _bool_value(fallback.get("grid"), False)),
        "axes": _bool_param(params.get("axes"), _bool_value(fallback.get("axes"), False)),
        "northUp": _bool_param(
            params.get("north"),
            _bool_value(fallback.get("northUp", fallback.get("north")), False),
        ),
        "graticule": _bool_param(params.get("graticule"), _bool_value(fallback.get("graticule"), False)),
        "scaleBar": _bool_param(
            params.get("scalebar"),
            _bool_value(fallback.get("scaleBar", fallback.get("scalebar")), False),
        ),
        "viewPanel": _bool_param(
            params.get("panel"),
            _bool_value(fallback.get("viewPanel", fallback.get("panel")), True),
        ),
    }
    if camera or fallback.get("camera"):
        state["camera"] = str(camera or fallback["camera"])
    return state


def _params_from_view_state(state: Mapping[str, Any]) -> dict[str, object]:
    split = _split_mode(state.get("splitMode", state.get("split", "single")))
    active_pane_id = str(state.get("activePaneId", state.get("paneId", state.get("pane", "left"))))
    if active_pane_id not in {"left", "right"}:
        active_pane_id = "left"
    panes = state.get("panes") if isinstance(state.get("panes"), Mapping) else {}
    left = _pane_from_view_state(state, "left", panes)
    right = _pane_from_view_state(state, "right", panes, fallback=left)
    base = right if split == "single" and active_pane_id == "right" else left
    params: dict[str, object] = {
        "split": split,
        "pane": active_pane_id,
        "dataset": base.get("datasetId", ""),
        "layer": base.get("layerId", ""),
        "view": base.get("view", "net"),
        "order": base.get("order", ""),
        "cmap": base.get("colormap", "viridis"),
        "scale": base.get("scale", "linear"),
        "relief": _query_bool(base.get("relief", True)),
        "grid": _query_bool(base.get("grid", False)),
        "axes": _query_bool(base.get("axes", False)),
        "north": _query_bool(base.get("northUp", base.get("north", False))),
        "graticule": _query_bool(base.get("graticule", False)),
        "scalebar": _query_bool(base.get("scaleBar", base.get("scalebar", False))),
        "panel": _query_bool(base.get("viewPanel", base.get("panel", True))),
        "linkCamera": _query_bool(state.get("linkCamera", False)),
        "linkDataset": _query_bool(state.get("linkDataset", False)),
        "linkColorScale": _query_bool(state.get("linkColorScale", False)),
        "footprint": _query_bool(state.get("showFootprint", state.get("footprint", False))),
        "footprintColor": str(state.get("footprintColor", "#000000")),
        "overview": _query_bool(state.get("overviewMode", state.get("overview", False))),
    }
    _copy_if_present(params, "min", base.get("min"))
    _copy_if_present(params, "max", base.get("max"))
    _copy_if_present(params, "camera", base.get("camera"))
    _copy_selector_params(params, base, "")
    if split != "single":
        params.update(
            {
                "rightDataset": right.get("datasetId", ""),
                "rightLayer": right.get("layerId", ""),
                "rightView": right.get("view", "net"),
                "rightOrder": right.get("order", ""),
                "rightCmap": right.get("colormap", "viridis"),
                "rightScale": right.get("scale", "linear"),
            }
        )
        _copy_if_present(params, "rightMin", right.get("min"))
        _copy_if_present(params, "rightMax", right.get("max"))
        _copy_if_present(params, "rightCamera", right.get("camera"))
        _copy_selector_params(params, right, "right")
    export_state = state.get("export")
    if isinstance(export_state, Mapping):
        _copy_if_present(params, "exportMode", export_state.get("mode"))
        _copy_if_present(params, "exportScale", export_state.get("scale"))
        _copy_if_present(params, "exportWidth", export_state.get("width"))
        _copy_if_present(params, "exportHeight", export_state.get("height"))
        _copy_if_present(params, "exportEmbedMetadata", _query_bool(export_state.get("embedMetadata", True)))
        _copy_if_present(params, "exportTransparent", _query_bool(export_state.get("transparent", False)))
    return {key: value for key, value in params.items() if value not in ("", None)}


def _pane_from_view_state(
    state: Mapping[str, Any],
    pane_id: str,
    panes: Mapping[str, Any],
    *,
    fallback: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    source = panes.get(pane_id)
    if not isinstance(source, Mapping):
        source = state if pane_id == str(state.get("paneId", "left")) or pane_id == "left" else {}
    fallback = fallback or {}
    selectors = source.get("selectors")
    if not isinstance(selectors, Mapping):
        selectors = fallback.get("selectors") if isinstance(fallback.get("selectors"), Mapping) else {}
    selectors = {str(key): str(value) for key, value in dict(selectors).items()}
    if source.get("time") is not None:
        selectors["time"] = str(source.get("time"))
    if source.get("level") is not None:
        selectors["level"] = str(source.get("level"))
    return {
        "paneId": pane_id,
        "datasetId": str(source.get("datasetId", source.get("dataset", fallback.get("datasetId", "")))),
        "layerId": str(source.get("layerId", source.get("layer", fallback.get("layerId", "")))),
        "selectors": selectors,
        "view": str(source.get("view", fallback.get("view", "net"))),
        "order": _int_or(source.get("order", source.get("maxOrder")), _int_or(fallback.get("order"), 0)),
        "colormap": str(source.get("colormap", source.get("cmap", fallback.get("colormap", "viridis")))),
        "scale": str(source.get("scale", fallback.get("scale", "linear"))),
        "min": _float_or(source.get("min"), _float_or(fallback.get("min"), float("nan"))),
        "max": _float_or(source.get("max"), _float_or(fallback.get("max"), float("nan"))),
        "relief": _bool_value(source.get("relief", fallback.get("relief")), True),
        "grid": _bool_value(source.get("grid", fallback.get("grid")), False),
        "axes": _bool_value(source.get("axes", fallback.get("axes")), False),
        "northUp": _bool_value(source.get("northUp", source.get("north", fallback.get("northUp"))), False),
        "graticule": _bool_value(source.get("graticule", fallback.get("graticule")), False),
        "scaleBar": _bool_value(source.get("scaleBar", source.get("scalebar", fallback.get("scaleBar"))), False),
        "viewPanel": _bool_value(source.get("viewPanel", source.get("panel", fallback.get("viewPanel"))), True),
        **({"camera": str(source.get("camera"))} if source.get("camera") is not None else {}),
    }


def _split_mode(value: Any) -> str:
    return str(value) if value in {"single", "vertical", "horizontal"} else "single"


def _prefixed_key(prefix: str):
    return lambda name: f"{prefix}{name}"


def _copy_if_present(params: dict[str, object], key: str, value: Any) -> None:
    if value is not None and value != "":
        params[key] = value


def _copy_selector_params(params: dict[str, object], state: Mapping[str, Any], prefix: str) -> None:
    selectors = state.get("selectors")
    if not isinstance(selectors, Mapping):
        return
    for name in ("time", "level"):
        value = selectors.get(name)
        if value is None or value == "":
            continue
        params[f"{prefix}{name[:1].upper()}{name[1:]}" if prefix else name] = value


def _bool_param(value: object, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return fallback


def _bool_value(value: object, fallback: bool = False) -> bool:
    if value is None:
        return fallback
    return _bool_param(value, fallback)


def _query_bool(value: object) -> str:
    return "1" if _bool_value(value, False) else "0"


def _int_or(value: object, fallback: int) -> int:
    try:
        number = int(str(value))
    except (TypeError, ValueError):
        return fallback
    return number


def _float_or(value: object, fallback: float) -> float:
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return fallback


def _json_copy(value: Any) -> Any:
    return json.loads(json.dumps(value, allow_nan=True))
