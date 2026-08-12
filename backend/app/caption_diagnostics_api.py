from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from spellchecker import SpellChecker

from .project_policy import project_policy_store
from .projects import project_store

router = APIRouter(prefix="/api/projects", tags=["captioning"])

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:['’-][A-Za-z0-9]+)*")
_SPELL = SpellChecker(language="en", distance=1)


class CaptionSpellcheckRequest(BaseModel):
    text: str = Field(default="", max_length=20000)


def _context(project_id: str, revision_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    try:
        project = project_store.get_project(project_id)
        revision = project_store.get_revision(project_id, revision_id)
        policy = project_policy_store.get(project_id, revision_id)
        return project, revision, policy
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _accepted_words(project: dict[str, Any], policy: dict[str, Any]) -> set[str]:
    accepted = {
        str(value).strip().lower()
        for value in policy.get("caption_validation", {}).get("accepted_words", [])
        if str(value).strip()
    }
    trigger = str(project.get("trigger_word", "")).strip().lower()
    if trigger:
        accepted.add(trigger)
    return accepted


def _spell_issues(text: str, accepted: set[str], *, suggestions: bool) -> list[dict[str, Any]]:
    ordered: list[tuple[str, str]] = []
    seen: set[str] = set()
    for match in _WORD_RE.finditer(text):
        token = match.group(0)
        key = token.lower().replace("’", "'")
        if key in accepted or any(char.isdigit() for char in key):
            continue
        check_key = key[:-2] if key.endswith("'s") and len(key) > 2 else key
        parts = [check_key] if "-" not in check_key else [part for part in check_key.split("-") if part]
        for part in parts:
            if len(part) <= 1 or part in accepted or part in seen:
                continue
            seen.add(part)
            ordered.append((token if len(parts) == 1 else part, part))

    unknown = _SPELL.unknown([check for _, check in ordered])
    result: list[dict[str, Any]] = []
    for shown, check in ordered:
        if check not in unknown:
            continue
        candidates: list[str] = []
        if suggestions:
            correction = _SPELL.correction(check)
            if correction and correction != check:
                candidates.append(str(correction))
            for candidate in sorted(_SPELL.candidates(check) or set()):
                value = str(candidate)
                if value != check and value not in candidates:
                    candidates.append(value)
                if len(candidates) >= 4:
                    break
        result.append({"word": shown, "suggestions": candidates})
    return result


def _latest_caption_events(project_id: str, revision_id: str) -> dict[str, dict[str, Any]]:
    events_path = project_store.project_dir(project_id) / "events.jsonl"
    latest: dict[str, dict[str, Any]] = {}
    if not events_path.is_file():
        return latest
    with events_path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "caption_changed" or event.get("revision") != revision_id:
                continue
            filename = str(event.get("filename", ""))
            if filename:
                latest[filename] = event
    return latest


def _caption_source(asset: dict[str, Any], event: dict[str, Any] | None) -> str:
    caption = str(asset.get("caption", "")).strip()
    if not caption:
        return "missing"
    if event:
        source = str(event.get("source", "")).lower()
        reason = str(event.get("reason", "")).lower()
        if source == "ai" or reason.startswith("ai_"):
            return "ai"
        if source == "manual" or reason == "manual_edit":
            return "manual"
    if asset.get("origin") == "external_source_import":
        return "source"
    return "saved"


@router.post("/{project_id}/revisions/{revision_id}/caption-spellcheck")
def spellcheck_caption(project_id: str, revision_id: str, request: CaptionSpellcheckRequest) -> dict[str, Any]:
    project, _, policy = _context(project_id, revision_id)
    validation = policy.get("caption_validation", {})
    enabled = bool(validation.get("spellcheck_enabled", True))
    accepted = _accepted_words(project, policy)
    return {
        "enabled": enabled,
        "issues": _spell_issues(request.text, accepted, suggestions=True) if enabled and request.text.strip() else [],
    }


@router.get("/{project_id}/revisions/{revision_id}/caption-status")
def caption_status(project_id: str, revision_id: str) -> dict[str, Any]:
    project, revision, policy = _context(project_id, revision_id)
    validation = policy.get("caption_validation", {})
    protected = [str(value).strip() for value in validation.get("protected_phrases", []) if str(value).strip()]
    spell_enabled = bool(validation.get("spellcheck_enabled", True))
    accepted = _accepted_words(project, policy)
    latest_events = _latest_caption_events(project_id, revision_id)

    statuses: dict[str, Any] = {}
    for asset in revision.get("assets", []):
        filename = str(asset.get("filename", ""))
        if not filename:
            continue
        caption = str(asset.get("caption", "")).strip()
        lower = caption.lower()
        matches = [phrase for phrase in protected if phrase.lower() in lower]
        event = latest_events.get(filename)
        statuses[filename] = {
            "saved": bool(caption),
            "source": _caption_source(asset, event),
            "reason": str(event.get("reason", "")) if event else "",
            "protected_matches": matches,
            "spelling_issue_count": len(_spell_issues(caption, accepted, suggestions=False)) if spell_enabled and caption else 0,
        }
    return {"revision": revision_id, "statuses": statuses}
