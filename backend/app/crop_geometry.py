from __future__ import annotations


def _parse_aspect(value: str) -> float:
    try:
        left, right = value.split(":", 1)
        ratio = float(left) / float(right)
        return ratio if ratio > 0 else 1.0
    except Exception:
        return 1.0


def crop_box(width: int, height: int, transform: dict) -> tuple[int, int, int, int]:
    """Resolve a composition crop fully inside the source.

    crop_scale=1 means the largest fitting rectangle at the requested aspect.
    Smaller values shrink that rectangle while retaining aspect, after which
    crop_x/crop_y position it over both available axes.
    """
    aspect = str(transform.get("aspect_ratio", "source"))
    if aspect == "source" or transform.get("crop_mode", "fit") != "fill":
        return 0, 0, width, height

    target = _parse_aspect(aspect)
    source = width / max(1, height)
    scale = max(0.05, min(1.0, float(transform.get("crop_scale", 1.0))))
    pos_x = max(0.0, min(1.0, float(transform.get("crop_x", 0.5))))
    pos_y = max(0.0, min(1.0, float(transform.get("crop_y", 0.5))))

    if source >= target:
        base_h = height
        base_w = min(width, round(height * target))
    else:
        base_w = width
        base_h = min(height, round(width / target))

    crop_w = max(1, round(base_w * scale))
    crop_h = max(1, round(crop_w / target))
    if crop_h > height:
        crop_h = max(1, round(base_h * scale))
        crop_w = max(1, round(crop_h * target))

    crop_w = min(width, crop_w)
    crop_h = min(height, crop_h)
    left = round((width - crop_w) * pos_x)
    top = round((height - crop_h) * pos_y)
    return left, top, left + crop_w, top + crop_h
