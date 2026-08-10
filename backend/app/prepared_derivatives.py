from __future__ import annotations

import hashlib
import io
import math
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import numpy as np
from PIL import Image

from .crop_geometry import crop_box as scalable_crop_box
from .image_prep import _apply_tonal_adjustments, _aspect_units, _face_detector, _now, _sha256, _write_json, _append_jsonl, image_prep_store
from .projects import project_store


def _effective_transform(manifest: dict[str, Any], asset: dict[str, Any]) -> dict[str, Any]:
    # Keep this aligned with image_prep._effective_transform, but derivatives created
    # by this module carry a baked_transform marker and therefore do not inherit the
    # current global image adjustments a second time.
    defaults = {
        "aspect_ratio": "source",
        "crop_mode": "fit",
        "crop_x": 0.5,
        "crop_y": 0.5,
        "crop_scale": 1.0,
        "exposure": 0.0,
        "brightness": 0.0,
        "contrast": 0.0,
        "gamma": 1.0,
    }
    if asset.get("baked_transform"):
        transform = {**defaults, **asset.get("transform_override", {})}
    else:
        transform = {**defaults, **manifest.get("global_transform", {}), **asset.get("transform_override", {})}
    return transform


def _asset(manifest: dict[str, Any], filename: str, *, included_only: bool = False) -> dict[str, Any]:
    found = next((a for a in manifest.get("assets", []) if a.get("filename") == filename), None)
    if found is None or (included_only and not found.get("included", True)):
        raise FileNotFoundError(f"Image not found in revision: {filename}")
    return found


def _source_path(manifest: dict[str, Any], filename: str) -> Path:
    files_dir = Path(manifest["files_path"]).resolve()
    source = (files_dir / filename).resolve()
    if source.parent != files_dir or not source.is_file():
        raise FileNotFoundError(f"Working image not found: {filename}")
    return source


def _prepared_image(manifest: dict[str, Any], asset: dict[str, Any]) -> tuple[Image.Image, dict[str, Any]]:
    source = _source_path(manifest, str(asset["filename"]))
    with Image.open(source) as opened:
        image = opened.convert("RGB")
    transform = _effective_transform(manifest, asset)
    box = scalable_crop_box(image.width, image.height, transform)
    image = image.crop(box)
    image = _apply_tonal_adjustments(image, transform)
    return image, {"transform": transform, "source_box": list(box), "prepared_size": [image.width, image.height]}


