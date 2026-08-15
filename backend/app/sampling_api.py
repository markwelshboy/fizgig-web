from __future__ import annotations

import json
import os
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
    cfg_scale: float = Field(default=4.5, ge=0, le=30)
    seed: int = Field(default=42, ge=0, le=4294967295)


class SamplingAuthoring(BaseModel):
    seed_mode: Literal["fixed", "increment"] = "fixed"
    seed_value: int = Field(default=42, ge=0, le=4294967295)


class SamplingSchedule(BaseModel):
    sample_at_start: bool = True
    every_n_epochs: int = Field(default=1, ge=0, le=100000)
    every_n_steps: int = Field(default=0, ge=0, le=100000000)


class SamplingRenderer(BaseModel):
    use_distilled: bool = True
    cache_model: Literal["auto", "on", "off"] = "auto"
    steps: int = Field(default=40, ge=1, le=500)
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


def _default() -> dict:
    return SamplingPlan().model_dump()


@router.get("/{project_id}/sampling-plan")
def get_sampling_plan(project_id: str):
    path = _path(project_id)
    if not path.is_file():
        return _default()
    try:
        return SamplingPlan.model_validate_json(path.read_text(encoding="utf-8")).model_dump()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Invalid sampling plan: {exc}") from exc


@router.put("/{project_id}/sampling-plan")
def update_sampling_plan(project_id: str, request: SamplingPlan):
    project_dir = project_store.project_dir(project_id)
    path = _path(project_id)
    value = request.model_dump()
    value["schema_version"] = 1
    value["updated_at"] = _now()
    ids = [sample["id"] for sample in value["samples"]]
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=400, detail="Sample IDs must be unique")
    _write_json(path, value)
    project_store._event(
        project_dir,
        "sampling_plan_changed",
        sample_count=len(value["samples"]),
        enabled=value["enabled"],
    )
    return value


@router.post("/{project_id}/runs/{run_id}/training/start")
def start_training(project_id: str, run_id: str):
    try:
        return training_runtime.start(project_id, run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{project_id}/runs/{run_id}/training/status")
def training_status(project_id: str, run_id: str):
    try:
        return training_runtime.status(project_id, run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


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
    """Serve a generated preview image from a run-owned sample directory.

    Fizgig currently writes Krea previews to ``sample`` (singular); older web
    scaffolding also created ``samples``. Only a direct basename with a supported
    image extension can be read, and the resolved path must remain inside the run.
    """
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
