from __future__ import annotations

from fastapi import APIRouter

from .activity import activity_tracker

router = APIRouter(prefix="/api/activity", tags=["runtime"])


@router.get("")
def activity_status():
    return activity_tracker.snapshot()
