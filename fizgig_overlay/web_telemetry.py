"""Passive JSONL telemetry for the fizgig-web harness.

This module is copied into the pinned upstream Fizgig tree at image build time. It is deliberately
observation-only: no optimizer, loss, sampling, caption, or dataset state is changed here.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()


def _root() -> Path | None:
    raw = os.environ.get("FIZGIG_TELEMETRY_DIR", "").strip()
    return Path(raw).expanduser() if raw else None


def _append(relative: str, value: dict[str, Any]) -> None:
    root = _root()
    if root is None:
        return
    path = root / relative
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
        with _LOCK:
            with path.open("a", encoding="utf-8") as f:
                f.write(line)
                f.flush()
    except Exception:
        # Telemetry must never be able to break a training run.
        return


def emit_metric(*, epoch: int, step: int, loss: float, moving_average: float) -> None:
    _append("metrics.jsonl", {
        "type": "loss",
        "epoch": int(epoch) + 1,
        "step_in_epoch": int(step),
        "loss": float(loss),
        "loss_moving_average": float(moving_average),
    })


def emit_decision_snapshot(*, epoch: int, stats: dict[str, dict[str, Any]],
                           improving_count: int, plateaued: bool,
                           pending_count: int, best_epoch_estimate: int | None) -> None:
    images: dict[str, dict[str, Any]] = {}
    keep = {
        "verdict", "multiplier", "mean_residual", "mean_loss", "slope", "first", "last", "se",
        "trend_epochs", "baseline", "total_drop", "epochs", "improving", "release_votes", "stuck_epochs",
    }
    for key, state in stats.items():
        if "|" in str(key):
            continue
        images[str(key)] = {name: state[name] for name in keep if name in state}
    _append("loss_log/decision_history.jsonl", {
        "type": "loss_watch_epoch",
        "epoch": int(epoch),
        "improving_count": int(improving_count),
        "plateaued": bool(plateaued),
        "pending_count": int(pending_count),
        "best_epoch_estimate": best_epoch_estimate,
        "images": images,
    })
