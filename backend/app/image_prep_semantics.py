"""Image Prep semantic fixes kept separate while the POC UI is being iterated.

This module patches the small set of policy helpers used by ``image_prep`` so existing
projects and run materialization agree on these rules:

* source images are uncropped by default;
* a per-image aspect override is an explicit request to crop that source image;
* physically-created derivatives are already framed and are not cropped again unless
  the user explicitly adds another transform override.
"""
from __future__ import annotations

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

    # A derivative file is itself the chosen composition. Do not apply the base
    # source-image aspect/crop to it again. Preserve its explicit derivative aspect
    # as metadata while leaving the pixels alone.
    derivative_aspect: str | None = None
    for operation in reversed(asset.get("operations", [])):
        if operation.get("type") in {"manual_crop", "face_crop"} and operation.get("aspect_ratio"):
            derivative_aspect = str(operation["aspect_ratio"])
            break

    if asset.get("asset_kind") == "derived" and "aspect_ratio" not in override:
        if derivative_aspect:
            transform["aspect_ratio"] = derivative_aspect
        transform["crop_mode"] = "fit"
        return transform

    aspect = str(transform.get("aspect_ratio", "source"))
    if aspect == "source":
        transform["crop_mode"] = "fit"
    elif "aspect_ratio" in override and "crop_mode" not in override:
        # Choosing a different aspect for one image is an explicit composition
        # exception. It must crop even when the global source policy is 'fit'.
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


prep._effective_transform = effective_transform
prep._crop_box = crop_box
