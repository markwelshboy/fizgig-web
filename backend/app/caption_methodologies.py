from __future__ import annotations

import hashlib
import json
import os
import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .captioning import add_trigger, caption_service, qwen_tasks
from .caption_templates import caption_template_store


CUSTOM_IDS = ("custom1", "custom2", "custom3")
DEFAULT_POSE_PROMPT = """Write a factual training caption for this image. Begin the description directly with the exact token \"[TRIGGER]\" acting as the grammatical subject of the first sentence. Treat this token as a [GENDER_GRAMMAR] name. After the first sentence, refer to [TRIGGER] using the subject pronoun \"[SUBJECT_PRONOUN]\", object pronoun \"[OBJECT_PRONOUN]\", and possessive pronoun \"[POSSESSIVE_PRONOUN]\" where grammatically appropriate. Do not replace [TRIGGER] with generic subject terms such as \"a woman\", \"a man\", \"a person\", or \"the subject\".

CRITICAL IDENTITY INSTRUCTION: Do NOT describe intrinsic identity traits that the LoRA should learn. Omit natural hair color, baseline hair length, eye color, facial structure, apparent age, and skin tone. Also avoid project-protected identity traits listed here: [PROTECTED_TRAITS]. You MAY describe temporary appearance states when they materially affect the image, such as hair being tied back, wet, windblown, partially covered, or otherwise arranged unusually.

Cover ONLY these transient elements in a clear, natural description, giving pose/orientation priority over background detail:

1. Transient Appearance: clothing style/color/graphics, specific accessories such as glasses, masks, watches or jewelry, and visible facial expression.

2. Pose & Orientation: describe the body's spatial geometry precisely whenever it is non-neutral. Distinguish torso orientation, lean, shoulder angle, head orientation, and gaze. If the torso is bent, twisted, leaning diagonally, turned away from the camera, or entering the frame asymmetrically, state that explicitly. Do not reduce an unusual pose to only \"looking left/right\" or \"head tilted\".

3. Framing & Camera Relationship: describe the shot type naturally, such as extreme close-up, close-up, medium close-up, waist-up, or full-body. Mention a clearly high, low, selfie-like, or otherwise unusual camera relationship when visible. Do not default to \"head-and-shoulders close-up\" when the body enters diagonally or the subject bends toward the camera.

4. Environment & Lighting: briefly describe the setting, important visible background elements, and lighting. Keep this secondary to subject pose and framing.

Use natural language rather than tag lists. Never open with preambles such as \"This image shows\". State only what is visible; do not speculate, invent proper names, or add style/quality commentary. Prefer concise, useful geometry over forensic left/right detail when exact anatomical direction is uncertain."""

STRICT_BINDING = {
    "require_exact_trigger": True,
    "require_trigger_first": True,
    "require_single_trigger": True,
    "reject_detached_trailing_trigger": True,
    "reject_generic_subject_after_trigger": True,
    "retry_on_failure": True,
    "max_attempts": 3,
}

