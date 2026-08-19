from __future__ import annotations

import json
import re
from collections import deque
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .projects import project_store


_SAMPLE_NAME_RE = re.compile(
    r"_e(?P<epoch>\d{6})_(?P<index>\d{2})_(?P<timestamp>\d{14})_(?P<seed>\d+)\.(?P<ext>png|jpe?g|webp)$",
    re.IGNORECASE,
)
_SAMPLE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def _read_jsonl(path: Path, limit: int) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: deque[dict[str, Any]] = deque(maxlen=max(1, limit))
    try:
        with path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    rows.append(value)
    except OSError:
        return []
    return list(rows)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _console_tail(path: Path, limit: int = 250) -> list[str]:
    if not path.is_file():
        return []
    rows: deque[str] = deque(maxlen=max(1, limit))
    try:
        with path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                rows.append(line.rstrip("\n"))
    except OSError:
        return []
    return list(rows)


def _asset_metadata(project_id: str, run: dict[str, Any], run_dir: Path) -> list[dict[str, str]]:
    """Return the run's frozen trainer-name -> project-image mapping.

    Fizgig's loss watcher identifies an item by basename without extension. The
    run snapshot already records both the normalized trainer filename and the
    original project filename, so telemetry can show the actual image without
    guessing from the live working revision.
    """
    snapshot = _read_json(run_dir / "dataset_snapshot.json") or {}
    revision_id = str(run.get("dataset_revision", ""))
    rows: list[dict[str, str]] = []
    for asset in snapshot.get("assets", []):
        if not isinstance(asset, dict):
            continue
        training_filename = str(asset.get("training_filename") or asset.get("filename") or "").strip()
        project_filename = str(asset.get("project_filename") or asset.get("filename") or "").strip()
        if not training_filename or not project_filename:
            continue
        key = Path(training_filename).stem
        rows.append({
            "key": key,
            "training_filename": training_filename,
            "project_filename": project_filename,
            "preview_url": (
                f"/api/projects/{quote(project_id, safe='')}/revisions/{quote(revision_id, safe='')}"
                f"/prep/assets/{quote(project_filename, safe='')}/prepared-preview"
            ),
        })
    return rows


def _sample_metadata(project_id: str, run_id: str, run_dir: Path) -> list[dict[str, Any]]:
    """List Fizgig preview images without exposing arbitrary run-local paths.

    Upstream Krea writes previews to ``<output_dir>/sample`` (singular), while
    early web project scaffolding created ``samples``. Scan both so imported old
    runs and future runs render consistently. The standard Fizgig filename embeds
    epoch, prompt index, timestamp and seed; unknown image names are still shown.
    """
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for directory_name in ("sample", "samples"):
        directory = run_dir / directory_name
        if not directory.is_dir():
            continue
        for path in sorted(directory.iterdir(), key=lambda item: (item.stat().st_mtime_ns if item.is_file() else 0, item.name)):
            if not path.is_file() or path.suffix.lower() not in _SAMPLE_EXTENSIONS or path.name in seen:
                continue
            seen.add(path.name)
            match = _SAMPLE_NAME_RE.search(path.name)
            rows.append({
                "filename": path.name,
                "epoch": int(match.group("epoch")) if match else None,
                "sample_index": int(match.group("index")) if match else None,
                "seed": int(match.group("seed")) if match else None,
                "timestamp": match.group("timestamp") if match else None,
                "source_dir": directory_name,
                "url": (
                    f"/api/projects/{quote(project_id, safe='')}/runs/{quote(run_id, safe='')}"
                    f"/samples/{quote(path.name, safe='')}"
                ),
            })
    rows.sort(key=lambda row: (
        row["epoch"] if isinstance(row.get("epoch"), int) else -1,
        row["sample_index"] if isinstance(row.get("sample_index"), int) else -1,
        str(row.get("timestamp") or ""),
        str(row.get("filename") or ""),
    ))
    return rows


def snapshot(project_id: str, run_id: str) -> dict[str, Any]:
    run = project_store.get_run(project_id, run_id)
    run_dir = Path(run["output_dir"]).resolve()
    project_dir = project_store.project_dir(project_id)
    if project_dir not in run_dir.parents:
        raise ValueError("Run output path is outside the project")

    metrics_path = run_dir / "metrics.jsonl"
    per_image_path = run_dir / "loss_log" / "per_image_loss.jsonl"
    decisions_path = run_dir / "loss_log" / "decision_history.jsonl"
    problem_path = run_dir / "loss_log" / "problem_images.json"
    events_path = run_dir / "events.jsonl"
    console_path = run_dir / "console.log"

    metrics = _read_jsonl(metrics_path, 12000)
    per_image = _read_jsonl(per_image_path, 60000)
    decisions = _read_jsonl(decisions_path, 5000)
    events = _read_jsonl(events_path, 5000)
    current_problem_state = _read_json(problem_path)
    dataset_snapshot = _read_json(run_dir / "dataset_snapshot.json")
    run_policy = _read_json(run_dir / "run_policy.json")
    caption_updates_applied = _read_json(run_dir / "loss_log" / "caption_updates_applied.json")

    # The browser wants stable asset trajectories, not a giant undifferentiated JSONL.
    trajectories: dict[str, list[dict[str, Any]]] = {}
    for row in per_image:
        key = str(row.get("key", "")).strip()
        if not key or "|" in key:
            continue
        trajectories.setdefault(key, []).append(row)

    return {
        "run_id": run_id,
        "status": run.get("status", "prepared"),
        "software": run.get("software", {}),
        "files": {
            "metrics": metrics_path.is_file(),
            "per_image_loss": per_image_path.is_file(),
            "decision_history": decisions_path.is_file(),
            "problem_images": problem_path.is_file(),
            "events": events_path.is_file(),
            "console": console_path.is_file(),
            "dataset_snapshot": dataset_snapshot is not None,
            "run_policy": run_policy is not None,
            "caption_updates_applied": caption_updates_applied is not None,
        },
        "metrics": metrics,
        "trajectories": trajectories,
        "decision_history": decisions,
        "problem_images": current_problem_state,
        "events": events,
        "assets": _asset_metadata(project_id, run, run_dir),
        "samples": _sample_metadata(project_id, run_id, run_dir),
        "dataset_snapshot": dataset_snapshot,
        "run_policy": run_policy,
        "caption_updates_applied": caption_updates_applied,
        "console_tail": _console_tail(console_path),
    }
