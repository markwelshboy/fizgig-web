"""Image Prep semantic fixes kept separate while the POC UI is being iterated."""
from __future__ import annotations

import importlib
from typing import Any

from . import image_prep as prep

prep.DEFAULT_GLOBAL_TRANSFORM.update({
    "aspect_ratio": "source",
    "crop_mode": "fit",
    "crop_x": 0.5,
    "crop_y": 0.5,
})


def effective_transform(manifest: dict[str, Any], asset: dict[str, Any]) -> dict[str, Any]:
    global_transform = {**prep.DEFAULT_GLOBAL_TRANSFORM, **manifest.get("global_transform", {})}
    override = dict(asset.get("transform_override", {}))
    transform = {**global_transform, **override}

    derivative_aspect: str | None = None
    for operation in reversed(asset.get("operations", [])):
        if operation.get("type") in {"manual_crop", "face_crop"} and operation.get("aspect_ratio"):
            derivative_aspect = str(operation["aspect_ratio"])
            break

    # A derived file already *is* the selected crop. Do not crop it again just
    # because the project's base composition has an aspect policy.
    if asset.get("asset_kind") == "derived" and "aspect_ratio" not in override:
        if derivative_aspect:
            transform["aspect_ratio"] = derivative_aspect
        transform["crop_mode"] = "fit"
        return transform

    aspect = str(transform.get("aspect_ratio", "source"))
    if aspect == "source":
        transform["crop_mode"] = "fit"
    elif "aspect_ratio" in override and "crop_mode" not in override:
        # A per-image aspect override is an explicit request to reframe the image.
        transform["crop_mode"] = "fill"

    return transform


def crop_box(width: int, height: int, transform: dict[str, Any]) -> tuple[int, int, int, int]:
    aspect = str(transform.get("aspect_ratio", "source"))
    if aspect == "source" or transform.get("crop_mode", "fit") != "fill":
        return 0, 0, width, height

    target = prep._parse_aspect(aspect)
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


def face_detector():
    missing: list[str] = []
    errors: list[str] = []
    for module in ("onnxruntime", "cv2", "insightface"):
        try:
            importlib.import_module(module)
        except ModuleNotFoundError as exc:
            missing.append(exc.name or module)
        except Exception as exc:
            errors.append(f"{module}: {type(exc).__name__}: {exc}")
    if missing or errors:
        detail = []
        if missing:
            detail.append("missing modules: " + ", ".join(sorted(set(missing))))
        if errors:
            detail.append("import errors: " + " | ".join(errors))
        raise RuntimeError("Face detection runtime is not ready (" + "; ".join(detail) + ")")

    try:
        from insightface.app import FaceAnalysis
        app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection"], providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=-1)
        return app
    except Exception as exc:
        raise RuntimeError(f"InsightFace buffalo_l initialization failed: {type(exc).__name__}: {exc}") from exc


prep._effective_transform = effective_transform
prep._crop_box = crop_box
prep._face_detector = face_detector
