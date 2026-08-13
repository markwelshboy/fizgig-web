from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .caption_templates import caption_template_store
from .projects import project_store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, value: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(value, ensure_ascii=False) + "\n")
        f.flush()


def _caption_source(reason: str, metadata: dict[str, Any] | None) -> str:
    source = str((metadata or {}).get("source", "")).strip().lower()
    reason_key = reason.strip().lower()
    if source == "ai" or reason_key.startswith("ai_"):
        return "ai"
    if source == "manual" or reason_key == "manual_edit":
        return "manual"
    return source or "saved"


class ProjectCaptionStore:
    """Canonical caption state for project-owned scratch datasets.

    The revision manifest owns the caption. `.txt` sidecars are only a compatibility shim for
    trainers/tools that expect same-basename caption files. They are materialized from JSON at
    run start and whenever an in-flight caption change must be pushed to the trainer scratchpad.
    """

    def _manifest_path(self, project_id: str, revision_id: str) -> Path:
        project_dir = project_store.project_dir(project_id)
        path = (project_dir / "datasets" / revision_id / "manifest.json").resolve()
        if project_dir not in path.parents or not path.is_file():
            raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")
        return path

    def _load(self, project_id: str, revision_id: str) -> tuple[Path, dict[str, Any]]:
        path = self._manifest_path(project_id, revision_id)
        return path, json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _asset(manifest: dict[str, Any], filename: str) -> dict[str, Any]:
        for asset in manifest.get("assets", []):
            if asset.get("filename") == filename:
                return asset
        raise FileNotFoundError(f"Image not found in dataset revision: {filename}")

    def get_caption(self, project_id: str, revision_id: str, filename: str) -> dict[str, Any]:
        _, manifest = self._load(project_id, revision_id)
        asset = self._asset(manifest, filename)
        return {
            "filename": filename,
            "caption": str(asset.get("caption", "")),
            "caption_sha256": asset.get("caption_sha256", ""),
            "caption_updated_at": asset.get("caption_updated_at"),
            "caption_source": asset.get("caption_source"),
            "caption_reason": asset.get("caption_reason"),
            "caption_metadata": asset.get("caption_metadata", {}),
        }

    def set_caption(
        self,
        project_id: str,
        revision_id: str,
        filename: str,
        caption: str,
        *,
        reason: str = "manual_edit",
        metadata: dict[str, Any] | None = None,
        materialize: bool = False,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id)
        asset = self._asset(manifest, filename)
        before = str(asset.get("caption", ""))
        after = caption.strip()
        changed = before != after
        metadata_value = dict(metadata or {})

        # Project Qwen generation is template-driven. Record the exact saved template state so a
        # later training run can distinguish caption methodology, not merely provider/model name.
        if _caption_source(reason, metadata_value) == "ai" and str(metadata_value.get("provider", "")).lower() == "qwen":
            try:
                provenance = caption_template_store.provenance(project_id, revision_id)
                metadata_value["caption_template"] = provenance
                metadata_value["instruction"] = provenance["rendered_instruction"]
                metadata_value["trigger_word_added"] = False
                metadata_value["trigger_binding"] = "template_subject"
            except (FileNotFoundError, ValueError):
                pass

        if changed:
            when = _now()
            source = _caption_source(reason, metadata_value)
            asset["caption"] = after
            asset["caption_sha256"] = hashlib.sha256(after.encode("utf-8")).hexdigest()
            asset["caption_updated_at"] = when
            asset["caption_source"] = source if after else "missing"
            asset["caption_reason"] = reason
            asset["caption_metadata"] = metadata_value
            _write_json(manifest_path, manifest)

            event = {
                "time": when,
                "type": "caption_changed",
                "revision": revision_id,
                "filename": filename,
                "reason": reason,
                "before": before,
                "after": after,
                **metadata_value,
            }
            project_dir = project_store.project_dir(project_id)
            _append_jsonl(project_dir / "events.jsonl", event)
            if run_id:
                run = project_store.get_run(project_id, run_id)
                _append_jsonl(Path(run["output_dir"]) / "events.jsonl", event)

        if materialize:
            self.materialize_one(project_id, revision_id, filename)

        return {
            "filename": filename,
            "caption": after,
            "changed": changed,
            "materialized": materialize,
        }

    def materialize_one(self, project_id: str, revision_id: str, filename: str) -> Path:
        _, manifest = self._load(project_id, revision_id)
        asset = self._asset(manifest, filename)
        files_dir = Path(manifest["files_path"]).resolve()
        image = (files_dir / filename).resolve()
        if image.parent != files_dir or not image.is_file():
            raise FileNotFoundError(f"Working image does not exist: {filename}")
        sidecar = image.with_suffix(".txt")
        caption = str(asset.get("caption", "")).strip()
        sidecar.write_text(caption + ("\n" if caption else ""), encoding="utf-8")
        return sidecar

    def materialize_revision(self, project_id: str, revision_id: str) -> dict[str, Any]:
        _, manifest = self._load(project_id, revision_id)
        written = 0
        for asset in manifest.get("assets", []):
            filename = asset.get("filename")
            if not filename:
                continue
            self.materialize_one(project_id, revision_id, filename)
            written += 1

        event = {
            "time": _now(),
            "type": "trainer_captions_materialized",
            "revision": revision_id,
            "count": written,
            "purpose": "trainer_compatibility_shim",
        }
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", event)
        return {"revision": revision_id, "written": written}


project_caption_store = ProjectCaptionStore()
