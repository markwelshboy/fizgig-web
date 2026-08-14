from __future__ import annotations

import os
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
    }
