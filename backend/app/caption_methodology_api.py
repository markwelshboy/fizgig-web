from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .caption_methodologies import caption_methodology_store

router = APIRouter(prefix="/api/caption-methodologies", tags=["captioning"])


class CaptionMethodologyUpdate(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


@router.get("")
def get_caption_methodologies():
    return caption_methodology_store.payload()


@router.put("")
def update_caption_methodologies(request: CaptionMethodologyUpdate):
    try:
        return caption_methodology_store.update(request.values)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
