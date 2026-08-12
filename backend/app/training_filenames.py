from __future__ import annotations

import copy
import re
from datetime import datetime, timezone
from typing import Any

DEFAULT_TRAINING_FILENAME_POLICY: dict[str, Any] = {
    "mode": "original",
    "basename": "",
    "digits": 4,
    "scheme": "lineage",
    "extension": "png",
    "assignments": {},
    "source_slots": {},
    "derivative_counters": {},
    "next_index": 0,
    "updated_at": None,
}

_ALLOWED_BASENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def asset_key(asset: dict[str, Any]) -> str:
    return str(asset.get("id") or asset.get("filename") or "")


def normalize_request(
    *,
    mode: str = "normalized",
    basename: str = "",
    digits: int = 4,
    scheme: str = "lineage",
) -> dict[str, Any]:
    mode = str(mode or "normalized").strip().lower()
    if mode not in {"original", "normalized"}:
        raise ValueError("Filename mode must be 'original' or 'normalized'")

    scheme = str(scheme or "lineage").strip().lower()
    if scheme not in {"lineage", "sequential"}:
        raise ValueError("Filename scheme must be 'lineage' or 'sequential'")

    digits = int(digits)
    if digits < 2 or digits > 8:
        raise ValueError("Filename digit width must be between 2 and 8")

    basename = str(basename or "").strip()
    if mode == "normalized":
        if not basename:
            raise ValueError("A basename is required for normalized training filenames")
        if not _ALLOWED_BASENAME.fullmatch(basename):
            raise ValueError("Basename may contain only letters, numbers, underscore and hyphen, and must start with a letter or number")

    return {
        "mode": mode,
        "basename": basename,
        "digits": digits,
        "scheme": scheme,
        "extension": "png",
    }


