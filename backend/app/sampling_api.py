from __future__ import annotations

import json
import os
import shutil
import signal
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from .projects import project_store
from .training_runtime import training_runtime
from .training_telemetry import snapshot as training_telemetry_snapshot

router = APIRouter(prefix="/api/projects", tags=["sampling", "training"])

_SAMPLE_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
_ACTIVE_RUN_STATES = {"starting", "cache_latents", "cache_text", "training", "stopping"}
_RUN_SCRIPT_MARKERS = ("krea2_cache_latents.py", "krea2_cache_text.py", "krea2_train.py")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, value: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


class SampleDefinition(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    prompt_template: str = Field(min_length=1, max_length=10000)
    width: int = Field(default=1024, ge=128, le=4096)
    height: int = Field(default=1024, ge=128, le=4096)
    cfg_scale: float = Field(default=1.0, ge=0, le=30)
    seed: int = Field(default=42, ge=0, le=4294967295)


class SamplingAuthoring(BaseModel):
    # Fizgig's stock Krea preview renderer consumes one base seed and renders prompt i
    # with base_seed+i, so increment is the least-surprising default for a new plan.
    seed_mode: Literal["fixed", "increment"] = "increment"
    seed_value: int = Field(default=42, ge=0, le=4294967295)


class SamplingSchedule(BaseModel):
    sample_at_start: bool = True
    every_n_epochs: int = Field(default=1, ge=0, le=100000)
    every_n_steps: int = Field(default=0, ge=0, le=100000000)


class SamplingRenderer(BaseModel):
    use_distilled: bool = True
    cache_model: Literal["auto", "on", "off"] = "auto"
    steps: int = Field(default=8, ge=1, le=500)
    negative_prompt: str = Field(default="blurry, low detail, noisy, washed out, oversaturated, distorted", max_length=10000)
    flow_shift: float | None = Field(default=None, ge=0, le=100)


class SamplingPlan(BaseModel):
    schema_version: int = 1
    enabled: bool = True
    authoring: SamplingAuthoring = Field(default_factory=SamplingAuthoring)
    schedule: SamplingSchedule = Field(default_factory=SamplingSchedule)
    renderer: SamplingRenderer = Field(default_factory=SamplingRenderer)
    samples: list[SampleDefinition] = Field(default_factory=list)
    updated_at: str | None = None


def _path(project_id: str) -> Path:
    try:
        return project_store.project_dir(project_id) / "sampling_plan.json"
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _normalize_sampling_plan(value: dict) -> dict:
    """Apply the actual stock Krea Turbo preview contract.

    Fizgig's Turbo preview path is the 8-step CFG-free path. Older web plans may
    still contain generic 40-step / CFG 4.5 values from before the native Krea
    preview wiring existed. Do not carry those stale generic values into a run.
    Preserve the negative prompt so it is still available if a future undistilled
    renderer uses it, but it is intentionally unused while Turbo/CFG-free is on.
    """
    normalized = json.loads(json.dumps(value))
    renderer = normalized.setdefault("renderer", {})
    if renderer.get("use_distilled", True):
        renderer["steps"] = 8
        renderer["flow_shift"] = None
        for sample in normalized.get("samples", []):
            if isinstance(sample, dict):
                sample["cfg_scale"] = 1.0
    return normalized


def _default() -> dict:
    return _normalize_sampling_plan(SamplingPlan().model_dump())


def _validated_run_dir(project_id: str, run_id: str) -> tuple[dict, Path, Path]:
    run = project_store.get_run(project_id, run_id)
    project_dir = project_store.project_dir(project_id)
    run_dir = Path(str(run.get("output_dir") or "")).resolve()
    if project_dir not in run_dir.parents:
        raise ValueError("Run output path is outside the project")
    return run, run_dir, project_dir


def _run_process_ids(run_dir: Path) -> list[int]:
    """Find only Fizgig child commands whose argv points at this exact run.

    Cache commands carry the run-local Fizgig_train.toml path and the trainer
    carries --output_dir, so matching the resolved run directory prevents a stop
    request for one run from touching another run on the same pod.
    """
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return []
    needle = str(run_dir)
    result: list[int] = []
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == os.getpid():
            continue
        try:
            raw = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        if not raw:
            continue
        command = raw.replace(b"\x00", b" ").decode("utf-8", errors="replace")
        if needle not in command:
            continue
        if not any(marker in command for marker in _RUN_SCRIPT_MARKERS):
            continue
        result.append(pid)
    return result


def _signal_run_processes(run_dir: Path, sig: signal.Signals) -> list[int]:
    signalled: list[int] = []
    for pid in _run_process_ids(run_dir):
        try:
            os.kill(pid, sig)
            signalled.append(pid)
        except (ProcessLookupError, PermissionError):
            continue
    return signalled


def _finalize_stop(project_id: str, run_id: str, run_dir: Path) -> None:
    """Keep terminating the run-local child until the worker has unwound.

    TrainingRuntime already owns process lifecycle and will briefly classify a
    SIGTERM exit as failed while its worker unwinds. We wait until that worker is
    actually dead, then make the user-requested terminal state authoritative.
    """
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        _signal_run_processes(run_dir, signal.SIGTERM)
        try:
            status = training_runtime.status(project_id, run_id)
        except FileNotFoundError:
            return
        if not status.get("worker_alive") and not _run_process_ids(run_dir):
            break
        time.sleep(0.25)
    else:
        _signal_run_processes(run_dir, signal.SIGKILL)
        hard_deadline = time.monotonic() + 5.0
        while time.monotonic() < hard_deadline:
            try:
                status = training_runtime.status(project_id, run_id)
            except FileNotFoundError:
                return
            if not status.get("worker_alive") and not _run_process_ids(run_dir):
                break
            time.sleep(0.2)
        else:
            try:
                project_store.append_run_event(project_id, run_id, "training_stop_timeout", {})
            except Exception:
                pass
            return

    try:
        stopped = training_runtime._set_status(
            project_id,
            run_id,
            "stopped",
            stopped_at=_now(),
            failed_at=None,
            error=None,
        )
        project_store.append_run_event(project_id, run_id, "training_stopped", {"stopped_at": stopped.get("stopped_at")})
        with (run_dir / "console.log").open("a", encoding="utf-8") as log:
            log.write(f"[{_now()}] === run stopped by user ===\n")
    except (FileNotFoundError, ValueError):
        return


@router.get("/{project_id}/sampling-plan")
def get_sampling_plan(project_id: str):
    path = _path(project_id)
    if not path.is_file():
        return _default()
    try:
        value = SamplingPlan.model_validate_json(path.read_text(encoding="utf-8")).model_dump()
        return _normalize_sampling_plan(value)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Invalid sampling plan: {exc}") from exc


@router.put("/{project_id}/sampling-plan")
def update_sampling_plan(project_id: str, request: SamplingPlan):
    project_dir = project_store.project_dir(project_id)
    path = _path(project_id)
    value = _normalize_sampling_plan(request.model_dump())
    value["schema_version"] = 1
    value["updated_at"] = _now()
    ids = [sample["id"] for sample in value["samples"]]
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=400, detail="Sample IDs must be unique")
    _write_json(path, value)
    project_store._event(project_dir, "sampling_plan_changed", sample_count=len(value["samples"]), enabled=value["enabled"])
    return value


