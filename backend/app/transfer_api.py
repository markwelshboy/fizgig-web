from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .archive_io import create_project_archive, import_project_archive
from .projects import project_store

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
def export_project(project_id: str) -> FileResponse:
    try:
        project_dir = project_store.project_dir(project_id)
        archive = create_project_archive(project_dir, project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Project export failed: {exc}") from exc

    return FileResponse(
        archive,
        media_type="application/gzip",
        filename=f"fizgig-project-{project_id}.tar.gz",
        background=BackgroundTask(archive.unlink, missing_ok=True),
    )
