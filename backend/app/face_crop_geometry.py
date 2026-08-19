from __future__ import annotations

import math
from typing import Iterable


def _aspect_units(value: str) -> tuple[int, int]:
    try:
        left, right = str(value).split(":", 1)
        width, height = int(left), int(right)
        if width <= 0 or height <= 0:
            raise ValueError
    except Exception as exc:
        raise ValueError(f"Invalid aspect ratio: {value}") from exc
    divisor = math.gcd(width, height)
    return width // divisor, height // divisor


def clip_bbox(image_size: tuple[int, int], bbox: Iterable[int | float]) -> tuple[int, int, int, int]:
    """Clip a detector box to real image pixels before deriving an aspect crop."""
    image_width, image_height = image_size
    values = list(bbox)
    if len(values) != 4:
        raise ValueError("Face bounding box must contain four coordinates")
    x1, y1, x2, y2 = (int(round(float(value))) for value in values)
    x1 = max(0, min(image_width - 1, x1))
    y1 = max(0, min(image_height - 1, y1))
    x2 = max(x1 + 1, min(image_width, x2))
    y2 = max(y1 + 1, min(image_height, y2))
    return x1, y1, x2, y2


def exact_aspect_box(
    image_size: tuple[int, int],
    center: tuple[float, float],
    required_size: tuple[float, float],
    aspect_ratio: str,
) -> tuple[int, int, int, int]:
    """Return an exact integer-ratio crop, fully bounded by the image.

    Width/height are integer multiples of the reduced aspect units. The crop is
    the smallest ratio-correct box that can contain ``required_size`` unless the
    source boundary forces the largest available crop for that aspect.
    """
    image_width, image_height = image_size
    if image_width <= 0 or image_height <= 0:
        raise ValueError("Image dimensions must be positive")

    unit_width, unit_height = _aspect_units(aspect_ratio)
    max_multiple = min(image_width // unit_width, image_height // unit_height)
    if max_multiple < 1:
        raise ValueError(f"Image {image_width}x{image_height} is too small for aspect {aspect_ratio}")

    required_width = max(1.0, float(required_size[0]))
    required_height = max(1.0, float(required_size[1]))
    needed_multiple = max(
        1,
        math.ceil(required_width / unit_width),
        math.ceil(required_height / unit_height),
    )
    multiple = min(needed_multiple, max_multiple)
    crop_width = unit_width * multiple
    crop_height = unit_height * multiple

    center_x = max(0.0, min(float(image_width), float(center[0])))
    center_y = max(0.0, min(float(image_height), float(center[1])))
    left = int(round(center_x - crop_width / 2.0))
    top = int(round(center_y - crop_height / 2.0))
    left = max(0, min(image_width - crop_width, left))
    top = max(0, min(image_height - crop_height, top))
    box = (left, top, left + crop_width, top + crop_height)
    validate_exact_aspect_box(image_size, box, aspect_ratio)
    return box


def validate_exact_aspect_box(
    image_size: tuple[int, int],
    box: tuple[int, int, int, int],
    aspect_ratio: str,
) -> None:
    image_width, image_height = image_size
    x1, y1, x2, y2 = box
    if not (0 <= x1 < x2 <= image_width and 0 <= y1 < y2 <= image_height):
        raise ValueError(f"Crop {box} falls outside image {image_width}x{image_height}")
    unit_width, unit_height = _aspect_units(aspect_ratio)
    crop_width, crop_height = x2 - x1, y2 - y1
    if crop_width * unit_height != crop_height * unit_width:
        raise ValueError(
            f"Crop {crop_width}x{crop_height} does not exactly match requested aspect {aspect_ratio}"
        )


def face_crop_box(
    image_size: tuple[int, int],
    bbox: tuple[int, int, int, int],
    padding_percent: float,
    aspect_ratio: str,
) -> tuple[int, int, int, int]:
    """Build a bounded, exact-aspect face crop from a detector box.

    Detector boxes are clipped before padding. This matters near image edges and
    keeps portrait aspects such as 9:16 from being sized from negative/out-of-frame
    detector coordinates. Extremely large faces may force the largest crop that can
    fit the requested aspect; the proposal remains valid and visually reviewable.
    """
    x1, y1, x2, y2 = clip_bbox(image_size, bbox)
    face_width = x2 - x1
    face_height = y2 - y1
    padding = max(0.0, float(padding_percent)) / 100.0
    required_width = face_width * (1.0 + 2.0 * padding)
    required_height = face_height * (1.0 + 2.0 * padding)

    return exact_aspect_box(
        image_size,
        ((x1 + x2) / 2.0, (y1 + y2) / 2.0),
        (required_width, required_height),
        aspect_ratio,
    )
