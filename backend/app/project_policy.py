from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .projects import project_store


TRAINING_POLICIES = {"automatic", "always_train"}
RECAPTION_POLICIES = {"automatic", "hold", "never"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(value, ensure_ascii=False) + "\n")
        f.flush()


class ProjectPolicyStore:
    """Project-owned caption/training intervention policy.

    Loss-watch verdicts remain observational truth. These settings only control what Fizgig is
    allowed to DO in response to those verdicts. In particular, `always_train` must never rewrite
    STUCK/EASY analytics; it means no automatic LR throttle, retirement, or exclusion for that
    asset once the trainer integration consumes this sidecar.
    """

    @staticmethod
    def _default(revision_id: str) -> dict[str, Any]:
        return {
            "revision": revision_id,
            "updated_at": None,
            "caption_validation": {
                "protected_phrases": [],
                "spellcheck_enabled": True,
                "accepted_words": [],
            },
            "assets": {},
        }

    def _path(self, project_id: str, revision_id: str) -> Path:
        project_dir = project_store.project_dir(project_id)
        revision_dir = (project_dir / "datasets" / revision_id).resolve()
        if project_dir not in revision_dir.parents or not (revision_dir / "manifest.json").is_file():
            raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")
        return revision_dir / "asset_policy.json"

    def get(self, project_id: str, revision_id: str) -> dict[str, Any]:
        path = self._path(project_id, revision_id)
        if not path.is_file():
            return self._default(revision_id)
        value = json.loads(path.read_text(encoding="utf-8"))
        base = self._default(revision_id)
        base.update(value)
        base["caption_validation"] = {**self._default(revision_id)["caption_validation"], **value.get("caption_validation", {})}
        base["assets"] = value.get("assets", {})
        return base

    def update_validation(
        self,
        project_id: str,
        revision_id: str,
        *,
        protected_phrases: list[str] | None = None,
        spellcheck_enabled: bool | None = None,
        accepted_words: list[str] | None = None,
    ) -> dict[str, Any]:
        path = self._path(project_id, revision_id)
        policy = self.get(project_id, revision_id)
        validation = policy["caption_validation"]
        if protected_phrases is not None:
            validation["protected_phrases"] = list(dict.fromkeys(p.strip() for p in protected_phrases if p.strip()))
        if spellcheck_enabled is not None:
            validation["spellcheck_enabled"] = bool(spellcheck_enabled)
        if accepted_words is not None:
            validation["accepted_words"] = list(dict.fromkeys(w.strip() for w in accepted_words if w.strip()))
        policy["updated_at"] = _now()
        _write_json(path, policy)
        self._event(project_id, revision_id, "caption_validation_policy_changed", {"caption_validation": validation})
        return policy

    def update_asset(
        self,
        project_id: str,
        revision_id: str,
        filename: str,
        *,
        training_policy: str | None = None,
        auto_recaption_policy: str | None = None,
    ) -> dict[str, Any]:
        manifest = project_store.get_revision(project_id, revision_id)
        if filename not in {str(a.get("filename")) for a in manifest.get("assets", [])}:
            raise FileNotFoundError(f"Image not found in dataset revision: {filename}")
        if training_policy is not None and training_policy not in TRAINING_POLICIES:
            raise ValueError(f"Unknown training policy: {training_policy}")
        if auto_recaption_policy is not None and auto_recaption_policy not in RECAPTION_POLICIES:
            raise ValueError(f"Unknown auto-recaption policy: {auto_recaption_policy}")

        path = self._path(project_id, revision_id)
        policy = self.get(project_id, revision_id)
        current = policy["assets"].get(filename, {
            "training_policy": "automatic",
            "auto_recaption_policy": "automatic",
        })
        before = dict(current)
        if training_policy is not None:
            current["training_policy"] = training_policy
        if auto_recaption_policy is not None:
            current["auto_recaption_policy"] = auto_recaption_policy
        current["updated_at"] = _now()

        # Keep the file compact: fully automatic assets need no explicit record.
        if current["training_policy"] == "automatic" and current["auto_recaption_policy"] == "automatic":
            policy["assets"].pop(filename, None)
        else:
            policy["assets"][filename] = current
        policy["updated_at"] = _now()
        _write_json(path, policy)
        self._event(project_id, revision_id, "asset_policy_changed", {
            "filename": filename,
            "before": before,
            "after": {
                "training_policy": current["training_policy"],
                "auto_recaption_policy": current["auto_recaption_policy"],
            },
        })
        return policy

    def effective_asset(self, project_id: str, revision_id: str, filename: str) -> dict[str, Any]:
        policy = self.get(project_id, revision_id)
        return {
            "training_policy": "automatic",
            "auto_recaption_policy": "automatic",
            **policy.get("assets", {}).get(filename, {}),
        }

    def materialize_for_run(self, project_id: str, revision_id: str, run: dict[str, Any]) -> dict[str, Any]:
        """Freeze policy into both run provenance and the trainer dataset directory.

        The trainer currently ignores this file; it is intentionally a stable hand-off contract for
        the next integration pass. `run_policy.json` is immutable run provenance, while
        `fizgig_asset_policy.json` travels next to the trainer materialized images.
        """
        policy = self.get(project_id, revision_id)
        manifest = project_store.get_revision(project_id, revision_id)
        included = [a for a in manifest.get("assets", []) if a.get("included", True)]
        resolved_assets = {
            str(asset["filename"]): self.effective_asset(project_id, revision_id, str(asset["filename"]))
            for asset in included
        }
        snapshot = {
            "schema_version": 1,
            "created_at": _now(),
            "project_id": project_id,
            "run_id": run["id"],
            "revision": revision_id,
            "caption_validation": policy["caption_validation"],
            "assets": resolved_assets,
            "semantics": {
                "always_train": "Preserve analytic verdicts but prohibit automatic per-image throttle, retirement, or exclusion.",
                "recaption_automatic": "Loss-watch may auto-recaption when normal Fizgig eligibility rules are met.",
                "recaption_hold": "Temporarily suppress automatic recaption; manual and explicit user AI rewrites remain allowed.",
                "recaption_never": "Never auto-recaption this asset for this policy snapshot.",
            },
        }
        run_dir = Path(run["output_dir"]).resolve()
        _write_json(run_dir / "run_policy.json", snapshot)
        trainer_dir = Path(run["dataset_path"]).resolve()
        trainer_dir.mkdir(parents=True, exist_ok=True)
        _write_json(trainer_dir / "fizgig_asset_policy.json", snapshot)
        _append_jsonl(run_dir / "events.jsonl", {
            "time": _now(),
            "type": "asset_policy_snapshotted",
            "always_train_count": sum(1 for v in resolved_assets.values() if v.get("training_policy") == "always_train"),
            "recaption_hold_count": sum(1 for v in resolved_assets.values() if v.get("auto_recaption_policy") == "hold"),
            "recaption_never_count": sum(1 for v in resolved_assets.values() if v.get("auto_recaption_policy") == "never"),
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


project_policy_store = ProjectPolicyStore()
