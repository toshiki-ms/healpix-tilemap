from __future__ import annotations

import subprocess
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .paths import repo_root


@dataclass
class ViewerServer:
    url: str
    process: subprocess.Popen[str] | None = None

    def stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()


_SERVER: ViewerServer | None = None


def start_viewer(port: int = 4181, host: str = "127.0.0.1", *, timeout: float = 20.0) -> ViewerServer:
    """Start a local Vite dev server for notebook display."""

    global _SERVER
    url = f"http://{host}:{port}/"
    if _is_serving(url):
        _SERVER = ViewerServer(url=url)
        return _SERVER
    if _SERVER is not None and _SERVER.process and _SERVER.process.poll() is None:
        return _SERVER

    root = repo_root()
    subprocess.run(["npm", "run", "build"], cwd=root, check=True)
    process = subprocess.Popen(
        ["npx", "vite", "preview", "--host", host, "--port", str(port), "--strictPort"],
        cwd=root,
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    _SERVER = ViewerServer(url=url, process=process)
    _wait_for_server(url, timeout)
    return _SERVER


def stop_viewer() -> None:
    global _SERVER
    if _SERVER is not None:
        _SERVER.stop()
    _SERVER = None


def _wait_for_server(url: str, timeout: float) -> None:
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        if _is_serving(url):
            return
        time.sleep(0.25)
    raise TimeoutError(f"Timed out waiting for viewer server: {url}")


def _is_serving(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return 200 <= response.status < 500
    except Exception:
        return False
