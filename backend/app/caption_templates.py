from __future__ import annotations

import json
import os
import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .projects import project_store


TEMPLATE_ID = "portrait_identity_pose_aware_v1"
TEMPLATE_NAME = "Portrait Identity — Pose Aware"
TEMPLATE_REVISION = 1

GRAMMAR_PROFILES: dict[str, dict[str, str]] = {
    "feminine": {
        "label": "Woman / feminine — she/her",
        "gender_grammar": "feminine",
        "subject_pronoun": "she",
        "object_pronoun": "her",
        "possessive_pronoun": "her",
        "reflexive_pronoun": "herself",
    },
    "masculine": {
        "label": "Man / masculine — he/him",
        "gender_grammar": "masculine",
        "subject_pronoun": "he",
        "object_pronoun": "him",
        "possessive_pronoun": "his",
        "reflexive_pronoun": "himself",
    },
    "neutral": {
        "label": "Neutral — they/them",
        "gender_grammar": "gender-neutral",
        "subject_pronoun": "they",
        "object_pronoun": "them",
        "possessive_pronoun": "their",
        "reflexive_pronoun": "themself",
    },
}

DEFAULT_TEMPLATE = """Write a factual training caption for this image. Begin the description directly with the exact token \"[TRIGGER]\" acting as the grammatical subject of the first sentence. Treat this token as a [GENDER_GRAMMAR] name. After the first sentence, refer to [TRIGGER] using the subject pronoun \"[SUBJECT_PRONOUN]\", object pronoun \"[OBJECT_PRONOUN]\", and possessive pronoun \"[POSSESSIVE_PRONOUN]\" where grammatically appropriate. Do not replace [TRIGGER] with generic subject terms such as \"a woman\", \"a man\", \"a person\", or \"the subject\".

CRITICAL IDENTITY INSTRUCTION: Do NOT describe intrinsic identity traits that the LoRA should learn. Omit natural hair color, baseline hair length, eye color, facial structure, apparent age, and skin tone. Also avoid project-protected identity traits listed here: [PROTECTED_TRAITS]. You MAY describe temporary appearance states when they materially affect the image, such as hair being tied back, wet, windblown, partially covered, or otherwise arranged unusually.

Cover ONLY these transient elements in a clear, natural description, giving pose/orientation priority over background detail:

1. Transient Appearance: clothing style/color/graphics, specific accessories such as glasses, masks, watches or jewelry, and visible facial expression.

2. Pose & Orientation: describe the body's spatial geometry precisely whenever it is non-neutral. Distinguish torso orientation, lean, shoulder angle, head orientation, and gaze. If the torso is bent, twisted, leaning diagonally, turned away from the camera, or entering the frame asymmetrically, state that explicitly. Do not reduce an unusual pose to only \"looking left/right\" or \"head tilted\".

3. Framing & Camera Relationship: describe the shot type naturally, such as extreme close-up, close-up, medium close-up, waist-up, or full-body. Mention a clearly high, low, selfie-like, or otherwise unusual camera relationship when visible. Do not default to \"head-and-shoulders close-up\" when the body enters diagonally or the subject bends toward the camera.

4. Environment & Lighting: briefly describe the setting, important visible background elements, and lighting. Keep this secondary to subject pose and framing.

Use natural language rather than tag lists. Never open with preambles such as \"This image shows\". State only what is visible; do not speculate, invent proper names, or add style/quality commentary. Prefer concise, useful geometry over forensic left/right detail when exact anatomical direction is uncertain."""

DEFAULT_VALIDATION = {
    "require_exact_trigger": True,
    "require_trigger_first": True,
    "require_single_trigger": True,
    "reject_detached_trailing_trigger": True,
    "retry_on_failure": True,
    "max_attempts": 3,
}

_VARIABLE_RE = re.compile(r"\[([A-Z][A-Z0-9_]*)\]")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")
        handle.flush()


