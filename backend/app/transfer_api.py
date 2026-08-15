from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .archive_io import import_project_archive
from .project_export import export_options, stream_project_archive
from .project_transfer import finalize_project_import, stage_project_import
from .projects import project_store
from .raw_dataset_export import prepare_raw_dataset_export, stream_raw_dataset_archive

router = APIRouter(prefix="/api", tags=["transfers"])


class ProjectImportFinalize(BaseModel):
    token: str
    components: list[str] = Field(default_factory=list)
    identity_mode: Literal["preserve", "clone"] = "preserve"
    clone_id: str | None = None
    clone_name: str | None = None


@router.post("/projects/import")
def import_project(archive: UploadFile = File(...)):
    """Legacy one-shot import retained for older clients."""
    filename = archive.filename or "project.tar.gz"
    try:
        imported = import_project_archive(archive.file, filename, project_store.root)
        return project_store.get_project(str(imported["id"]))
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Project import failed: {exc}") from exc


@router.post("/projects/import/inspect")
def inspect_project_import(archive: UploadFile = File(...)):
    filename = archive.filename or "project.tar.gz"
    try:
        return stage_project_import(archive.file, filename, project_store.root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Project inspection failed: {exc}") from exc


@router.post("/projects/import/finalize")
def finalize_project_import_endpoint(request: ProjectImportFinalize):
    try:
        imported = finalize_project_import(
            request.token,
            project_store.root,
            components=set(request.components),
            identity_mode=request.identity_mode,
            clone_id=request.clone_id,
            clone_name=request.clone_name,
        )
        return project_store.get_project(str(imported["id"]))
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Project import failed: {exc}") from exc


@router.get("/projects/{project_id}/export/options")
def project_export_options(project_id: str):
    try:
        project_dir = project_store.project_dir(project_id)
        return export_options(project_dir, project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/projects/{project_id}/export")
def export_project(
    project_id: str,
    preset: Literal["clean", "standard", "full", "exhaustive", "custom"] = "standard",
    components: str | None = None,
    identity_mode: Literal["preserve", "clone"] = "preserve",
    clone_id: str | None = None,
    clone_name: str | None = None,
    # Compatibility with the first portable/workspace archive API.
    mode: Literal["portable", "workspace"] | None = None,
) -> StreamingResponse:
    try:
        project_dir = project_store.project_dir(project_id)
        selected = {value.strip() for value in (components or "").split(",") if value.strip()} or None
        if mode is not None:
            preset = "exhaustive" if mode == "workspace" else "standard"
        effective_identity = identity_mode
        if preset == "clean" and identity_mode == "preserve":
            effective_identity = "clone"
        if effective_identity == "clone" and (not (clone_id or "").strip() or not (clone_name or "").strip()):
            raise ValueError("Clone exports require a new project name and project ID")
        filename_id = clone_id if effective_identity == "clone" and clone_id else project_id
        filename = f"fizgig-{preset}-{filename_id}.tar.gz"
        stream = stream_project_archive(
            project_dir,
            project_id,
            preset=preset,
            components=selected,
            identity_mode=effective_identity,
            clone_id=clone_id,
            clone_name=clone_name,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return StreamingResponse(
        stream,
        media_type="application/gzip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Fizgig-Archive-Preset": preset,
            "X-Fizgig-Archive-Identity": effective_identity,
        },
    )


@router.get("/projects/{project_id}/revisions/{revision_id}/export-dataset")
def export_raw_dataset(project_id: str, revision_id: str) -> StreamingResponse:
    try:
        export = prepare_raw_dataset_export(project_id, revision_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    filename = f"fizgig-dataset-{project_id}-{revision_id}.tar.gz"
    return StreamingResponse(
        stream_raw_dataset_archive(export),
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
