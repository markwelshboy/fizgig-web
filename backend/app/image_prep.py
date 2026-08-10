from __future__ import annotations

import hashlib
import json
import math
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
    "crop_mode": "fill",
    "crop_x": 0.5,
    "crop_y": 0.5,
    "exposure": 0.0,
    "brightness": 0.0,
    "contrast": 0.0,
    "gamma": 1.0,
}

DEFAULT_TRAINING_RESOLUTION: dict[str, Any] = {
    "max_megapixels": 1.0,
    "enable_bucket": True,
    "bucket_no_upscale": True,
    "dimension_step": 16,
}


def _image_dimensions(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image
    except Exception as exc:
        raise RuntimeError("Image inspection requires Pillow") from exc
    with Image.open(path) as image:
        return image.size


def _parse_aspect(value: str) -> float:
    try:
        left, right = str(value).split(":", 1)
        ratio = float(left) / float(right)
        return ratio if ratio > 0 else 1.0
    except Exception:
        return 1.0


def _effective_transform(manifest: dict[str, Any], asset: dict[str, Any]) -> dict[str, Any]:
    transform = {
        **DEFAULT_GLOBAL_TRANSFORM,
        **manifest.get("global_transform", {}),
        **asset.get("transform_override", {}),
    }
    # Manual derivatives are already meaningful crops in their own right. If the
    # user has not explicitly overridden their aspect, preserve the derivative's
    # aspect rather than applying the global source-image aspect on top of it.
    if "aspect_ratio" not in asset.get("transform_override", {}):
        for operation in reversed(asset.get("operations", [])):
            if operation.get("type") == "manual_crop" and operation.get("aspect_ratio"):
                transform["aspect_ratio"] = operation["aspect_ratio"]
                break
    return transform


def _crop_box(width: int, height: int, transform: dict[str, Any]) -> tuple[int, int, int, int]:
    """Return the source-pixel box used by the composition transform.

    crop_x/crop_y are positions through the available crop slack: 0 is the
    leading edge, .5 is centered, 1 is the trailing edge. `fit` preserves the
    whole source image; `fill` creates the largest in-bounds crop at the target
    aspect ratio.
    """
    if transform.get("crop_mode", "fill") != "fill":
        return 0, 0, width, height

    target = _parse_aspect(str(transform.get("aspect_ratio", "1:1")))
    source = width / max(1, height)
    pos_x = max(0.0, min(1.0, float(transform.get("crop_x", 0.5))))
    pos_y = max(0.0, min(1.0, float(transform.get("crop_y", 0.5))))

    if abs(source - target) < 1e-6:
        return 0, 0, width, height
    if source > target:
        crop_h = height
        crop_w = max(1, min(width, round(height * target)))
        left = round((width - crop_w) * pos_x)
        return left, 0, left + crop_w, crop_h

    crop_w = width
    crop_h = max(1, min(height, round(width / target)))
    top = round((height - crop_h) * pos_y)
    return 0, top, crop_w, top + crop_h


def _bucket_for(width: int, height: int, policy: dict[str, Any]) -> dict[str, Any]:
    """Resolve an aspect bucket under one maximum pixel budget.

    With bucket_no_upscale enabled, images/crops below the budget remain near
    native resolution (rounded down to the architecture step). Larger inputs are
    downscaled to a same-aspect bucket near max_megapixels.
    """
    step = max(8, int(policy.get("dimension_step", 16)))
    max_pixels = max(0.01, float(policy.get("max_megapixels", 1.0))) * 1_000_000
    source_pixels = max(1, width * height)
    no_upscale = bool(policy.get("bucket_no_upscale", True))
    requested_scale = math.sqrt(max_pixels / source_pixels)
    scale = min(1.0, requested_scale) if no_upscale else requested_scale
    target_w = max(step, int(width * scale) // step * step)
    target_h = max(step, int(height * scale) // step * step)
    target_pixels = target_w * target_h
    linear_scale = min(target_w / max(1, width), target_h / max(1, height))
    return {
        "source_width": width,
        "source_height": height,
        "source_megapixels": round(source_pixels / 1_000_000, 3),
        "bucket_width": target_w,
        "bucket_height": target_h,
        "bucket_megapixels": round(target_pixels / 1_000_000, 3),
        "linear_scale": round(linear_scale, 3),
        "direction": "downscale" if linear_scale < 0.995 else ("upscale" if linear_scale > 1.005 else "native"),
        "low_detail": source_pixels < max_pixels * 0.5,
    }


def _resolution_analysis(path: Path, transform: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    file_width, file_height = _image_dimensions(path)
    box = _crop_box(file_width, file_height, transform)
    crop_width = max(1, box[2] - box[0])
    crop_height = max(1, box[3] - box[1])
    bucket = _bucket_for(crop_width, crop_height, policy)
    return {
        "file_width": file_width,
        "file_height": file_height,
        "file_megapixels": round(file_width * file_height / 1_000_000, 3),
        "crop_box": list(box),
        "crop_width": crop_width,
        "crop_height": crop_height,
        "crop_megapixels": round(crop_width * crop_height / 1_000_000, 3),
        "effective_transform": transform,
        **bucket,
    }


def _apply_tonal_adjustments(image, transform: dict[str, Any]):
    from PIL import ImageEnhance

    exposure = float(transform.get("exposure", 0.0))
    brightness = float(transform.get("brightness", 0.0))
    contrast = float(transform.get("contrast", 0.0))
    gamma = max(0.05, float(transform.get("gamma", 1.0)))

    exposure_factor = 2.0 ** max(-8.0, min(8.0, exposure))
    brightness_factor = max(0.0, 1.0 + brightness)
    contrast_factor = max(0.0, 1.0 + contrast)

    if abs(exposure_factor - 1.0) > 1e-6:
        image = ImageEnhance.Brightness(image).enhance(exposure_factor)
    if abs(brightness_factor - 1.0) > 1e-6:
        image = ImageEnhance.Brightness(image).enhance(brightness_factor)
    if abs(contrast_factor - 1.0) > 1e-6:
        image = ImageEnhance.Contrast(image).enhance(contrast_factor)
    if abs(gamma - 1.0) > 1e-6:
        inv_gamma = 1.0 / gamma
        lut = [min(255, max(0, round(((i / 255.0) ** inv_gamma) * 255.0))) for i in range(256)]
        image = image.point(lut * len(image.getbands()))
    return image


def _materialize_transform(src: Path, dst: Path, transform: dict[str, Any]) -> dict[str, Any]:
    try:
        from PIL import Image
    except Exception as exc:
        raise RuntimeError("Image transform materialization requires Pillow") from exc

    with Image.open(src) as opened:
        image = opened.convert("RGB")
        file_width, file_height = image.size
        box = _crop_box(file_width, file_height, transform)
        image = image.crop(box)
        image = _apply_tonal_adjustments(image, transform)
        dst.parent.mkdir(parents=True, exist_ok=True)
        suffix = dst.suffix.lower()
        if suffix in {".jpg", ".jpeg"}:
            image.save(dst, quality=95, subsampling=0)
        elif suffix == ".webp":
            image.save(dst, quality=95)
        else:
            # Pillow selects PNG/BMP/etc. from the extension.
            image.save(dst)
        return {
            "source_file_size": [file_width, file_height],
            "crop_box": list(box),
            "materialized_size": [image.width, image.height],
            "transform": transform,
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
        if "training_resolution" not in manifest:
            manifest["training_resolution"] = dict(DEFAULT_TRAINING_RESOLUTION)
            changed = True
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
            if "transform_override" not in asset:
                asset["transform_override"] = {}
                changed = True
        if changed:
            _write_json(path, manifest)
        return path, manifest

    def state(self, project_id: str, revision_id: str) -> dict[str, Any]:
        _, manifest = self._load(project_id, revision_id)
        assets = manifest.get("assets", [])
        included = [a for a in assets if a.get("included", True)]
        derivatives = [a for a in assets if a.get("asset_kind") == "derived"]
        files_dir = Path(manifest["files_path"]).resolve()
        policy = manifest.get("training_resolution", DEFAULT_TRAINING_RESOLUTION)
        resolution_assets = []
        for asset in included:
            path = (files_dir / str(asset.get("filename", ""))).resolve()
            if path.parent == files_dir and path.is_file():
                transform = _effective_transform(manifest, asset)
                resolution_assets.append({
                    "filename": asset.get("filename"),
                    **_resolution_analysis(path, transform, policy),
                })
        return {
            "revision": revision_id,
            "model_family": manifest.get("model_family", "generic"),
            "incoming_count": len(assets),
            "included_count": len(included),
            "excluded_count": len(assets) - len(included),
            "derivative_count": len(derivatives),
            "global_transform": manifest.get("global_transform", DEFAULT_GLOBAL_TRANSFORM),
            "training_resolution": policy,
            "resolution_assets": resolution_assets,
            "assets": assets,
        }

    def set_training_resolution(self, project_id: str, revision_id: str, policy: dict[str, Any]) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id)
        merged = {**DEFAULT_TRAINING_RESOLUTION, **manifest.get("training_resolution", {}), **policy}
        merged["max_megapixels"] = max(0.05, min(8.0, float(merged["max_megapixels"])))
        merged["enable_bucket"] = bool(merged.get("enable_bucket", True))
        merged["bucket_no_upscale"] = bool(merged.get("bucket_no_upscale", True))
        merged["dimension_step"] = max(8, int(merged.get("dimension_step", 16)))
        manifest["training_resolution"] = merged
        _write_json(manifest_path, manifest)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {
            "time": _now(), "type": "training_resolution_changed", "revision": revision_id, "policy": merged,
        })
        return self.state(project_id, revision_id)

    def set_inclusion(self, project_id: str, revision_id: str, filenames: list[str], included: bool) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id)
        wanted = set(filenames)
        found = []
        for asset in manifest.get("assets", []):
            if asset.get("filename") in wanted:
                asset["included"] = bool(included)
                found.append(str(asset["filename"]))
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
        return self.set_inclusion(
            project_id,
            revision_id,
            [str(a.get("filename")) for a in manifest.get("assets", []) if a.get("filename")],
            included,
        )

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
            "transform_override": {"aspect_ratio": aspect_ratio},
            "operations": [{
                "type": "manual_crop",
                "aspect_ratio": aspect_ratio,
                "normalized_crop": {"x": x, "y": y, "width": w, "height": h},
                "pixel_box": list(box),
                "created_at": _now(),
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
        wanted = set(filenames)
        found = []
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
            "time": _now(), "type": "image_prep_operation_queued", "revision": revision_id,
            "filenames": sorted(found), "operation": operation,
        })
        return self.state(project_id, revision_id)

    def materialize_run_dataset(self, project_id: str, revision_id: str, run: dict[str, Any]) -> dict[str, Any]:
        """Build exact trainer-facing files from effective project transforms.

        Project assets remain untouched and high-resolution. The run-local image
        is cropped/tonally adjusted at source detail, then Fizgig's dataset
        bucketer/cache pass can only downscale it according to training_resolution.
        """
        _, manifest = self._load(project_id, revision_id)
        source_dir = Path(manifest["files_path"]).resolve()
        run_dir = Path(run["output_dir"]).resolve()
        trainer_dir = run_dir / "dataset"
        if trainer_dir.exists():
            shutil.rmtree(trainer_dir)
        trainer_dir.mkdir(parents=True)
        policy = manifest.get("training_resolution", DEFAULT_TRAINING_RESOLUTION)
        snapshot_assets = []

        for asset in manifest.get("assets", []):
            if not asset.get("included", True):
                continue
            filename = str(asset.get("filename", ""))
            src = (source_dir / filename).resolve()
            if not filename or src.parent != source_dir or not src.is_file():
                continue

            transform = _effective_transform(manifest, asset)
            dst = trainer_dir / filename
            transform_result = _materialize_transform(src, dst, transform)
            caption = str(asset.get("caption", "")).strip()
            dst.with_suffix(".txt").write_text(caption + ("\n" if caption else ""), encoding="utf-8")

            materialized_width, materialized_height = transform_result["materialized_size"]
            bucket = _bucket_for(materialized_width, materialized_height, policy)
            snapshot_assets.append({
                "asset_id": asset.get("id"),
                "filename": filename,
                "project_image_sha256": asset.get("image_sha256") or _sha256(src),
                "trainer_image_sha256": _sha256(dst),
                "caption": caption,
                "caption_sha256": hashlib.sha256(caption.encode("utf-8")).hexdigest(),
                "origin": asset.get("origin"),
                "asset_kind": asset.get("asset_kind", "source"),
                "parent_asset_id": asset.get("parent_asset_id"),
                "operations": asset.get("operations", []),
                "global_transform": manifest.get("global_transform", DEFAULT_GLOBAL_TRANSFORM),
                "transform_override": asset.get("transform_override", {}),
                "effective_transform": transform,
                "materialized_transform": transform_result,
                "training_bucket": bucket,
            })

        if not snapshot_assets:
            raise ValueError("Working dataset contains no included images")

        snapshot = {
            "created_at": _now(),
            "project_id": project_id,
            "run_id": run["id"],
            "dataset_revision": revision_id,
            "dataset_is_scratch": True,
            "trainer_dataset_path": str(trainer_dir),
            "image_count": len(snapshot_assets),
            "global_transform": manifest.get("global_transform", DEFAULT_GLOBAL_TRANSFORM),
            "training_resolution": policy,
            "assets": snapshot_assets,
        }
        _write_json(run_dir / "dataset_snapshot.json", snapshot)
        run["dataset_path"] = str(trainer_dir)
        run["dataset_source_revision_path"] = str(source_dir)
        run["dataset_image_count"] = len(snapshot_assets)
        run.setdefault("config", {})["training_resolution"] = policy
        _write_json(run_dir / "run.json", run)
        event = {
            "time": _now(),
            "type": "trainer_dataset_materialized",
            "revision": revision_id,
            "path": str(trainer_dir),
            "image_count": len(snapshot_assets),
            "training_resolution": policy,
            "transforms_materialized": True,
        }
        _append_jsonl(run_dir / "events.jsonl", event)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {**event, "run_id": run["id"]})
        return run


image_prep_store = ImagePrepStore()
