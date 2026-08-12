from __future__ import annotations

from fastapi import Request

from .activity import activity_tracker
from .activity_api import router as activity_router
from .caption_diagnostics_api import router as caption_diagnostics_router
from .caption_runtime_api import router as caption_runtime_router
from .main import app
from .project_metadata_api import router as project_metadata_router
from .sampling_api import router as sampling_router

# Keep optional web-only metadata/runtime/diagnostic controls separate from the
# core API modules while serving them from the same FastAPI application.
app.include_router(project_metadata_router)
app.include_router(caption_runtime_router)
app.include_router(caption_diagnostics_router)
app.include_router(sampling_router)
app.include_router(activity_router)


def _activity_label(request: Request) -> tuple[str, str] | None:
    path = request.url.path
    if request.method == "POST" and "/captions/" in path and path.endswith("/generate"):
        return "Captioning", path.rsplit("/captions/", 1)[-1].rsplit("/generate", 1)[0]
    if request.method == "POST" and "/face-crops/" in path:
        return "Image Prep", "Detecting faces"
    if request.method == "POST" and path.endswith("/manual-crops"):
        return "Image Prep", "Creating crop"
    if request.method == "POST" and path.endswith("/runs"):
        return "Preparing run", "Materializing training inputs"
    if "/training/" in path and request.method in {"POST", "PUT", "DELETE"}:
        return "Training", ""
    return None


@app.middleware("http")
async def publish_command_activity(request: Request, call_next):
    activity = _activity_label(request)
    if not activity:
        return await call_next(request)
    token = activity_tracker.begin(*activity)
    try:
        return await call_next(request)
    finally:
        activity_tracker.end(token)
