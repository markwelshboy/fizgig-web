from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .captioning import caption_service

router = APIRouter(prefix="/api/captioning", tags=["captioning"])


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
