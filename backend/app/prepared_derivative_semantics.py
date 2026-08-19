"""Keep prepared derivative geometry strict across every supported aspect ratio."""
from __future__ import annotations

from . import image_prep as image_prep
from . import prepared_derivatives as prepared_derivatives
from .face_crop_geometry import exact_aspect_box, face_crop_box

# Both the legacy ImagePrepStore helpers and the prepared-derivative service look
# these names up at call time.  Point them at the shared validated geometry so a
# 9:16/16:9/4:5/etc. proposal cannot materialize with a different ratio or outside
# the prepared source image.
image_prep._exact_aspect_box = exact_aspect_box
image_prep._face_crop_box = face_crop_box
prepared_derivatives._exact_aspect_box = exact_aspect_box
prepared_derivatives._face_crop_box = face_crop_box
