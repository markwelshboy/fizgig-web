from __future__ import annotations

import hashlib
import io
import json
import math
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .image_prep import image_prep_store
from .projects import IMAGE_EXTENSIONS, project_store


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


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _aspect_units(value: str) -> tuple[int, int]:
    try:
        left, right = str(value).split(":", 1)
        width, height = int(left), int(right)
        if width <= 0 or height <= 0:
            raise ValueError
        common = math.gcd(width, height)
        return width // common, height // common
    except Exception:
        return 1, 1


def _bucket_for(width: int, height: int, policy: dict[str, Any]) -> dict[str, Any]:
    step = max(8, int(policy.get("dimension_step", 16)))
    max_pixels = max(0.01, float(policy.get("max_megapixels", 1.0))) * 1_000_000
    source_pixels = max(1, width * height)
    requested_scale = math.sqrt(max_pixels / source_pixels)
    scale = min(1.0, requested_scale) if bool(policy.get("bucket_no_upscale", True)) else requested_scale
    target_w = max(step, int(width * scale) // step * step)
    target_h = max(step, int(height * scale) // step * step)
    return {
        "bucket_width": target_w,
        "bucket_height": target_h,
        "direction": "native" if target_w == width and target_h == height else "downscale",
    }


def _aligned_aspect_base(aspect_ratio: str, step: int) -> tuple[int, int]:
    unit_w, unit_h = _aspect_units(aspect_ratio)
    multiple_w = step // math.gcd(step, unit_w)
    multiple_h = step // math.gcd(step, unit_h)
    k = math.lcm(multiple_w, multiple_h)
    return unit_w * k, unit_h * k


def _next_import_id(project_dir: Path, project: dict[str, Any]) -> str:
    number = max(1, len(project.get("imports", [])) + 1)
    while True:
        candidate = f"import-{number:04d}"
        if not (project_dir / "imports" / candidate).exists():
            return candidate
        number += 1


def _unique_filename(original: str, existing: set[str]) -> str:
    name = Path(original).name.strip()
    if not name:
        name = "imported-image.png"
    candidate = name
    stem = Path(name).stem or "imported-image"
    suffix = Path(name).suffix.lower()
    index = 2
    while candidate.lower() in existing:
        candidate = f"{stem}_import{index}{suffix}"
        index += 1
    existing.add(candidate.lower())
    return candidate


class ImagePrepFlowService:
    """Higher-level Image Prep workflow helpers.

    These operations deliberately sit alongside ImagePrepStore rather than changing the original
    import snapshot semantics. Supplemental browser imports create a new immutable import snapshot
    and copy those first-class source assets into the current working revision.
    """

    def import_images(
        self,
        project_id: str,
        revision_id: str,
        uploads: list[tuple[str, bytes]],
    ) -> dict[str, Any]:
        if not uploads:
            raise ValueError("Choose at least one image to import")

        project_dir = project_store.project_dir(project_id)
        revision_path = (project_dir / "datasets" / revision_id / "manifest.json").resolve()
        if project_dir not in revision_path.parents or not revision_path.is_file():
            raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")

        # Ensure old revisions have the modern inclusion/asset-kind fields before appending.
        image_prep_store.state(project_id, revision_id)
        manifest = json.loads(revision_path.read_text(encoding="utf-8"))
        project = project_store.get_project(project_id)
        revision_files = Path(manifest["files_path"]).resolve()
        existing_names = {str(asset.get("filename", "")).lower() for asset in manifest.get("assets", [])}

        validated: list[tuple[str, str, bytes, tuple[int, int]]] = []
        total_bytes = 0
        try:
            from PIL import Image
        except Exception as exc:
            raise RuntimeError("Supplemental image import requires Pillow") from exc

        for original_name, data in uploads:
            suffix = Path(original_name).suffix.lower()
            if suffix not in IMAGE_EXTENSIONS:
                raise ValueError(f"Unsupported image type: {original_name}")
            if not data:
                raise ValueError(f"Imported image is empty: {original_name}")
            total_bytes += len(data)
            if total_bytes > 512 * 1024 * 1024:
                raise ValueError("Supplemental image import is limited to 512 MB per operation")
            try:
                with Image.open(io.BytesIO(data)) as image:
                    image.verify()
                with Image.open(io.BytesIO(data)) as image:
                    dimensions = image.size
            except Exception as exc:
                raise ValueError(f"Unable to read image {original_name}: {exc}") from exc
            final_name = _unique_filename(original_name, existing_names)
            validated.append((original_name, final_name, data, dimensions))

        import_id = _next_import_id(project_dir, project)
        import_dir = project_dir / "imports" / import_id
        import_files = import_dir / "files"
        import_files.mkdir(parents=True, exist_ok=False)
        created_revision_files: list[Path] = []
        imported_assets: list[dict[str, Any]] = []

        try:
            for original_name, final_name, data, dimensions in validated:
                snapshot_path = import_files / final_name
                snapshot_path.write_bytes(data)
                working_path = revision_files / final_name
                shutil.copy2(snapshot_path, working_path)
                created_revision_files.append(working_path)
                digest = _sha256_bytes(data)
                asset = {
                    "id": uuid.uuid4().hex[:16],
                    "filename": final_name,
                    "original_filename": Path(original_name).name,
                    "external_source_path": f"browser-upload://{Path(original_name).name}",
                    "image_sha256": digest,
                    "caption": "",
                    "caption_sha256": hashlib.sha256(b"").hexdigest(),
                    "origin": "supplemental_import",
                    "import_id": import_id,
                    "parent_asset_id": None,
                    "operations": [],
                    "included": True,
                    "asset_kind": "source",
                    "transform_override": {},
                    "source_dimensions": list(dimensions),
                }
                imported_assets.append(asset)

            import_manifest = {
                "id": import_id,
                "created_at": _now(),
                "source_type": "supplemental_browser_upload",
                "purpose": "immutable_reproducibility_snapshot",
                "files_path": str(import_files),
                "image_count": len(imported_assets),
                "assets": imported_assets,
            }
            _write_json(import_dir / "manifest.json", import_manifest)

            manifest.setdefault("assets", []).extend(imported_assets)
            _write_json(revision_path, manifest)

            project.setdefault("imports", []).append({
                "id": import_id,
                "created_at": import_manifest["created_at"],
                "image_count": len(imported_assets),
                "path": str(import_files),
                "source_type": "supplemental_browser_upload",
            })
            for summary in project.get("dataset_revisions", []):
                if summary.get("id") == revision_id:
                    summary["image_count"] = len(manifest.get("assets", []))
                    break
            project["updated_at"] = _now()
            _write_json(project_dir / "project.json", project)
            _append_jsonl(project_dir / "events.jsonl", {
                "time": _now(),
                "type": "supplemental_images_imported",
                "revision": revision_id,
                "import_id": import_id,
                "count": len(imported_assets),
                "filenames": [asset["filename"] for asset in imported_assets],
                "source_type": "browser_upload",
            })
        except Exception:
            for path in created_revision_files:
                try:
                    path.unlink()
                except OSError:
                    pass
            shutil.rmtree(import_dir, ignore_errors=True)
            raise

        return {
            "project": project_store.get_project(project_id),
            "revision": project_store.get_revision(project_id, revision_id),
            "state": image_prep_store.state(project_id, revision_id),
            "import": {
                "id": import_id,
                "image_count": len(imported_assets),
                "filenames": [asset["filename"] for asset in imported_assets],
            },
        }

    def manual_crop_presets(self, project_id: str, revision_id: str, filename: str, aspect_ratio: str) -> dict[str, Any]:
        project_dir = project_store.project_dir(project_id)
        revision_path = (project_dir / "datasets" / revision_id / "manifest.json").resolve()
        if project_dir not in revision_path.parents or not revision_path.is_file():
            raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")
        image_prep_store.state(project_id, revision_id)
        manifest = json.loads(revision_path.read_text(encoding="utf-8"))
        asset = next(
            (
                item for item in manifest.get("assets", [])
                if item.get("filename") == filename and item.get("asset_kind") != "derived" and item.get("included", True)
            ),
            None,
        )
        if asset is None:
            raise FileNotFoundError(f"Included source image not found: {filename}")
        files_dir = Path(manifest["files_path"]).resolve()
        source = (files_dir / filename).resolve()
        if source.parent != files_dir or not source.is_file():
            raise FileNotFoundError(f"Working image not found: {filename}")

        try:
            from PIL import Image
        except Exception as exc:
            raise RuntimeError("Manual crop presets require Pillow") from exc
        with Image.open(source) as image:
            source_width, source_height = image.size

        policy = manifest.get("training_resolution", {})
        step = max(8, int(policy.get("dimension_step", 16)))
        max_pixels = max(0.01, float(policy.get("max_megapixels", 1.0))) * 1_000_000
        base_w, base_h = _aligned_aspect_base(aspect_ratio, step)
        max_by_pixels = int(math.floor(math.sqrt(max_pixels / max(1, base_w * base_h))))
        max_by_source = min(source_width // base_w, source_height // base_h)
        multiplier = min(max_by_pixels, max_by_source) if bool(policy.get("bucket_no_upscale", True)) else max_by_pixels

        if multiplier < 1:
            unit_w, unit_h = _aspect_units(aspect_ratio)
            multiplier = max(1, min(source_width // unit_w, source_height // unit_h))
            native_w, native_h = unit_w * multiplier, unit_h * multiplier
        else:
            native_w, native_h = base_w * multiplier, base_h * multiplier

        candidates = [
            ("trainer", "Trainer native", multiplier),
            ("half", "Half bucket", max(1, multiplier // 2)),
            ("quarter", "Quarter bucket", max(1, multiplier // 4)),
        ]
        rows: list[dict[str, Any]] = []
        seen: set[tuple[int, int]] = set()
        for preset_id, label, value in candidates:
            if native_w == _aspect_units(aspect_ratio)[0] * multiplier and multiplier < 1:
                width, height = native_w, native_h
            elif base_w <= source_width and base_h <= source_height:
                width, height = base_w * value, base_h * value
            else:
                unit_w, unit_h = _aspect_units(aspect_ratio)
                width, height = unit_w * value, unit_h * value
            if width > source_width or height > source_height:
                scale = min(source_width / max(1, width), source_height / max(1, height))
                width = max(1, int(width * scale))
                height = max(1, int(height * scale))
            key = (width, height)
            if key in seen:
                continue
            seen.add(key)
            bucket = _bucket_for(width, height, policy)
            rows.append({
                "id": preset_id,
                "label": label,
                "width": width,
                "height": height,
                "megapixels": round(width * height / 1_000_000, 3),
                "bucket_width": bucket["bucket_width"],
                "bucket_height": bucket["bucket_height"],
                "resize_required": bucket["bucket_width"] != width or bucket["bucket_height"] != height,
            })

        return {
            "filename": filename,
            "aspect_ratio": aspect_ratio,
            "source_width": source_width,
            "source_height": source_height,
            "training_resolution": policy,
            "presets": rows,
        }


image_prep_flow_service = ImagePrepFlowService()
