from __future__ import annotations


def ssh_forward_command(
    remote: str,
    *,
    local_port: int = 4181,
    remote_port: int = 4181,
    remote_host: str = "127.0.0.1",
    jupyter_local_port: int | None = None,
    jupyter_remote_port: int = 8888,
    extra: str = "",
) -> str:
    """Return an SSH local port-forwarding command for Jupyter and the viewer."""

    forwards = []
    if jupyter_local_port is not None:
        forwards.extend(["-L", f"{jupyter_local_port}:{remote_host}:{jupyter_remote_port}"])
    forwards.extend(["-L", f"{local_port}:{remote_host}:{remote_port}"])
    suffix = f" {extra.strip()}" if extra.strip() else ""
    return f"ssh -N {' '.join(forwards)} {remote}{suffix}"
