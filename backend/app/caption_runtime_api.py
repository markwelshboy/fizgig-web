from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .caption_methodologies import caption_methodology_store
from .captioning import caption_service

router = APIRouter(prefix="/api/captioning", tags=["captioning"])


class CaptionMethodologyUpdate(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


@router.get("/status")
def caption_runtime_status() -> dict[str, Any]:
    """Report which process-local caption models are currently resident."""
    with caption_service._lock:
        loaded: list[str] = []
        if caption_service._qwen_model is not None:
            loaded.append("qwen")
        if caption_service._florence_model is not None:
            loaded.append("florence")
        qwen_key = caption_service._qwen_key
        return {
            "loaded": loaded,
            "qwen_model": qwen_key[0] if qwen_key else None,
            "florence_model": caption_service._florence_name,
        }


@router.get("/methodologies")
def get_caption_methodologies() -> dict[str, Any]:
    return caption_methodology_store.payload()


@router.put("/methodologies")
def update_caption_methodologies(request: CaptionMethodologyUpdate) -> dict[str, Any]:
    try:
        return caption_methodology_store.update(request.values)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
