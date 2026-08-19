from __future__ import annotations

from fastapi import Request

from .activity import activity_tracker
from .main import app


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
