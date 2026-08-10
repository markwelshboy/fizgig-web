from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .projects import project_store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, value: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(value, ensure_ascii=False) + "\n")
        f.flush()


class ImagePrepStore:
    """Dataset-construction state for a project scratch revision.

    A revision begins as an incoming batch copied from the immutable import snapshot. Inclusion,
    derivatives and transformations then describe the effective working set. This state is project
    knowledge; the materialized image files are working artifacts.
    """

    def _load(self, project_id: str, revision_id: str) -> tuple[Path, dict[str, Any]]:
        project_dir = project_store.project_dir(project_id)
        path = (project_dir / "datasets" / revision_id / "manifest.json").resolve()
        if project_dir not in path.parents or not path.is_file():
            raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")
        manifest = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        for asset in manifest.get("assets", []):
            if "included" not in asset:
                asset["included"] = True
                changed = True
            if "asset_kind" not in asset:
                asset["asset_kind"] = "source"
                changed = True
            if "operations" not in asset:
                asset["operations"] = []
                changed = True
        if changed:
            _write_json(path, manifest)
        return path, manifest

    def state(self, project_id: str, revision_id: str) -> dict[str, Any]:
        _, manifest = self._load(project_id, revision_id)
        assets = manifest.get("assets", [])
        included = [a for a in assets if a.get("included", True)]
        derivatives = [a for a in assets if a.get("asset_kind") == "derived"]
        return {
            "revision": revision_id,
            "model_family": manifest.get("model_family", "generic"),
            "incoming_count": len(assets),
            "included_count": len(included),
            "excluded_count": len(assets) - len(included),
            "derivative_count": len(derivatives),
            "assets": assets,
        }

    def set_inclusion(self, project_id: str, revision_id: str, filenames: list[str], included: bool) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id)
        wanted = set(filenames)
        found: list[str] = []
        for asset in manifest.get("assets", []):
            if asset.get("filename") in wanted:
                asset["included"] = bool(included)
                found.append(str(asset["filename"]))
        missing = sorted(wanted - set(found))
        if missing:
            raise FileNotFoundError("Images not found in revision: " + ", ".join(missing))
        _write_json(manifest_path, manifest)
        event = {
            "time": _now(),
            "type": "image_inclusion_changed",
            "revision": revision_id,
            "included": bool(included),
            "filenames": sorted(found),
            "count": len(found),
        }
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", event)
        return self.state(project_id, revision_id)

    def set_all_inclusion(self, project_id: str, revision_id: str, included: bool) -> dict[str, Any]:
        _, manifest = self._load(project_id, revision_id)
        return self.set_inclusion(
            project_id,
            revision_id,
            [str(a.get("filename")) for a in manifest.get("assets", []) if a.get("filename")],
            included,
        )

    def append_operation(
        self,
        project_id: str,
        revision_id: str,
        filenames: list[str],
        operation: dict[str, Any],
    ) -> dict[str, Any]:
        """Record a requested prep operation.

        The execution engine will later materialize these operations. Recording them separately now
        gives us the durable pipeline/lineage model without pretending a transformation happened.
        """
        manifest_path, manifest = self._load(project_id, revision_id)
        wanted = set(filenames)
        found: list[str] = []
        stamp = {"recorded_at": _now(), **operation}
        for asset in manifest.get("assets", []):
            if asset.get("filename") in wanted:
                asset.setdefault("operations", []).append(stamp)
                found.append(str(asset["filename"]))
        missing = sorted(wanted - set(found))
        if missing:
            raise FileNotFoundError("Images not found in revision: " + ", ".join(missing))
        _write_json(manifest_path, manifest)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {
            "time": _now(),
            "type": "image_prep_operation_queued",
            "revision": revision_id,
            "filenames": sorted(found),
            "operation": operation,
        })
        return self.state(project_id, revision_id)


image_prep_store = ImagePrepStore()