def _root_asset(asset: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    current = asset
    seen: set[str] = set()
    while current.get("asset_kind") == "derived" and current.get("parent_asset_id"):
        parent_id = str(current.get("parent_asset_id"))
        if parent_id in seen or parent_id not in by_id:
            break
        seen.add(parent_id)
        current = by_id[parent_id]
    return current


def _origin_suffix(asset: dict[str, Any]) -> str:
    origin = str(asset.get("origin") or "derived").lower()
    if origin == "face":
        return "face"
    if origin == "manual":
        return "crop"
    return "deriv"


def _public_policy(policy: dict[str, Any]) -> dict[str, Any]:
    return {
        "mode": policy.get("mode", "original"),
        "basename": policy.get("basename", ""),
        "digits": int(policy.get("digits", 4)),
        "scheme": policy.get("scheme", "lineage"),
        "extension": "png",
        "assignments": dict(policy.get("assignments", {})),
        "updated_at": policy.get("updated_at"),
    }


def _rows(manifest: dict[str, Any], policy: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    assignments = policy.get("assignments", {})
    for asset in manifest.get("assets", []):
        if not asset.get("included", True):
            continue
        key = asset_key(asset)
        project_filename = str(asset.get("filename", ""))
        training_filename = project_filename if policy.get("mode") != "normalized" else str(assignments.get(key, project_filename))
        rows.append({
            "asset_id": asset.get("id"),
            "project_filename": project_filename,
            "training_filename": training_filename,
            "asset_kind": asset.get("asset_kind", "source"),
            "origin": asset.get("origin"),
            "parent_asset_id": asset.get("parent_asset_id"),
            "parent_filename": asset.get("parent_filename"),
        })
    return rows


def _policy_changed(old: dict[str, Any], new: dict[str, Any]) -> bool:
    keys = ("mode", "basename", "digits", "scheme", "extension", "assignments", "source_slots", "derivative_counters", "next_index")
    return any(old.get(key) != new.get(key) for key in keys)


def _fresh_policy(config: dict[str, Any]) -> dict[str, Any]:
    return {
        **copy.deepcopy(DEFAULT_TRAINING_FILENAME_POLICY),
        **config,
        "assignments": {},
        "source_slots": {},
        "derivative_counters": {},
        "next_index": 0,
    }


def _assign_sequential(manifest: dict[str, Any], policy: dict[str, Any], *, preserve: bool) -> None:
    assignments = policy.setdefault("assignments", {})
    basename = str(policy["basename"])
    digits = int(policy["digits"])
    next_index = int(policy.get("next_index", 0))

    if not preserve:
        assignments.clear()
        next_index = 0

    for asset in manifest.get("assets", []):
        if not asset.get("included", True):
            continue
        key = asset_key(asset)
        if not key or key in assignments:
            continue
        assignments[key] = f"{basename}_{next_index:0{digits}d}.png"
        next_index += 1

    policy["next_index"] = next_index


def _assign_lineage(manifest: dict[str, Any], policy: dict[str, Any], *, preserve: bool) -> None:
    assignments = policy.setdefault("assignments", {})
    source_slots = policy.setdefault("source_slots", {})
    derivative_counters = policy.setdefault("derivative_counters", {})
    basename = str(policy["basename"])
    digits = int(policy["digits"])
    next_index = int(policy.get("next_index", 0))

    if not preserve:
        assignments.clear()
        source_slots.clear()
        derivative_counters.clear()
        next_index = 0

    assets = list(manifest.get("assets", []))
    by_id = {str(asset.get("id")): asset for asset in assets if asset.get("id")}
    included = [asset for asset in assets if asset.get("included", True)]

    # Assign a stable source-family slot in the order each family first appears in
    # the current working set. A derivative can therefore retain recognizable
    # lineage even when its source asset itself is excluded from training.
    roots: list[dict[str, Any]] = []
    seen_roots: set[str] = set()
    for asset in included:
        root = _root_asset(asset, by_id)
        root_key = asset_key(root)
        if root_key and root_key not in seen_roots:
            seen_roots.add(root_key)
            roots.append(root)
    for root in roots:
        root_key = asset_key(root)
        if root_key not in source_slots:
            source_slots[root_key] = next_index
            next_index += 1

    for asset in included:
        key = asset_key(asset)
        if not key or key in assignments:
            continue
        root = _root_asset(asset, by_id)
        root_key = asset_key(root)
        slot = int(source_slots[root_key])
        stem = f"{basename}_{slot:0{digits}d}"

        if asset.get("asset_kind") != "derived":
            assignments[key] = f"{stem}.png"
            continue

        suffix = _origin_suffix(asset)
        counters = derivative_counters.setdefault(root_key, {})
        counter = int(counters.get(suffix, 0)) + 1
        counters[suffix] = counter
        assignments[key] = f"{stem}_{suffix}{counter:02d}.png"

    policy["next_index"] = next_index


def apply_policy(
    manifest: dict[str, Any],
    *,
    mode: str,
    basename: str,
    digits: int,
    scheme: str,
    rebuild: bool,
) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
    config = normalize_request(mode=mode, basename=basename, digits=digits, scheme=scheme)
    old = copy.deepcopy(manifest.get("training_filenames") or DEFAULT_TRAINING_FILENAME_POLICY)

    same_config = all(old.get(key) == config.get(key) for key in ("mode", "basename", "digits", "scheme", "extension"))
    preserve = same_config and not rebuild
    policy = copy.deepcopy(old) if preserve else _fresh_policy(config)
    policy.update(config)

    if policy["mode"] == "normalized":
        if policy["scheme"] == "sequential":
            _assign_sequential(manifest, policy, preserve=preserve)
        else:
            _assign_lineage(manifest, policy, preserve=preserve)
    elif not preserve:
        policy = _fresh_policy(config)

    changed = _policy_changed(old, policy)
    if changed:
        policy["updated_at"] = _now()
    elif old.get("updated_at"):
        policy["updated_at"] = old.get("updated_at")

    manifest["training_filenames"] = policy
    return _public_policy(policy), _rows(manifest, policy), changed


def sync_policy(manifest: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
    stored = manifest.get("training_filenames") or DEFAULT_TRAINING_FILENAME_POLICY
    return apply_policy(
        manifest,
        mode=str(stored.get("mode", "original")),
        basename=str(stored.get("basename", "")),
        digits=int(stored.get("digits", 4)),
        scheme=str(stored.get("scheme", "lineage")),
        rebuild=False,
    )


def preview_policy(
    manifest: dict[str, Any],
    *,
    mode: str,
    basename: str,
    digits: int,
    scheme: str,
) -> dict[str, Any]:
    clone = copy.deepcopy(manifest)
    policy, rows, _ = apply_policy(
        clone,
        mode=mode,
        basename=basename,
        digits=digits,
        scheme=scheme,
        rebuild=True,
    )
    return {"policy": policy, "rows": rows}


def training_filename_for_asset(policy: dict[str, Any], asset: dict[str, Any]) -> str:
    project_filename = str(asset.get("filename", ""))
    if policy.get("mode") != "normalized":
        return project_filename
    return str(policy.get("assignments", {}).get(asset_key(asset), project_filename))
