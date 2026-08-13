from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .caption_templates import GRAMMAR_PROFILES, caption_template_store

router = APIRouter(prefix="/api/projects", tags=["captioning"])


class CaptionTemplateRequest(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


def _payload(project_id: str, revision_id: str, override: dict[str, Any] | None = None):
    rendered = caption_template_store.render(project_id, revision_id, state_override=override)
    return {**rendered, "grammar_profiles": GRAMMAR_PROFILES}


@router.get("/{project_id}/revisions/{revision_id}/caption-template")
def get_caption_template(project_id: str, revision_id: str):
    try:
        return _payload(project_id, revision_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/{project_id}/revisions/{revision_id}/caption-template")
def update_caption_template(project_id: str, revision_id: str, request: CaptionTemplateRequest):
    try:
        values = request.values
        caption_template_store.update(
            project_id,
            revision_id,
            grammar_profile=values.get("grammar_profile"),
            template_text=values.get("template_text"),
            validation=values.get("validation"),
            reset_template=bool(values.get("reset_template", False)),
        )
        return _payload(project_id, revision_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{project_id}/revisions/{revision_id}/caption-template/preview")
def preview_caption_template(project_id: str, revision_id: str, request: CaptionTemplateRequest):
    try:
        return _payload(project_id, revision_id, request.values)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
