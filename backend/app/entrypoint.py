from __future__ import annotations

from .caption_runtime_api import router as caption_runtime_router
from .main import app
from .project_metadata_api import router as project_metadata_router

# Keep optional web-only metadata/runtime controls separate from the core API
# modules while serving them from the same FastAPI application.
app.include_router(project_metadata_router)
app.include_router(caption_runtime_router)
