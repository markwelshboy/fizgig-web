from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .image_prep import image_prep_store
from .project_captions import project_caption_store
from .projects import project_store

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str
    source_path: str
    trigger_word: str = ""
    description: str = ""


class RevisionCreate(BaseModel):
    name: str
    model_family: str = "generic"
    parent_revision: str | None = None
    import_id: str | None = None


class RunCreate(BaseModel):
    name: str
    model_family: str
    dataset_revision: str
    trigger_word: str = ""
    config: dict[str, Any] = Field(default_factory=dict)


class RunEventCreate(BaseModel):
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ArtifactCreate(BaseModel):
    type: str
    path: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectCaptionUpdate(BaseModel):
    caption: str
    reason: str = "manual_edit"
    metadata: dict[str, Any] = Field(default_factory=dict)
    materialize: bool = False
    run_id: str | None = None


class InclusionUpdate(BaseModel):
    filenames: list[str] = Field(default_factory=list)
    included: bool


class PrepOperationCreate(BaseModel):
    filenames: list[str] = Field(default_factory=list)
    operation: dict[str, Any] = Field(default_factory=dict)


def _not_found(exc: Exception) -> HTTPException:
    return HTTPException(status_code=404, detail=str(exc))


@router.get("")
def list_projects() -> list[dict[str, Any]]:
    return project_store.list_projects()


@router.post("")
def create_project(request: ProjectCreate) -> dict[str, Any]:
    try:
        return project_store.create_project(name=request.name, source_path=request.source_path, trigger_word=request.trigger_word, description=request.description)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{project_id}")
def get_project(project_id: str) -> dict[str, Any]:
    try:
        return project_store.get_project(project_id)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc


@router.post("/{project_id}/revisions")
def create_revision(project_id: str, request: RevisionCreate) -> dict[str, Any]:
    try:
        return project_store.create_revision(project_id, name=request.name, model_family=request.model_family, parent_revision=request.parent_revision, import_id=request.import_id)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{project_id}/revisions/{revision_id}")
def get_revision(project_id: str, revision_id: str) -> dict[str, Any]:
    try:
        return project_store.get_revision(project_id, revision_id)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc


@router.get("/{project_id}/revisions/{revision_id}/prep")
def get_image_prep_state(project_id: str, revision_id: str) -> dict[str, Any]:
    try:
        return image_prep_store.state(project_id, revision_id)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc


@router.put("/{project_id}/revisions/{revision_id}/prep/inclusion")
def update_image_inclusion(project_id: str, revision_id: str, request: InclusionUpdate) -> dict[str, Any]:
    try:
        return image_prep_store.set_inclusion(project_id, revision_id, request.filenames, request.included)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc


@router.put("/{project_id}/revisions/{revision_id}/prep/inclusion-all")
def update_all_image_inclusion(project_id: str, revision_id: str, request: InclusionUpdate) -> dict[str, Any]:
    try:
        return image_prep_store.set_all_inclusion(project_id, revision_id, request.included)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc


@router.post("/{project_id}/revisions/{revision_id}/prep/operations")
def queue_image_prep_operation(project_id: str, revision_id: str, request: PrepOperationCreate) -> dict[str, Any]:
    try:
        return image_prep_store.append_operation(project_id, revision_id, request.filenames, request.operation)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc


@router.get("/{project_id}/revisions/{revision_id}/captions/{filename}")
def get_project_caption(project_id: str, revision_id: str, filename: str) -> dict[str, Any]:
    try:
        return project_caption_store.get_caption(project_id, revision_id, filename)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc


@router.put("/{project_id}/revisions/{revision_id}/captions/{filename}")
def update_project_caption(project_id: str, revision_id: str, filename: str, request: ProjectCaptionUpdate) -> dict[str, Any]:
    try:
        return project_caption_store.set_caption(project_id, revision_id, filename, request.caption, reason=request.reason, metadata=request.metadata, materialize=request.materialize, run_id=request.run_id)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{project_id}/revisions/{revision_id}/materialize-captions")
def materialize_project_captions(project_id: str, revision_id: str) -> dict[str, Any]:
    try:
        return project_caption_store.materialize_revision(project_id, revision_id)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc


@router.post("/{project_id}/runs")
def create_run(project_id: str, request: RunCreate) -> dict[str, Any]:
    try:
        project_caption_store.materialize_revision(project_id, request.dataset_revision)
        return project_store.create_run(project_id, name=request.name, model_family=request.model_family, dataset_revision=request.dataset_revision, trigger_word=request.trigger_word, config=request.config)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{project_id}/runs/{run_id}")
def get_run(project_id: str, run_id: str) -> dict[str, Any]:
    try:
        return project_store.get_run(project_id, run_id)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc


@router.post("/{project_id}/runs/{run_id}/events")
def append_run_event(project_id: str, run_id: str, request: RunEventCreate) -> dict[str, Any]:
    try:
        return project_store.append_run_event(project_id, run_id, request.type, request.payload)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{project_id}/runs/{run_id}/artifacts")
def register_artifact(project_id: str, run_id: str, request: ArtifactCreate) -> dict[str, Any]:
    try:
        return project_store.register_artifact(project_id, run_id, artifact_type=request.type, path=request.path, metadata=request.metadata)
    except FileNotFoundError as exc:
        raise _not_found(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