@router.post("/{project_id}/runs/{run_id}/training/start")
def start_training(project_id: str, run_id: str):
    try:
        return training_runtime.start(project_id, run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{project_id}/runs/{run_id}/training/stop")
def stop_training(project_id: str, run_id: str):
    try:
        run, run_dir, _ = _validated_run_dir(project_id, run_id)
        status = training_runtime.status(project_id, run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if run.get("status") == "stopping":
        return status
    if run.get("status") not in _ACTIVE_RUN_STATES and not status.get("worker_alive"):
        raise HTTPException(status_code=400, detail=f"Run {run_id} is not active; current status is {run.get('status', 'unknown')}")

    requested_at = _now()
    training_runtime._set_status(project_id, run_id, "stopping", stop_requested_at=requested_at)
    pids = _signal_run_processes(run_dir, signal.SIGTERM)
    project_store.append_run_event(project_id, run_id, "training_stop_requested", {"requested_at": requested_at, "pids": pids})
    threading.Thread(
        target=_finalize_stop,
        args=(project_id, run_id, run_dir),
        daemon=True,
        name=f"fizgig-stop-{run_id}",
    ).start()
    return training_runtime.status(project_id, run_id)


@router.get("/{project_id}/runs/{run_id}/training/status")
def training_status(project_id: str, run_id: str):
    try:
        return training_runtime.status(project_id, run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{project_id}/runs/{run_id}")
def delete_training_run(project_id: str, run_id: str):
    """Purge run-owned bytes while retaining a tiny ID tombstone for monotonic IDs."""
    try:
        run, run_dir, project_dir = _validated_run_dir(project_id, run_id)
        runtime_status = training_runtime.status(project_id, run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if runtime_status.get("worker_alive") or run.get("status") in _ACTIVE_RUN_STATES:
        raise HTTPException(status_code=409, detail="Stop this run before deleting it.")

    project = project_store.get_project(project_id)
    summary = next((item for item in project.get("runs", []) if item.get("id") == run_id), None)
    if summary is None:
        raise HTTPException(status_code=404, detail=f"Unknown run: {run_id}")

    shutil.rmtree(run_dir, ignore_errors=False)
    deleted_at = _now()
    summary["status"] = "deleted"
    summary["deleted_at"] = deleted_at
    summary["purged"] = True
    if project.get("current_run") == run_id:
        remaining = [item for item in project.get("runs", []) if item.get("status") != "deleted"]
        project["current_run"] = remaining[-1]["id"] if remaining else None
    project_store._save_project(project_dir, project)
    project_store._event(project_dir, "run_deleted", run_id=run_id, deleted_at=deleted_at, previous_status=run.get("status"))
    return project_store.get_project(project_id)


@router.get("/{project_id}/runs/{run_id}/telemetry")
def training_telemetry(project_id: str, run_id: str):
    try:
        return training_telemetry_snapshot(project_id, run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{project_id}/runs/{run_id}/samples/{filename}")
def training_sample_image(project_id: str, run_id: str, filename: str) -> Response:
    if filename != Path(filename).name:
        raise HTTPException(status_code=400, detail="Invalid sample filename")
    media_type = _SAMPLE_MEDIA_TYPES.get(Path(filename).suffix.lower())
    if media_type is None:
        raise HTTPException(status_code=404, detail="Unknown sample image")

    try:
        run = project_store.get_run(project_id, run_id)
        project_dir = project_store.project_dir(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    run_dir = Path(str(run.get("output_dir") or "")).resolve()
    if project_dir not in run_dir.parents:
        raise HTTPException(status_code=400, detail="Run output path is outside the project")

    for directory_name in ("sample", "samples"):
        directory = (run_dir / directory_name).resolve()
        candidate = (directory / filename).resolve()
        if candidate.parent != directory:
            continue
        if candidate.is_file():
            try:
                content = candidate.read_bytes()
            except OSError as exc:
                raise HTTPException(status_code=500, detail=f"Unable to read sample image: {exc}") from exc
            return Response(content=content, media_type=media_type, headers={"Cache-Control": "no-store"})

    raise HTTPException(status_code=404, detail="Unknown sample image")