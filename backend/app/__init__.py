"""Fizgig Web backend."""

# Keep Image Prep policy semantics consistent while the POC is being iterated.
# This imports the core module and patches only its source/derivative crop policy.
from . import image_prep_semantics as _image_prep_semantics  # noqa: F401,E402