_TRIGGER_RULES = (
    "require_exact_trigger",
    "require_trigger_first",
    "require_single_trigger",
    "reject_detached_trailing_trigger",
    "reject_generic_subject_after_trigger",
)
_VARIABLE_RE = re.compile(r"\[([A-Z][A-Z0-9_]*)\]")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _config_path() -> Path:
    raw = os.environ.get("FIZGIG_CAPTION_METHODOLOGIES", "/workspace/fizgig-web/caption-methodologies.json")
    return Path(raw).expanduser()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _hash_method(method: dict[str, Any]) -> str:
    stable = {
        "id": method.get("id"),
        "name": method.get("name"),
        "description": method.get("description"),
        "instruction": method.get("instruction"),
        "max_tokens": method.get("max_tokens"),
        "validation": method.get("validation"),
        "trigger_strategy": method.get("trigger_strategy"),
    }
    return hashlib.sha256(json.dumps(stable, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _default_customs() -> dict[str, dict[str, Any]]:
    return {
        "custom1": {
            "id": "custom1",
            "name": "Portrait Identity — Pose Aware",
            "description": "Identity LoRA caption prioritizing body geometry, framing and clean trigger binding.",
            "instruction": DEFAULT_POSE_PROMPT,
            "max_tokens": 220,
            "validation": deepcopy(STRICT_BINDING),
            "revision": 1,
            "updated_at": None,
        },
        "custom2": {
            "id": "custom2",
            "name": "Custom 2",
            "description": "User-defined caption methodology.",
            "instruction": "",
            "max_tokens": 180,
            "validation": deepcopy(STRICT_BINDING),
            "revision": 1,
            "updated_at": None,
        },
        "custom3": {
            "id": "custom3",
            "name": "Custom 3",
            "description": "User-defined caption methodology.",
            "instruction": "",
            "max_tokens": 240,
            "validation": deepcopy(STRICT_BINDING),
            "revision": 1,
            "updated_at": None,
        },
    }


def _default_config() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "customs": _default_customs(),
        "rewrite_ladder": ["builtin:detailed", "builtin:exhaustive", "custom1"],
        "updated_at": None,
    }


def _normalize_validation(value: dict[str, Any] | None) -> dict[str, Any]:
    result = deepcopy(STRICT_BINDING)
    if value:
        for key in (*_TRIGGER_RULES, "retry_on_failure"):
            if key in value:
                result[key] = bool(value[key])
        if "max_attempts" in value:
            result["max_attempts"] = max(1, min(5, int(value["max_attempts"])))
    return result


def _requires_trigger(rules: dict[str, Any]) -> bool:
    return any(bool(rules.get(key)) for key in _TRIGGER_RULES)


class CaptionMethodologyStore:
    """Application-level methodology library plus deterministic rewrite ladder.

    Built-in Qwen tasks remain genuine controls: their upstream/fallback prompt is used unchanged
    and optional trigger insertion uses the existing legacy prepend behavior. Custom methodologies
    render project variables into their prompt before generation and may enforce output contracts.
    """

    def load(self) -> dict[str, Any]:
        base = _default_config()
        path = _config_path()
        if not path.is_file():
            return base
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return base
        customs = base["customs"]
        for method_id in CUSTOM_IDS:
            incoming = raw.get("customs", {}).get(method_id)
            if not isinstance(incoming, dict):
                continue
            merged = {**customs[method_id], **incoming}
            merged["id"] = method_id
            merged["name"] = str(merged.get("name") or method_id).strip()
            merged["description"] = str(merged.get("description") or "").strip()
            merged["instruction"] = str(merged.get("instruction") or "")
            merged["max_tokens"] = max(16, min(1024, int(merged.get("max_tokens") or 180)))
            merged["validation"] = _normalize_validation(merged.get("validation"))
            merged["revision"] = max(1, int(merged.get("revision") or 1))
            customs[method_id] = merged
        ladder = raw.get("rewrite_ladder")
        if isinstance(ladder, list) and len(ladder) == 3:
            base["rewrite_ladder"] = [str(value) for value in ladder]
        base["customs"] = customs
        base["updated_at"] = raw.get("updated_at")
        return base

    def builtins(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for task_id, task in qwen_tasks().items():
            method = {
                "id": f"builtin:{task_id}",
                "kind": "builtin",
                "task": task_id,
                "name": str(task.get("label") or task_id),
                "description": "Standard Qwen/Fizgig caption task retained as an experimental baseline.",
                "instruction": str(task.get("instruction") or ""),
                "max_tokens": int(task.get("max_tokens") or 120),
                "trigger_strategy": "legacy_prepend_optional",
                "validation": None,
                "configured": True,
                "revision": 1,
            }
            method["hash"] = _hash_method(method)
            result.append(method)
        return result

    def payload(self) -> dict[str, Any]:
        config = self.load()
        customs: list[dict[str, Any]] = []
        for method_id in CUSTOM_IDS:
            item = deepcopy(config["customs"][method_id])
            item.update({
                "kind": "custom",
                "trigger_strategy": "template_variables",
                "configured": bool(item.get("instruction", "").strip()),
            })
            item["hash"] = _hash_method(item)
            customs.append(item)
        return {
            "schema_version": 1,
            "builtins": self.builtins(),
            "customs": customs,
            "rewrite_ladder": config["rewrite_ladder"],
            "variables": [
                "TRIGGER", "GENDER_GRAMMAR", "SUBJECT_PRONOUN", "OBJECT_PRONOUN",
                "POSSESSIVE_PRONOUN", "REFLEXIVE_PRONOUN", "PROTECTED_TRAITS",
            ],
            "updated_at": config.get("updated_at"),
        }

    def update(self, values: dict[str, Any]) -> dict[str, Any]:
        config = self.load()
        incoming_customs = values.get("customs")
        if isinstance(incoming_customs, dict):
            for method_id in CUSTOM_IDS:
                incoming = incoming_customs.get(method_id)
                if not isinstance(incoming, dict):
                    continue
                current = config["customs"][method_id]
                before_hash = _hash_method(current)
                for key in ("name", "description", "instruction"):
                    if key in incoming:
                        current[key] = str(incoming[key]).strip() if key != "instruction" else str(incoming[key])
                if "max_tokens" in incoming:
                    current["max_tokens"] = max(16, min(1024, int(incoming["max_tokens"])))
                if "validation" in incoming:
                    current["validation"] = _normalize_validation(incoming.get("validation"))
                if _hash_method(current) != before_hash:
                    current["revision"] = int(current.get("revision") or 1) + 1
                    current["updated_at"] = _now()
        if "rewrite_ladder" in values:
            ladder = values["rewrite_ladder"]
            if not isinstance(ladder, list) or len(ladder) != 3:
                raise ValueError("Rewrite ladder must contain exactly three methodology IDs")
            available = {item["id"] for item in self.builtins()} | set(CUSTOM_IDS)
            normalized = [str(value) for value in ladder]
            unknown = [value for value in normalized if value not in available]
            if unknown:
                raise ValueError(f"Unknown rewrite methodology: {', '.join(unknown)}")
            unconfigured = [
                value for value in normalized
                if value in CUSTOM_IDS and not str(config["customs"][value].get("instruction", "")).strip()
            ]
            if unconfigured:
                raise ValueError(f"Rewrite ladder contains unconfigured custom methodology: {', '.join(unconfigured)}")
            config["rewrite_ladder"] = normalized
        config["updated_at"] = _now()
        _write_json(_config_path(), config)
        return self.payload()

    def get_method(self, methodology_id: str) -> dict[str, Any]:
        methodology_id = methodology_id.strip()
        if methodology_id.startswith("builtin:"):
            for item in self.builtins():
                if item["id"] == methodology_id:
                    return item
            raise ValueError(f"Unknown built-in methodology: {methodology_id}")
        if methodology_id in CUSTOM_IDS:
            payload = self.payload()
            return next(item for item in payload["customs"] if item["id"] == methodology_id)
        raise ValueError(f"Unknown caption methodology: {methodology_id}")

    def render_custom(self, project_id: str, revision_id: str, method: dict[str, Any]) -> dict[str, Any]:
        if not method.get("configured"):
            raise ValueError(f"Caption methodology {method['name']} is not configured")
        state = caption_template_store.get(project_id, revision_id)
        variables = caption_template_store.variables(project_id, revision_id, state)
        used_variables = sorted(set(_VARIABLE_RE.findall(str(method["instruction"]))))
        unknown = sorted(set(used_variables) - set(variables))
        if unknown:
            raise ValueError(f"Unknown caption methodology variable(s): {', '.join(unknown)}")
        if "TRIGGER" in used_variables and not variables["TRIGGER"]:
            raise ValueError("This caption methodology uses [TRIGGER], but the project trigger word is not configured")
        rendered = _VARIABLE_RE.sub(lambda match: variables.get(match.group(1), match.group(0)), str(method["instruction"]))
        return {"variables": variables, "used_variables": used_variables, "rendered_instruction": rendered}

    def validate_custom(self, caption: str, trigger: str, rules: dict[str, Any]) -> dict[str, Any]:
        text = " ".join(caption.strip().split())
        trigger = trigger.strip()
        rules = _normalize_validation(rules)
        errors: list[str] = []
        warnings: list[str] = []
        if not text:
            errors.append("Caption is empty")
            return {"valid": False, "errors": errors, "warnings": warnings}

        if not trigger:
            if _requires_trigger(rules):
                errors.append("Project trigger word is not configured but trigger validation is enabled")
            return {"valid": not errors, "errors": errors, "warnings": warnings}

        exact_count = text.count(trigger)
        ci_count = text.lower().count(trigger.lower())
        if rules["require_exact_trigger"] and exact_count == 0:
            errors.append(f'Exact trigger "{trigger}" is missing or changed case')
        if rules["require_trigger_first"] and not text.startswith(trigger):
            errors.append(f'Caption must begin directly with "{trigger}"')
        if rules["require_single_trigger"] and ci_count != 1:
            errors.append(f"Trigger must occur exactly once (found {ci_count})")
        if rules["reject_detached_trailing_trigger"] and re.search(rf"[,;:]\s*{re.escape(trigger)}[.!?]?\s*$", text, re.IGNORECASE):
            errors.append("Detached trailing trigger is not allowed")
        generic = re.match(rf"^{re.escape(trigger)}\s*[,;:\-]\s*(?:a|the)\s+(?:woman|man|person|subject)\b", text, re.IGNORECASE)
        if generic:
            if rules["reject_generic_subject_after_trigger"]:
                errors.append("Trigger may not be followed by a generic replacement subject")
            else:
                warnings.append("Trigger is followed by a generic replacement subject")
        return {"valid": not errors, "errors": errors, "warnings": warnings}

    def generate_qwen(
        self,
        project_id: str,
        revision_id: str,
        methodology_id: str,
        *,
        image_path: Path,
        model: str | None = None,
        model_path: str | None = None,
        processor: str | None = None,
        model_revision: str | None = None,
        max_tokens: int | None = None,
        add_trigger_word: bool = True,
        trigger_word: str = "",
    ) -> dict[str, Any]:
        method = self.get_method(methodology_id)
        if method["kind"] == "builtin":
            caption = caption_service.generate(
                provider="qwen", image_path=image_path, model=model, model_path=model_path,
                processor=processor, revision=model_revision, task=method.get("task"),
                instruction=method["instruction"], max_tokens=max_tokens or method["max_tokens"],
            )
            if add_trigger_word:
                caption = add_trigger(caption, trigger_word)
            return {
                "caption": caption,
                "attempts": 1,
                "validation": None,
                "methodology": self.provenance(method),
            }

        rendered = self.render_custom(project_id, revision_id, method)
        trigger = rendered["variables"]["TRIGGER"]
        rules = method["validation"]
        attempts = int(rules["max_attempts"]) if rules.get("retry_on_failure", True) else 1
        last_caption = ""
        last_validation: dict[str, Any] = {"valid": False, "errors": ["No generation attempt completed"], "warnings": []}
        for attempt in range(1, attempts + 1):
            instruction = rendered["rendered_instruction"]
            if attempt > 1:
                reason = "; ".join(last_validation.get("errors", [])) or "output contract failed"
                instruction += f"\n\nRETRY CORRECTION: The previous candidate was rejected because {reason}. Follow the requested output structure exactly. Output only the caption."
            last_caption = caption_service.generate(
                provider="qwen", image_path=image_path, model=model, model_path=model_path,
                processor=processor, revision=model_revision, task="training", instruction=instruction,
                max_tokens=max_tokens or method["max_tokens"],
            )
            last_validation = self.validate_custom(last_caption, trigger, rules)
            if last_validation["valid"]:
                provenance = self.provenance(method)
                provenance.update(rendered)
                return {"caption": last_caption, "attempts": attempt, "validation": last_validation, "methodology": provenance}
        raise RuntimeError(
            f"Caption methodology validation failed after {attempts} attempt(s): "
            + "; ".join(last_validation.get("errors", []))
            + f". Last candidate: {last_caption[:240]}"
        )

    def provenance(self, method: dict[str, Any]) -> dict[str, Any]:
        return {
            "methodology_id": method["id"],
            "methodology_name": method["name"],
            "kind": method["kind"],
            "revision": int(method.get("revision") or 1),
            "hash": method.get("hash") or _hash_method(method),
            "instruction": method.get("instruction", ""),
            "max_tokens": int(method.get("max_tokens") or 120),
            "trigger_strategy": method.get("trigger_strategy"),
            "validation": method.get("validation"),
        }

    def materialize_for_run(self, project_id: str, revision_id: str, run: dict[str, Any]) -> dict[str, Any]:
        payload = self.payload()
        methods = {item["id"]: item for item in payload["builtins"] + payload["customs"]}
        ladder: list[dict[str, Any]] = []
        for stage, method_id in enumerate(payload["rewrite_ladder"], start=1):
            method = methods[method_id]
            entry = {"stage": stage, **self.provenance(method)}
            if method["kind"] == "custom" and method.get("configured"):
                rendered = self.render_custom(project_id, revision_id, method)
                entry.update(rendered)
            ladder.append(entry)
        snapshot = {
            "schema_version": 1,
            "created_at": _now(),
            "project_id": project_id,
            "revision": revision_id,
            "run_id": run["id"],
            "rewrite_ladder": ladder,
            "custom_methodologies": [self.provenance(item) for item in payload["customs"]],
        }
        run_dir = Path(run["output_dir"]).resolve()
        _write_json(run_dir / "caption_methodologies.json", snapshot)
        return snapshot


caption_methodology_store = CaptionMethodologyStore()
