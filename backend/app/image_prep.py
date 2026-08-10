from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .projects import project_store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


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


DEFAULT_GLOBAL_TRANSFORM: dict[str, Any] = {
    "aspect_ratio": "16:9",
    "target_width": 1344,
    "target_height": 768,
    "crop_mode": "fill",
    "crop_x": 0.5,
    "crop_y": 0.5,
    "exposure": 0.0,
    "brightness": 0.0,
    "contrast": 0.0,
    "gamma": 1.0,
}


class ImagePrepStore:
    """Dataset-construction state for a project scratch revision."""

    def _load(self, project_id: str, revision_id: str) -> tuple[Path, dict[str, Any]]:
        project_dir = project_store.project_dir(project_id)
        path = (project_dir / "datasets" / revision_id / "manifest.json").resolve()
        if project_dir not in path.parents or not path.is_file():
            raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")
        manifest = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        if "global_transform" not in manifest:
            manifest["global_transform"] = dict(DEFAULT_GLOBAL_TRANSFORM)
            changed = True
        for asset in manifest.get("assets", []):
            if "included" not in asset:
                asset["included"] = True; changed = True
            if "asset_kind" not in asset:
                asset["asset_kind"] = "source"; changed = True
            if "operations" not in asset:
                asset["operations"] = []; changed = True
            if "transform_override" not in asset:
                asset["transform_override"] = {}; changed = True
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
            "global_transform": manifest.get("global_transform", DEFAULT_GLOBAL_TRANSFORM),
            "assets": assets,
        }

    def set_inclusion(self, project_id: str, revision_id: str, filenames: list[str], included: bool) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id)
        wanted = set(filenames); found: list[str] = []
        for asset in manifest.get("assets", []):
            if asset.get("filename") in wanted:
                asset["included"] = bool(included); found.append(str(asset["filename"]))
        missing = sorted(wanted - set(found))
        if missing:
            raise FileNotFoundError("Images not found in revision: " + ", ".join(missing))
        _write_json(manifest_path, manifest)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {
            "time": _now(), "type": "image_inclusion_changed", "revision": revision_id,
            "included": bool(included), "filenames": sorted(found), "count": len(found),
        })
        return self.state(project_id, revision_id)

    def set_all_inclusion(self, project_id: str, revision_id: str, included: bool) -> dict[str, Any]:
        _, manifest = self._load(project_id, revision_id)
        return self.set_inclusion(project_id, revision_id, [str(a.get("filename")) for a in manifest.get("assets", []) if a.get("filename")], included)

    def set_global_transform(self, project_id: str, revision_id: str, transform: dict[str, Any]) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id)
        merged = {**DEFAULT_GLOBAL_TRANSFORM, **manifest.get("global_transform", {}), **transform}
        manifest["global_transform"] = merged
        _write_json(manifest_path, manifest)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {
            "time": _now(), "type": "global_image_transform_changed", "revision": revision_id, "transform": merged,
        })
        return self.state(project_id, revision_id)

    def set_asset_transform(self, project_id: str, revision_id: str, filename: str, override: dict[str, Any]) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id)
        asset = next((a for a in manifest.get("assets", []) if a.get("filename") == filename), None)
        if asset is None:
            raise FileNotFoundError(f"Image not found in revision: {filename}")
        asset["transform_override"] = override
        _write_json(manifest_path, manifest)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {
            "time": _now(), "type": "image_transform_override_changed", "revision": revision_id,
            "filename": filename, "override": override,
        })
        return self.state(project_id, revision_id)

    def create_manual_crop(self, project_id: str, revision_id: str, filename: str, crop: dict[str, float], aspect_ratio: str) -> dict[str, Any]:
        try:
            from PIL import Image
        except Exception as exc:
            raise RuntimeError("Manual crop creation requires Pillow") from exc

        manifest_path, manifest = self._load(project_id, revision_id)
        parent = next((a for a in manifest.get("assets", []) if a.get("filename") == filename), None)
        if parent is None:
            raise FileNotFoundError(f"Image not found in revision: {filename}")
        files_dir = Path(manifest["files_path"]).resolve()
        source = (files_dir / filename).resolve()
        if source.parent != files_dir or not source.is_file():
            raise FileNotFoundError(f"Working image not found: {filename}")

        with Image.open(source) as image:
            width, height = image.size
            x = max(0.0, min(1.0, float(crop.get("x", 0.0))))
            y = max(0.0, min(1.0, float(crop.get("y", 0.0))))
            w = max(0.01, min(1.0 - x, float(crop.get("width", 1.0))))
            h = max(0.01, min(1.0 - y, float(crop.get("height", 1.0))))
            box = (round(x * width), round(y * height), round((x + w) * width), round((y + h) * height))
            cropped = image.convert("RGB").crop(box)
            suffix = aspect_ratio.replace(":", "x")
            index = 1
            while True:
                output_name = f"{source.stem}_manual_{suffix}_{index:02d}.png"
                output = files_dir / output_name
                if not output.exists():
                    break
                index += 1
            cropped.save(output, format="PNG")

        asset = {
            "id": uuid.uuid4().hex[:16],
            "filename": output.name,
            "image_sha256": _sha256(output),
            "caption": "",
            "caption_sha256": hashlib.sha256(b"").hexdigest(),
            "origin": "manual_crop",
            "parent_asset_id": parent.get("id"),
            "parent_filename": filename,
            "asset_kind": "derived",
            "included": True,
            "transform_override": {},
            "operations": [{
                "type": "manual_crop", "aspect_ratio": aspect_ratio,
                "normalized_crop": {"x": x, "y": y, "width": w, "height": h},
                "pixel_box": list(box), "created_at": _now(),
            }],
        }
        manifest.setdefault("assets", []).append(asset)
        _write_json(manifest_path, manifest)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {
            "time": _now(), "type": "image_derived", "revision": revision_id,
            "method": "manual_crop", "parent": filename, "filename": output.name,
            "aspect_ratio": aspect_ratio, "crop": asset["operations"][0],
        })
        return {"asset": asset, "state": self.state(project_id, revision_id)}

    def append_operation(self, project_id: str, revision_id: str, filenames: list[str], operation: dict[str, Any]) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id)
        wanted = set(filenames); found: list[str] = []; stamp = {"recorded_at": _now(), **operation}
        for asset in manifest.get("assets", []):
            if asset.get("filename") in wanted:
                asset.setdefault("operations", []).append(stamp); found.append(str(asset["filename"]))
        missing = sorted(wanted - set(found))
        if missing:
            raise FileNotFoundError("Images not found in revision: " + ", ".join(missing))
        _write_json(manifest_path, manifest)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {
            "time": _now(), "type": "image_prep_operation_queued", "revision": revision_id,
            "filenames": sorted(found), "operation": operation,
        })
        return self.state(project_id, revision_id)

    def materialize_run_dataset(self, project_id: str, revision_id: str, run: dict[str, Any]) -> dict[str, Any]:
        """Build the exact trainer-facing dataset from included project assets only."""
        _, manifest = self._load(project_id, revision_id)
        source_dir = Path(manifest["files_path"]).resolve()
        run_dir = Path(run["output_dir"]).resolve()
        trainer_dir = run_dir / "dataset"
        if trainer_dir.exists():
            shutil.rmtree(trainer_dir)
        trainer_dir.mkdir(parents=True)

        snapshot_assets: list[dict[str, Any]] = []
        for asset in manifest.get("assets", []):
            if not asset.get("included", True):
                continue
            filename = str(asset.get("filename", ""))
            if not filename:
                continue
            src = (source_dir / filename).resolve()
            if src.parent != source_dir or not src.is_file():
                continue
            dst = trainer_dir / filename
            shutil.copy2(src, dst)
            caption = str(asset.get("caption", "")).strip()
            dst.with_suffix(".txt").write_text(caption + ("\n" if caption else ""), encoding="utf-8")
            snapshot_assets.append({
                "asset_id": asset.get("id"), "filename": filename, "image_sha256": _sha256(dst),
                "caption": caption, "caption_sha256": hashlib.sha256(caption.encode("utf-8")).hexdigest(),
                "origin": asset.get("origin"), "asset_kind": asset.get("asset_kind", "source"),
                "parent_asset_id": asset.get("parent_asset_id"), "operations": asset.get("operations", []),
                "global_transform": manifest.get("global_transform", DEFAULT_GLOBAL_TRANSFORM),
                "transform_override": asset.get("transform_override", {}),
            })

        if not snapshot_assets:
            raise ValueError("Working dataset contains no included images")

        snapshot = {
            "created_at": _now(), "project_id": project_id, "run_id": run["id"],
            "dataset_revision": revision_id, "dataset_is_scratch": True,
            "trainer_dataset_path": str(trainer_dir), "image_count": len(snapshot_assets),
            "global_transform": manifest.get("global_transform", DEFAULT_GLOBAL_TRANSFORM), "assets": snapshot_assets,
        }
        _write_json(run_dir / "dataset_snapshot.json", snapshot)
        run["dataset_path"] = str(trainer_dir)
        run["dataset_source_revision_path"] = str(source_dir)
        run["dataset_image_count"] = len(snapshot_assets)
        _write_json(run_dir / "run.json", run)
        _append_jsonl(run_dir / "events.jsonl", {"time": _now(), "type": "trainer_dataset_materialized", "revision": revision_id, "path": str(trainer_dir), "image_count": len(snapshot_assets)})
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {"time": _now(), "type": "trainer_dataset_materialized", "run_id": run["id"], "revision": revision_id, "image_count": len(snapshot_assets)})
        return run


image_prep_store = ImagePrepStore()