def _default_state(revision_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "revision": revision_id,
        "template_id": TEMPLATE_ID,
        "template_name": TEMPLATE_NAME,
        "template_revision": TEMPLATE_REVISION,
        "template_text": DEFAULT_TEMPLATE,
        "grammar_profile": "feminine",
        "validation": deepcopy(DEFAULT_VALIDATION),
        "updated_at": None,
    }


def _normalize_profile(value: str) -> str:
    key = value.strip().lower()
    if key not in GRAMMAR_PROFILES:
        raise ValueError(f"Unknown grammar profile: {value}")
    return key


def _normalize_validation(value: dict[str, Any] | None) -> dict[str, Any]:
    result = deepcopy(DEFAULT_VALIDATION)
    if value:
        for key in (
            "require_exact_trigger",
            "require_trigger_first",
            "require_single_trigger",
            "reject_detached_trailing_trigger",
            "retry_on_failure",
        ):
            if key in value:
                result[key] = bool(value[key])
        if "max_attempts" in value:
            result["max_attempts"] = max(1, min(5, int(value["max_attempts"])))
    return result


class CaptionTemplateStore:
    """Revision-owned caption methodology shared by initial and future repair captioning.

    The trigger is rendered into the VLM instruction before generation. It is never blindly
    appended to generated text. Output is validated as language structure and can be retried
    without mutating the caption after generation.
    """

    def _path(self, project_id: str, revision_id: str) -> Path:
        project_dir = project_store.project_dir(project_id)
        revision_dir = (project_dir / "datasets" / revision_id).resolve()
        if project_dir not in revision_dir.parents or not (revision_dir / "manifest.json").is_file():
            raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")
        return revision_dir / "caption_template.json"

    def get(self, project_id: str, revision_id: str) -> dict[str, Any]:
        path = self._path(project_id, revision_id)
        base = _default_state(revision_id)
        if not path.is_file():
            return base
        raw = json.loads(path.read_text(encoding="utf-8"))
        base.update({key: value for key, value in raw.items() if key not in {"validation"}})
        base["grammar_profile"] = _normalize_profile(str(base.get("grammar_profile", "feminine")))
        base["validation"] = _normalize_validation(raw.get("validation"))
        base["template_text"] = str(base.get("template_text") or DEFAULT_TEMPLATE)
        return base

    def update(
        self,
        project_id: str,
        revision_id: str,
        *,
        grammar_profile: str | None = None,
        template_text: str | None = None,
        validation: dict[str, Any] | None = None,
        reset_template: bool = False,
    ) -> dict[str, Any]:
        path = self._path(project_id, revision_id)
        state = self.get(project_id, revision_id)
        before = deepcopy(state)
        if grammar_profile is not None:
            state["grammar_profile"] = _normalize_profile(grammar_profile)
        if reset_template:
            state["template_text"] = DEFAULT_TEMPLATE
            state["template_id"] = TEMPLATE_ID
            state["template_name"] = TEMPLATE_NAME
            state["template_revision"] = TEMPLATE_REVISION
        elif template_text is not None:
            text = template_text.strip()
            if not text:
                raise ValueError("Caption template cannot be empty")
            state["template_text"] = text
            if text != DEFAULT_TEMPLATE:
                state["template_id"] = "custom"
                state["template_name"] = "Custom caption template"
                state["template_revision"] = int(state.get("template_revision") or 0) + (0 if before.get("template_id") == "custom" and before.get("template_text") == text else 1)
            else:
                state["template_id"] = TEMPLATE_ID
                state["template_name"] = TEMPLATE_NAME
                state["template_revision"] = TEMPLATE_REVISION
        if validation is not None:
            state["validation"] = _normalize_validation(validation)
        state["updated_at"] = _now()
        _write_json(path, state)
        self._event(project_id, revision_id, "caption_template_changed", {
            "before": {
                "template_id": before.get("template_id"),
                "template_revision": before.get("template_revision"),
                "grammar_profile": before.get("grammar_profile"),
            },
            "after": {
                "template_id": state.get("template_id"),
                "template_revision": state.get("template_revision"),
                "grammar_profile": state.get("grammar_profile"),
            },
        })
        return state

    def variables(
        self,
        project_id: str,
        revision_id: str,
        state: dict[str, Any] | None = None,
    ) -> dict[str, str]:
        project = project_store.get_project(project_id)
        state = state or self.get(project_id, revision_id)
        profile = GRAMMAR_PROFILES[_normalize_profile(str(state.get("grammar_profile", "feminine")))]
        trigger = str(project.get("trigger_word", "")).strip()

        protected: list[str] = []
        policy_path = self._path(project_id, revision_id).with_name("asset_policy.json")
        if policy_path.is_file():
            try:
                policy = json.loads(policy_path.read_text(encoding="utf-8"))
                protected = [str(item).strip() for item in policy.get("caption_validation", {}).get("protected_phrases", []) if str(item).strip()]
            except Exception:
                protected = []

        return {
            "TRIGGER": trigger,
            "GENDER_GRAMMAR": profile["gender_grammar"],
            "SUBJECT_PRONOUN": profile["subject_pronoun"],
            "OBJECT_PRONOUN": profile["object_pronoun"],
            "POSSESSIVE_PRONOUN": profile["possessive_pronoun"],
            "REFLEXIVE_PRONOUN": profile["reflexive_pronoun"],
            "PROTECTED_TRAITS": ", ".join(protected) if protected else "none configured",
        }

    def render(
        self,
        project_id: str,
        revision_id: str,
        *,
        state_override: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        state = self.get(project_id, revision_id)
        if state_override:
            if "grammar_profile" in state_override:
                state["grammar_profile"] = _normalize_profile(str(state_override["grammar_profile"]))
            if "template_text" in state_override and state_override["template_text"] is not None:
                text = str(state_override["template_text"]).strip()
                if not text:
                    raise ValueError("Caption template cannot be empty")
                state["template_text"] = text
            if "validation" in state_override:
                state["validation"] = _normalize_validation(state_override.get("validation"))

        variables = self.variables(project_id, revision_id, state)
        missing_variables = sorted(set(_VARIABLE_RE.findall(str(state["template_text"]))) - set(variables))
        if missing_variables:
            raise ValueError(f"Unknown caption template variable(s): {', '.join(missing_variables)}")
        if not variables["TRIGGER"]:
            rendered = str(state["template_text"])
        else:
            rendered = _VARIABLE_RE.sub(lambda match: variables.get(match.group(1), match.group(0)), str(state["template_text"]))
        return {
            "state": state,
            "variables": variables,
            "rendered_instruction": rendered,
            "ready": bool(variables["TRIGGER"]),
            "missing_variables": missing_variables,
        }

    def validate_caption(
        self,
        caption: str,
        trigger: str,
        validation: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        text = " ".join(caption.strip().split())
        trigger = trigger.strip()
        rules = _normalize_validation(validation)
        errors: list[str] = []
        warnings: list[str] = []

        if not text:
            errors.append("Caption is empty")
            return {"valid": False, "errors": errors, "warnings": warnings}
        if not trigger:
            errors.append("Project trigger word is not configured")
            return {"valid": False, "errors": errors, "warnings": warnings}

        exact_count = text.count(trigger)
        case_insensitive_count = text.lower().count(trigger.lower())
        if rules["require_exact_trigger"] and exact_count == 0:
            errors.append(f'Exact trigger "{trigger}" is missing or has changed case')
        if rules["require_trigger_first"]:
            if not text.startswith(trigger):
                errors.append(f'Caption must begin directly with "{trigger}"')
            elif len(text) > len(trigger) and text[len(trigger)].isalnum():
                errors.append("Trigger is not a standalone first token")
        if rules["require_single_trigger"] and case_insensitive_count != 1:
            errors.append(f"Trigger must occur exactly once (found {case_insensitive_count})")
        if rules["reject_detached_trailing_trigger"]:
            detached = re.search(rf"[,;:]\s*{re.escape(trigger)}[.!?]?\s*$", text, re.IGNORECASE)
            if detached:
                errors.append("Detached trailing trigger is not allowed")

        generic_after_trigger = re.match(
            rf"^{re.escape(trigger)}\s*[,;:\-]\s*(?:a|the)\s+(?:woman|man|person|subject)\b",
            text,
            re.IGNORECASE,
        )
        if generic_after_trigger:
            warnings.append("Trigger is immediately followed by a generic replacement subject")

        return {"valid": not errors, "errors": errors, "warnings": warnings}

    def generate_qwen(
        self,
        project_id: str,
        revision_id: str,
        *,
        image_path: Path,
        model: str | None = None,
        model_path: str | None = None,
        processor: str | None = None,
        model_revision: str | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        from .captioning import caption_service

        rendered = self.render(project_id, revision_id)
        state = rendered["state"]
        trigger = rendered["variables"]["TRIGGER"]
        if not trigger:
            raise ValueError("Project trigger word must be configured before template-driven caption generation")

        rules = state["validation"]
        attempts = int(rules.get("max_attempts", 3)) if rules.get("retry_on_failure", True) else 1
        base_instruction = rendered["rendered_instruction"]
        last_caption = ""
        last_validation: dict[str, Any] = {"valid": False, "errors": ["No generation attempt completed"], "warnings": []}

        for attempt in range(1, attempts + 1):
            instruction = base_instruction
            if attempt > 1:
                reasons = "; ".join(last_validation.get("errors", [])) or "output structure was invalid"
                instruction += (
                    "\n\nRETRY CORRECTION: The previous candidate was rejected because " + reasons + ". "
                    f'Return a fresh caption that begins exactly with "{trigger}", uses that trigger exactly once, '
                    "and does not append or detach the trigger at the end. Output only the caption."
                )
            last_caption = caption_service.generate(
                provider="qwen",
                image_path=image_path,
                model=model,
                model_path=model_path,
                processor=processor,
                revision=model_revision,
                task="training",
                instruction=instruction,
                max_tokens=max_tokens,
            )
            last_validation = self.validate_caption(last_caption, trigger, rules)
            if last_validation["valid"]:
                return {
                    "caption": last_caption,
                    "attempts": attempt,
                    "validation": last_validation,
                    "template": self.provenance(project_id, revision_id, rendered=rendered),
                }

        raise RuntimeError(
            "Caption template validation failed after "
            f"{attempts} attempt(s): {'; '.join(last_validation.get('errors', []))}. "
            f"Last candidate: {last_caption[:240]}"
        )

    def provenance(
        self,
        project_id: str,
        revision_id: str,
        *,
        rendered: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        rendered = rendered or self.render(project_id, revision_id)
        state = rendered["state"]
        return {
            "template_id": state["template_id"],
            "template_name": state["template_name"],
            "template_revision": state["template_revision"],
            "grammar_profile": state["grammar_profile"],
            "variables": rendered["variables"],
            "rendered_instruction": rendered["rendered_instruction"],
            "validation": state["validation"],
        }

    def materialize_for_run(self, project_id: str, revision_id: str, run: dict[str, Any]) -> dict[str, Any]:
        rendered = self.render(project_id, revision_id)
        snapshot = {
            "schema_version": 1,
            "created_at": _now(),
            "project_id": project_id,
            "run_id": run["id"],
            "revision": revision_id,
            **self.provenance(project_id, revision_id, rendered=rendered),
        }
        run_dir = Path(run["output_dir"]).resolve()
        _write_json(run_dir / "caption_template.json", snapshot)
        _append_jsonl(run_dir / "events.jsonl", {
            "time": _now(),
            "type": "caption_template_snapshotted",
            "template_id": snapshot["template_id"],
            "template_revision": snapshot["template_revision"],
            "grammar_profile": snapshot["grammar_profile"],
        })
        return snapshot

    def _event(self, project_id: str, revision_id: str, event_type: str, payload: dict[str, Any]) -> None:
        project_dir = project_store.project_dir(project_id)
        _append_jsonl(project_dir / "events.jsonl", {
            "time": _now(),
            "type": event_type,
            "revision": revision_id,
            **payload,
        })


caption_template_store = CaptionTemplateStore()
