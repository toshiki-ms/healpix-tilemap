from __future__ import annotations

from html import escape
import json
import subprocess
import time
from pathlib import Path
from urllib.parse import urlencode
import urllib.error
import urllib.request

from .paths import repo_root
from .selection import TileSelection
from .server import start_viewer


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
        cmap: str | None = None,
        scale: str | None = None,
        min: float | None = None,
        max: float | None = None,
        relief: bool | None = None,
        grid: bool | None = None,
        remote: bool = False,
    ) -> None:
        self.base_url = base_url
        self.server_host = server_host
        self.server_port = server_port
        self.params: dict[str, object] = {"dataset": dataset}
        self.remote = remote
        self.set(
            layer=layer,
            view=view,
            order=order,
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
        return self

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
        subprocess.run(command, check=True, cwd=repo_root())
        return output_path

    def _repr_html_(self) -> str:
        return self.html()
