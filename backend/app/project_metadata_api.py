from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .projects import project_store

router = APIRouter(prefix="/api/projects", tags=["projects"])


class TriggerWordUpdate(BaseModel):
    trigger_word: str = Field(default="", max_length=128)


@router.put("/{project_id}/trigger-word")
def update_project_trigger_word(project_id: str, request: TriggerWordUpdate):
    try:
        project_dir = project_store.project_dir(project_id)
        project = project_store.get_project(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    old_value = str(project.get("trigger_word", ""))
    new_value = request.trigger_word.strip()
    if old_value == new_value:
        return project

    project["trigger_word"] = new_value
    project_store._save_project(project_dir, project)
    project_store._event(
        project_dir,
        "project_trigger_word_changed",
        previous_trigger_word=old_value,
        trigger_word=new_value,
    )
    return project_store.get_project(project_id)
