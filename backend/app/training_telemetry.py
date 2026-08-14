from __future__ import annotations

import json
from collections import deque
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .projects import project_store


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
        },
        "metrics": metrics,
        "trajectories": trajectories,
        "decision_history": decisions,
        "problem_images": current_problem_state,
        "events": events,
        "assets": _asset_metadata(project_id, run, run_dir),
        "console_tail": _console_tail(console_path),
    }
