from __future__ import annotations

import json
import os
from typing import Any

_DEFAULT = {
    "training_policy": "automatic",
    "auto_recaption_policy": "automatic",
}


def _aliases(value: str) -> set[str]:
    text = str(value or "")
    base = os.path.basename(text)
    stem = os.path.splitext(base)[0]
    return {item for item in (text, base, stem) if item}


def load_asset_policy(dataset_dir: str | None) -> dict[str, dict[str, Any]]:
    """Load the immutable fizgig-web policy sidecar next to the trainer dataset.

    Standalone Fizgig has no such file and therefore gets an empty lookup: every
    asset remains fully automatic, exactly matching upstream behavior.
    """
    if not dataset_dir:
        return {}
    path = os.path.join(str(dataset_dir), "fizgig_asset_policy.json")
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except Exception:
        return {}
    assets = raw.get("assets") if isinstance(raw, dict) else None
    if not isinstance(assets, dict):
        return {}

    lookup: dict[str, dict[str, Any]] = {}
    for filename, value in assets.items():
        entry = dict(_DEFAULT)
        if isinstance(value, dict):
            if value.get("training_policy") in {"automatic", "always_train"}:
                entry["training_policy"] = value["training_policy"]
            if value.get("auto_recaption_policy") in {"automatic", "hold", "never"}:
                entry["auto_recaption_policy"] = value["auto_recaption_policy"]
            if value.get("project_filename"):
                entry["project_filename"] = str(value["project_filename"])
        for alias in _aliases(str(filename)):
            lookup[alias] = entry
    return lookup


def policy_for(lookup: dict[str, dict[str, Any]] | None, item_key: Any) -> dict[str, Any]:
    if not lookup:
        return dict(_DEFAULT)
    for alias in _aliases(str(item_key or "")):
        value = lookup.get(alias)
        if isinstance(value, dict):
            return {**_DEFAULT, **value}
    return dict(_DEFAULT)
