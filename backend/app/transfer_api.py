from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from .archive_io import import_project_archive
from .project_export import stream_project_archive
from .projects import project_store
from .raw_dataset_export import prepare_raw_dataset_export, stream_raw_dataset_archive

router = APIRouter(prefix="/api", tags=["transfers"])


@router.post("/projects/import")
def import_project(archive: UploadFile = File(...)):
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


@router.get("/projects/{project_id}/export")
def export_project(project_id: str) -> StreamingResponse:
    try:
        project_dir = project_store.project_dir(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    filename = f"fizgig-project-{project_id}.tar.gz"
    return StreamingResponse(
        stream_project_archive(project_dir, project_id),
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
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
