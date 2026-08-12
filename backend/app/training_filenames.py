from __future__ import annotations

import copy
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .projects import project_store

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


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")
        handle.flush()


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


class TrainingFilenameStore:
    def _load(self, project_id: str, revision_id: str) -> tuple[Path, dict[str, Any]]:
        project_dir = project_store.project_dir(project_id)
        manifest_path = (project_dir / "datasets" / revision_id / "manifest.json").resolve()
        if project_dir not in manifest_path.parents or not manifest_path.is_file():
            raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")
        return manifest_path, json.loads(manifest_path.read_text(encoding="utf-8"))

    def get(self, project_id: str, revision_id: str) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id)
        policy, rows, changed = sync_policy(manifest)
        if changed:
            _write_json(manifest_path, manifest)
        return {"policy": policy, "rows": rows}

    def preview(
        self,
        project_id: str,
        revision_id: str,
        *,
        mode: str,
        basename: str,
        digits: int,
        scheme: str,
    ) -> dict[str, Any]:
        _, manifest = self._load(project_id, revision_id)
        return preview_policy(manifest, mode=mode, basename=basename, digits=digits, scheme=scheme)

    def update(
        self,
        project_id: str,
        revision_id: str,
        *,
        mode: str,
        basename: str,
        digits: int,
        scheme: str,
        rebuild: bool,
    ) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id)
        policy, rows, changed = apply_policy(
            manifest,
            mode=mode,
            basename=basename,
            digits=digits,
            scheme=scheme,
            rebuild=rebuild,
        )
        _write_json(manifest_path, manifest)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {
            "time": _now(),
            "type": "training_filename_policy_changed",
            "revision": revision_id,
            "mode": policy["mode"],
            "basename": policy["basename"],
            "digits": policy["digits"],
            "scheme": policy["scheme"],
            "rebuild": bool(rebuild),
            "assignment_count": len(policy.get("assignments", {})),
            "changed": changed,
        })
        return {"policy": policy, "rows": rows}

    def materialize_run(self, project_id: str, revision_id: str, run: dict[str, Any]) -> dict[str, Any]:
        """Apply the revision's user-facing names only to the run-local trainer copy.

        Project filenames, immutable source snapshots, caption history and derivative
        lineage remain untouched. The run snapshot records both names.
        """
        state = self.get(project_id, revision_id)
        policy = state["policy"]
        rows = state["rows"]
        row_by_id = {str(row.get("asset_id")): row for row in rows if row.get("asset_id")}
        row_by_project = {str(row.get("project_filename")): row for row in rows}

        run_dir = Path(run["output_dir"]).resolve()
        trainer_dir = Path(run["dataset_path"]).resolve()
        snapshot_path = run_dir / "dataset_snapshot.json"
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        assets = snapshot.get("assets", [])

        mappings: list[tuple[dict[str, Any], Path, str, str]] = []
        targets: set[str] = set()
        for asset in assets:
            project_filename = str(asset.get("filename", ""))
            row = row_by_id.get(str(asset.get("asset_id"))) or row_by_project.get(project_filename)
            target = str(row.get("training_filename")) if row else project_filename
            if target in targets:
                raise ValueError(f"Training filename collision: {target}")
            targets.add(target)
            source = (trainer_dir / project_filename).resolve()
            if source.parent != trainer_dir or not source.is_file():
                raise FileNotFoundError(f"Materialized training image is missing: {project_filename}")
            mappings.append((asset, source, project_filename, target))

        if policy.get("mode") == "normalized":
            from PIL import Image

            staged: list[tuple[dict[str, Any], Path, Path, str, str, str]] = []
            for asset, source, project_filename, target in mappings:
                temp_image = trainer_dir / f".fizgig-rename-{uuid.uuid4().hex}.png"
                with Image.open(source) as opened:
                    opened.convert("RGB").save(temp_image, format="PNG")
                caption_path = source.with_suffix(".txt")
                caption = caption_path.read_text(encoding="utf-8") if caption_path.is_file() else ""
                staged.append((asset, source, temp_image, caption, project_filename, target))

            # Remove the old run-local names only after every replacement has been
            # staged, so a target can never clobber another source filename.
            for _, source, _, _, _, _ in staged:
                source.unlink(missing_ok=True)
                source.with_suffix(".txt").unlink(missing_ok=True)

            for asset, _, temp_image, caption, project_filename, target in staged:
                target_path = trainer_dir / target
                temp_image.replace(target_path)
                target_path.with_suffix(".txt").write_text(caption, encoding="utf-8")
                asset["project_filename"] = project_filename
                asset["training_filename"] = target
                asset["filename"] = target
        else:
            for asset, _, project_filename, target in mappings:
                asset["project_filename"] = project_filename
                asset["training_filename"] = target

        snapshot["training_filenames"] = policy
        _write_json(snapshot_path, snapshot)

        run.setdefault("config", {})["training_filenames"] = policy
        _write_json(run_dir / "run.json", run)

        # Keep the trainer intervention sidecar aligned with the names the trainer
        # will actually see, while retaining the project filename in each record.
        for policy_path in (run_dir / "run_policy.json", trainer_dir / "fizgig_asset_policy.json"):
            if not policy_path.is_file():
                continue
            value = json.loads(policy_path.read_text(encoding="utf-8"))
            old_assets = value.get("assets", {})
            renamed_assets: dict[str, Any] = {}
            for _, _, project_filename, target in mappings:
                entry = dict(old_assets.get(project_filename, {}))
                entry["project_filename"] = project_filename
                renamed_assets[target] = entry
            value["assets"] = renamed_assets
            value["training_filenames"] = policy
            _write_json(policy_path, value)

        event = {
            "time": _now(),
            "type": "training_filenames_materialized",
            "revision": revision_id,
            "mode": policy.get("mode"),
            "scheme": policy.get("scheme"),
            "image_count": len(mappings),
        }
        _append_jsonl(run_dir / "events.jsonl", event)
        _append_jsonl(project_store.project_dir(project_id) / "events.jsonl", {**event, "run_id": run["id"]})
        return run


training_filename_store = TrainingFilenameStore()