def _exact_aspect_box(image_size: tuple[int, int], center: tuple[float, float], required_size: tuple[float, float], aspect_ratio: str) -> tuple[int, int, int, int]:
    img_w, img_h = image_size
    unit_w, unit_h = _aspect_units(aspect_ratio)
    req_w, req_h = max(1.0, required_size[0]), max(1.0, required_size[1])
    needed_k = max(1, math.ceil(max(req_w / unit_w, req_h / unit_h)))
    max_k = max(1, min(img_w // unit_w, img_h // unit_h))
    k = min(needed_k, max_k)
    crop_w, crop_h = unit_w * k, unit_h * k
    cx, cy = center
    left = int(round(cx - crop_w / 2))
    top = int(round(cy - crop_h / 2))
    left = max(0, min(img_w - crop_w, left))
    top = max(0, min(img_h - crop_h, top))
    return left, top, left + crop_w, top + crop_h


def _face_crop_box(image_size: tuple[int, int], bbox: tuple[int, int, int, int], padding_percent: float, aspect_ratio: str) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = bbox
    face_w = max(1, x2 - x1)
    face_h = max(1, y2 - y1)
    padding = max(0.0, padding_percent) / 100.0
    req_w = face_w * (1 + 2 * padding)
    req_h = face_h * (1 + 2 * padding)
    return _exact_aspect_box(image_size, ((x1 + x2) / 2.0, (y1 + y2) / 2.0), (req_w, req_h), aspect_ratio)


def _neutral_transform(aspect_ratio: str) -> dict[str, Any]:
    return {
        "aspect_ratio": aspect_ratio,
        "crop_mode": "fit",
        "crop_x": 0.5,
        "crop_y": 0.5,
        "crop_scale": 1.0,
        "exposure": 0.0,
        "brightness": 0.0,
        "contrast": 0.0,
        "gamma": 1.0,
    }


def _create_asset(
    project_id: str,
    revision_id: str,
    manifest_path: Path,
    manifest: dict[str, Any],
    parent: dict[str, Any],
    prepared: Image.Image,
    box: tuple[int, int, int, int],
    aspect_ratio: str,
    origin: str,
    operation: dict[str, Any],
    basis: dict[str, Any],
) -> dict[str, Any]:
    files_dir = Path(manifest["files_path"]).resolve()
    suffix = aspect_ratio.replace(":", "x")
    parent_stem = Path(str(parent["filename"])).stem
    index = 1
    while True:
        output_name = f"{parent_stem}_{origin}_{suffix}_{index:02d}.png"
        output = files_dir / output_name
        if not output.exists():
            break
        index += 1

    cropped = prepared.crop(box)
    cropped.save(output, format="PNG")
    asset = {
        "id": uuid.uuid4().hex[:16],
        "filename": output.name,
        "image_sha256": _sha256(output),
        "caption": "",
        "caption_sha256": hashlib.sha256(b"").hexdigest(),
        "origin": origin,
        "parent_asset_id": parent.get("id"),
        "parent_filename": parent.get("filename"),
        "asset_kind": "derived",
        "included": True,
        "baked_transform": basis,
        "transform_override": _neutral_transform(aspect_ratio),
        "operations": [operation],
    }
    manifest.setdefault("assets", []).append(asset)
    _write_json(manifest_path, manifest)
    return asset


class PreparedDerivativeService:
    def preview_png(self, project_id: str, revision_id: str, filename: str) -> bytes:
        _, manifest = image_prep_store._load(project_id, revision_id)
        asset = _asset(manifest, filename)
        image, _ = _prepared_image(manifest, asset)
        out = io.BytesIO()
        image.save(out, format="PNG")
        return out.getvalue()

    def preview_url(self, project_id: str, revision_id: str, filename: str) -> str:
        return f"/api/projects/{quote(project_id)}/revisions/{quote(revision_id)}/prep/assets/{quote(filename)}/prepared-preview"

    def create_manual_crop(self, project_id: str, revision_id: str, filename: str, crop: dict[str, float], aspect_ratio: str) -> dict[str, Any]:
        manifest_path, manifest = image_prep_store._load(project_id, revision_id)
        parent = _asset(manifest, filename, included_only=True)
        prepared, basis = _prepared_image(manifest, parent)
        width, height = prepared.size
        x = max(0.0, min(1.0, float(crop.get("x", 0.0))))
        y = max(0.0, min(1.0, float(crop.get("y", 0.0))))
        w = max(0.01, min(1.0 - x, float(crop.get("width", 1.0))))
        h = max(0.01, min(1.0 - y, float(crop.get("height", 1.0))))
        center = ((x + w / 2) * width, (y + h / 2) * height)
        required = (w * width, h * height)
        box = _exact_aspect_box((width, height), center, required, aspect_ratio)
        x1, y1, x2, y2 = box
        normalized = {"x": x1 / width, "y": y1 / height, "width": (x2 - x1) / width, "height": (y2 - y1) / height}
        operation = {
            "type": "manual_crop",
            "aspect_ratio": aspect_ratio,
            "normalized_crop": normalized,
            "pixel_box": list(box),
            "basis": basis,
            "created_at": _now(),
        }
        asset = _create_asset(project_id, revision_id, manifest_path, manifest, parent, prepared, box, aspect_ratio, "manual", operation, basis)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {"time": _now(), "type": "image_derived", "revision": revision_id, "method": "manual_crop", "parent": filename, "filename": asset["filename"], "aspect_ratio": aspect_ratio, "crop": operation})
        return {"asset": asset, "state": image_prep_store.state(project_id, revision_id)}

    def propose_face_crops(self, project_id: str, revision_id: str, filenames: list[str], aspect_ratio: str = "1:1", padding_percent: float = 60.0) -> dict[str, Any]:
        _, manifest = image_prep_store._load(project_id, revision_id)
        detector = _face_detector()
        try:
            import cv2
        except ImportError as exc:
            raise RuntimeError("Automatic face derivatives require OpenCV") from exc

        proposals: list[dict[str, Any]] = []
        for filename in filenames:
            try:
                asset = _asset(manifest, filename, included_only=True)
            except FileNotFoundError:
                continue
            prepared, basis = _prepared_image(manifest, asset)
            rgb = prepared.convert("RGB")
            arr = cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)
            faces = detector.get(arr)
            size = rgb.size
            preview_url = self.preview_url(project_id, revision_id, filename)
            for index, face in enumerate(sorted(faces, key=lambda f: float(getattr(f, "det_score", 0.0)), reverse=True)):
                raw = tuple(int(v) for v in face.bbox)
                box = _face_crop_box(size, raw, padding_percent, aspect_ratio)
                x1, y1, x2, y2 = box
                proposals.append({
                    "id": f"{asset.get('id', filename)}:{index}:{aspect_ratio}:{padding_percent}:{hashlib.sha1(str(basis).encode()).hexdigest()[:8]}",
                    "filename": filename,
                    "asset_id": asset.get("id"),
                    "face_index": index,
                    "score": round(float(getattr(face, "det_score", 0.0)), 4),
                    "face_bbox": list(raw),
                    "crop_box": list(box),
                    "normalized_crop": {"x": x1 / size[0], "y": y1 / size[1], "width": (x2 - x1) / size[0], "height": (y2 - y1) / size[1]},
                    "aspect_ratio": aspect_ratio,
                    "padding_percent": padding_percent,
                    "source_width": size[0],
                    "source_height": size[1],
                    "preview_url": preview_url,
                    "basis": basis,
                })
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {"time": _now(), "type": "face_crop_proposals_generated", "revision": revision_id, "filenames": filenames, "aspect_ratio": aspect_ratio, "padding_percent": padding_percent, "proposal_count": len(proposals), "prepared_images": True})
        return {"proposals": proposals}

    def accept_face_crops(self, project_id: str, revision_id: str, proposals: list[dict[str, Any]]) -> dict[str, Any]:
        manifest_path, manifest = image_prep_store._load(project_id, revision_id)
        created: list[dict[str, Any]] = []
        for proposal in proposals:
            filename = str(proposal.get("filename", ""))
            try:
                parent = _asset(manifest, filename, included_only=True)
            except FileNotFoundError:
                continue
            prepared, basis = _prepared_image(manifest, parent)
            raw_box = proposal.get("crop_box", [])
            if len(raw_box) != 4:
                continue
            aspect = str(proposal.get("aspect_ratio", "1:1"))
            x1, y1, x2, y2 = (int(v) for v in raw_box)
            exact = _exact_aspect_box(prepared.size, ((x1 + x2) / 2, (y1 + y2) / 2), (x2 - x1, y2 - y1), aspect)
            x1, y1, x2, y2 = exact
            operation = {
                "type": "face_crop",
                "detector": "InsightFace buffalo_l",
                "face_index": proposal.get("face_index"),
                "detection_score": proposal.get("score"),
                "face_bbox": proposal.get("face_bbox"),
                "padding_percent": proposal.get("padding_percent"),
                "aspect_ratio": aspect,
                "pixel_box": [x1, y1, x2, y2],
                "basis": basis,
                "created_at": _now(),
            }
            asset = _create_asset(project_id, revision_id, manifest_path, manifest, parent, prepared, (x1, y1, x2, y2), aspect, "face", operation, basis)
            created.append(asset)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {"time": _now(), "type": "face_crop_derivatives_created", "revision": revision_id, "count": len(created), "filenames": [a["filename"] for a in created], "prepared_images": True})
        return {"assets": created, "state": image_prep_store.state(project_id, revision_id)}

    def delete_derivative(self, project_id: str, revision_id: str, filename: str) -> dict[str, Any]:
        manifest_path, manifest = image_prep_store._load(project_id, revision_id)
        asset = _asset(manifest, filename)
        if asset.get("asset_kind") != "derived":
            raise ValueError("Only project-created derivative assets can be deleted")
        children = [a.get("filename") for a in manifest.get("assets", []) if a.get("parent_asset_id") == asset.get("id")]
        if children:
            raise ValueError("Cannot delete a derivative that has child derivatives: " + ", ".join(str(x) for x in children))
        path = _source_path(manifest, filename)
        caption_path = path.with_suffix(".txt")
        path.unlink(missing_ok=True)
        caption_path.unlink(missing_ok=True)
        manifest["assets"] = [a for a in manifest.get("assets", []) if a.get("filename") != filename]
        _write_json(manifest_path, manifest)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {"time": _now(), "type": "derivative_deleted", "revision": revision_id, "filename": filename, "asset_id": asset.get("id"), "origin": asset.get("origin"), "parent": asset.get("parent_filename")})
        return image_prep_store.state(project_id, revision_id)


prepared_derivative_service = PreparedDerivativeService()
