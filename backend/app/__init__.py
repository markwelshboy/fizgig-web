"""Fizgig Web backend."""

# Keep Image Prep policy semantics consistent while the POC is being iterated.
# These imports patch the core modules at package import time so all API paths use
# the same source/derivative semantics and validated crop geometry.
from . import image_prep_semantics as _image_prep_semantics  # noqa: F401,E402
from . import prepared_derivative_semantics as _prepared_derivative_semantics  # noqa: F401,E402
