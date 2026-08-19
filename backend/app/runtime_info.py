from __future__ import annotations

import os
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any


def fizgig_commit() -> str:
    root = Path(os.environ.get("FIZGIG_ROOT", "/opt/Fizgig")).expanduser()
    marker = root / ".fizgig-web-built-ref"
    try:
        value = marker.read_text(encoding="utf-8").strip()
        if value:
            return value
    except OSError:
        pass
    return os.environ.get("FIZGIG_UPSTREAM_REF", "unknown") or "unknown"


def _gpu_snapshot() -> dict[str, Any]:
    """Use nvidia-smi rather than torch.cuda so the API process never owns a CUDA context."""
    try:
        output = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=name,driver_version,pci.bus_id",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=3,
        ).strip()
        rows = []
        for line in output.splitlines():
            parts = [part.strip() for part in line.split(",")]
            rows.append({
                "name": parts[0] if len(parts) > 0 else "unknown",
                "driver_version": parts[1] if len(parts) > 1 else "unknown",
                "pci_bus_id": parts[2] if len(parts) > 2 else "unknown",
            })
        return {"gpus": rows}
    except Exception as exc:
        return {"gpus": [], "error": f"{type(exc).__name__}: {exc}"}


def _torch_snapshot() -> dict[str, Any]:
    try:
        import torch

        try:
            cudnn = torch.backends.cudnn.version()
        except Exception:
            cudnn = None
        return {
            "version": getattr(torch, "__version__", "unknown"),
            "cuda_build": getattr(getattr(torch, "version", None), "cuda", None),
            "cudnn_version": cudnn,
            "deterministic_algorithms": bool(torch.are_deterministic_algorithms_enabled()),
            "cudnn_deterministic": bool(getattr(torch.backends.cudnn, "deterministic", False)),
            "cudnn_benchmark": bool(getattr(torch.backends.cudnn, "benchmark", False)),
        }
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def software_snapshot() -> dict[str, Any]:
    return {
        "fizgig": {
            "repository": os.environ.get("FIZGIG_UPSTREAM_REPO", "https://github.com/shootthesound/Fizgig.git"),
            "requested_ref": os.environ.get("FIZGIG_UPSTREAM_REF", "unknown"),
            "commit": fizgig_commit(),
        },
        "fizgig_web": {
            "image_version": os.environ.get("FIZGIG_WEB_IMAGE_VERSION", "dev"),
            "vcs_ref": os.environ.get("FIZGIG_WEB_VCS_REF", "unknown"),
            "build_date": os.environ.get("FIZGIG_WEB_BUILD_DATE", "unknown"),
        },
        "runtime": {
            "python": sys.version.split()[0],
            "python_implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "torch": _torch_snapshot(),
            "gpu": _gpu_snapshot(),
        },
    }
