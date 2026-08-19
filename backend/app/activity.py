from __future__ import annotations

import threading
import time
import uuid
from typing import Any


class ActivityTracker:
    """Small process-local activity registry for long-running web commands.

    It intentionally reports command activity rather than GPU utilization. Caption generation,
    image-prep work, run preparation and the future training job manager can all publish through
    the same UI contract.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._active: dict[str, dict[str, Any]] = {}

    def begin(self, label: str, detail: str = "") -> str:
        token = uuid.uuid4().hex
        with self._lock:
            self._active[token] = {
                "label": label,
                "detail": detail,
                "started_monotonic": time.monotonic(),
            }
        return token

    def end(self, token: str) -> None:
        with self._lock:
            self._active.pop(token, None)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            active = list(self._active.values())
        if not active:
            return {"busy": False, "label": "Idle", "detail": "", "active_count": 0, "elapsed_seconds": 0.0}
        current = min(active, key=lambda item: item["started_monotonic"])
        return {
            "busy": True,
            "label": str(current["label"]),
            "detail": str(current.get("detail", "")),
            "active_count": len(active),
            "elapsed_seconds": round(max(0.0, time.monotonic() - float(current["started_monotonic"])), 1),
        }


activity_tracker = ActivityTracker()
