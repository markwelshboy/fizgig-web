from __future__ import annotations

import json
import os
import re
import shutil
import stat
import tarfile
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from .archive_io import (
    _ARCHIVE_BYTE_LIMIT,
    _ARCHIVE_FILE_LIMIT,
    _PROJECT_ID_RE,
    _archive_kind,
    _old_project_root,
    _rebase_project_json,
    _safe_member_parts,
)
from .project_export import COMPONENTS, PRESETS, component_for_relative_parts, normalize_components

_STAGE_MAX_AGE = int(os.environ.get("FIZGIG_IMPORT_STAGE_MAX_AGE", str(24 * 60 * 60)))
_STAGE_TOKEN_RE = re.compile(r"^[a-f0-9]{32}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stage_root(projects_root: Path) -> Path:
    root = projects_root / ".fizgig-import-staging"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _cleanup_stages(projects_root: Path) -> None:
    root = _stage_root(projects_root)
    cutoff = time.time() - _STAGE_MAX_AGE
    for path in root.iterdir():
        try:
            if path.is_dir() and path.stat().st_mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            continue


def _write_upload(source: BinaryIO, target: Path) -> int:
    source.seek(0)
    total = 0
    with target.open("wb") as output:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
            total += len(chunk)
    return total


def _candidate_project_json(name: str) -> bool:
    parts = PurePosixPath(name.replace("\\", "/")).parts
    return bool(parts) and parts[-1] == "project.json" and len(parts) <= 2


def _candidate_archive_manifest(name: str) -> bool:
    parts = PurePosixPath(name.replace("\\", "/")).parts
    return bool(parts) and parts[-1] == "archive_manifest.json" and len(parts) <= 2


def _json_bytes(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Archive contains invalid {label}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"Archive {label} must contain an object")
    return value


def _inspect_zip(path: Path) -> tuple[dict[str, Any], dict[str, Any] | None, tuple[str, ...], dict[str, dict[str, int]]]:
    project_meta = None
    manifest = None
    project_root: tuple[str, ...] | None = None
    entries: list[tuple[str, int, bool]] = []
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            parts = _safe_member_parts(info.filename)
            if not parts:
                continue
            unix_mode = (info.external_attr >> 16) & 0xFFFF
            if unix_mode and stat.S_ISLNK(unix_mode):
                raise ValueError(f"Archive contains a symbolic link: {info.filename}")
            entries.append((info.filename, int(info.file_size), info.is_dir()))
            if not info.is_dir() and _candidate_project_json(info.filename):
                if project_meta is not None:
                    raise ValueError("Project archive contains more than one project.json")
                project_meta = _json_bytes(zf.read(info), "project.json")
                project_root = tuple(parts[:-1])
            elif not info.is_dir() and _candidate_archive_manifest(info.filename):
                manifest = _json_bytes(zf.read(info), "archive_manifest.json")
    if project_meta is None or project_root is None:
        raise ValueError("Project archive does not contain project.json")
    return project_meta, manifest, project_root, _inventory(entries, project_root)


def _inspect_tar(path: Path) -> tuple[dict[str, Any], dict[str, Any] | None, tuple[str, ...], dict[str, dict[str, int]]]:
    project_meta = None
    manifest = None
    project_root: tuple[str, ...] | None = None
    entries: list[tuple[str, int, bool]] = []
    with tarfile.open(path, mode="r:*") as tf:
        for member in tf:
            parts = _safe_member_parts(member.name)
            if not parts:
                continue
            if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                raise ValueError(f"Archive contains an unsupported link/device entry: {member.name}")
            entries.append((member.name, int(member.size), member.isdir()))
            if member.isfile() and _candidate_project_json(member.name):
                if project_meta is not None:
                    raise ValueError("Project archive contains more than one project.json")
                source = tf.extractfile(member)
                if source is None:
                    raise ValueError("Unable to read project.json")
                project_meta = _json_bytes(source.read(), "project.json")
                project_root = tuple(parts[:-1])
            elif member.isfile() and _candidate_archive_manifest(member.name):
                source = tf.extractfile(member)
                if source is not None:
                    manifest = _json_bytes(source.read(), "archive_manifest.json")
    if project_meta is None or project_root is None:
        raise ValueError("Project archive does not contain project.json")
    return project_meta, manifest, project_root, _inventory(entries, project_root)


def _relative(parts: tuple[str, ...], project_root: tuple[str, ...]) -> tuple[str, ...] | None:
    if project_root:
        if tuple(parts[: len(project_root)]) != project_root:
            return None
        return tuple(parts[len(project_root) :])
    return parts


def _inventory(entries: list[tuple[str, int, bool]], project_root: tuple[str, ...]) -> dict[str, dict[str, int]]:
    result = {key: {"bytes": 0, "file_count": 0} for key in COMPONENTS}
    for name, size, is_dir in entries:
        parts = _safe_member_parts(name)
        relative = _relative(parts, project_root)
        if relative is None or not relative or relative[-1] == "archive_manifest.json" or is_dir:
            continue
        component = component_for_relative_parts(relative)
        result[component]["bytes"] += int(size)
        result[component]["file_count"] += 1
    return result


def _component_rows(inventory: dict[str, dict[str, int]], manifest: dict[str, Any] | None) -> list[dict[str, Any]]:
    intended: dict[str, bool] = {}
    if isinstance(manifest, dict):
        for row in manifest.get("components", []):
            if isinstance(row, dict) and isinstance(row.get("id"), str):
                intended[row["id"]] = bool(row.get("selected", True))
        for component in manifest.get("selected_components", []):
            intended[str(component)] = True
    rows = []
    for component_id, definition in COMPONENTS.items():
        counts = inventory[component_id]
        available = counts["file_count"] > 0 or bool(definition.get("required"))
        rows.append({
            "id": component_id,
            **definition,
            "bytes": counts["bytes"],
            "file_count": counts["file_count"],
            "available": available,
            "archive_selected": intended.get(component_id, available),
        })
    return rows


def stage_project_import(source: BinaryIO, filename: str, projects_root: Path) -> dict[str, Any]:
    projects_root = projects_root.resolve()
    projects_root.mkdir(parents=True, exist_ok=True)
    _cleanup_stages(projects_root)
    kind = _archive_kind(filename)
    token = uuid.uuid4().hex
    stage = _stage_root(projects_root) / token
    stage.mkdir(parents=True)
    archive_path = stage / ("archive.zip" if kind == "zip" else "archive.tar")
    try:
        upload_bytes = _write_upload(source, archive_path)
        project_meta, manifest, project_root, inventory = (
            _inspect_zip(archive_path) if kind == "zip" else _inspect_tar(archive_path)
        )
        project_id = project_meta.get("id")
        if not isinstance(project_id, str) or not _PROJECT_ID_RE.fullmatch(project_id):
            raise ValueError("Project archive has an invalid project ID")
        info = {
            "token": token,
            "filename": filename,
            "kind": kind,
            "upload_bytes": upload_bytes,
            "created_at": _now(),
            "project_root": list(project_root),
            "project": {
                "id": project_id,
                "name": str(project_meta.get("name") or project_id),
                "description": str(project_meta.get("description") or ""),
                "run_count": len(project_meta.get("runs") or []),
                "dataset_revision_count": len(project_meta.get("dataset_revisions") or []),
            },
            "collision": (projects_root / project_id).exists(),
            "archive_manifest": manifest,
            "components": _component_rows(inventory, manifest),
            "presets": [{"id": key, **value} for key, value in PRESETS.items()],
        }
        (stage / "stage.json").write_text(json.dumps(info, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return info
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def _stage_info(projects_root: Path, token: str) -> tuple[Path, dict[str, Any]]:
    if not _STAGE_TOKEN_RE.fullmatch(token):
        raise ValueError("Invalid import token")
    stage = _stage_root(projects_root) / token
    meta_path = stage / "stage.json"
    if not meta_path.is_file():
        raise FileNotFoundError("Import staging token has expired or does not exist")
    return stage, json.loads(meta_path.read_text(encoding="utf-8"))


def _selected_member(name: str, project_root: tuple[str, ...], selected: set[str]) -> bool:
    parts = _safe_member_parts(name)
    relative = _relative(parts, project_root)
    if relative is None or not relative:
        return False
    if relative[-1] in {"project.json", "archive_manifest.json"}:
        return True
    component = component_for_relative_parts(relative)
    return component in selected


def _extract_selected_zip(path: Path, destination: Path, project_root: tuple[str, ...], selected: set[str]) -> None:
    count = 0
    total = 0
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            if not _selected_member(info.filename, project_root, selected):
                continue
            parts = _safe_member_parts(info.filename)
            unix_mode = (info.external_attr >> 16) & 0xFFFF
            if unix_mode and stat.S_ISLNK(unix_mode):
                raise ValueError(f"Archive contains a symbolic link: {info.filename}")
            relative = _relative(parts, project_root)
            if relative is None or not relative:
                continue
            target = destination.joinpath(*relative)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            count += 1
            total += int(info.file_size)
            if count > _ARCHIVE_FILE_LIMIT or total > _ARCHIVE_BYTE_LIMIT:
                raise ValueError("Selected import exceeds configured archive limits")
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info, "r") as source, target.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)


def _extract_selected_tar(path: Path, destination: Path, project_root: tuple[str, ...], selected: set[str]) -> None:
    count = 0
    total = 0
    with tarfile.open(path, mode="r:*") as tf:
        for member in tf:
            if not _selected_member(member.name, project_root, selected):
                continue
            parts = _safe_member_parts(member.name)
            if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                raise ValueError(f"Archive contains an unsupported link/device entry: {member.name}")
            relative = _relative(parts, project_root)
            if relative is None or not relative:
                continue
            target = destination.joinpath(*relative)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                continue
            count += 1
            total += int(member.size)
            if count > _ARCHIVE_FILE_LIMIT or total > _ARCHIVE_BYTE_LIMIT:
                raise ValueError("Selected import exceeds configured archive limits")
            source = tf.extractfile(member)
            if source is None:
                raise ValueError(f"Unable to read archive member: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)


def finalize_project_import(
    token: str,
    projects_root: Path,
    *,
    components: set[str] | list[str],
    identity_mode: str = "preserve",
    clone_id: str | None = None,
    clone_name: str | None = None,
) -> dict[str, Any]:
    projects_root = projects_root.resolve()
    stage, info = _stage_info(projects_root, token)
    selected = normalize_components(components)
    available = {row["id"] for row in info.get("components", []) if row.get("available")}
    selected &= available | {"project_core", "datasets"}
    selected = normalize_components(selected)

    if identity_mode not in {"preserve", "clone"}:
        raise ValueError("Identity mode must be preserve or clone")

    work = stage / "selected"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    archive_path = stage / ("archive.zip" if info["kind"] == "zip" else "archive.tar")
    project_root = tuple(info.get("project_root") or [])
    destination: Path | None = None
    moved = False
    try:
        if info["kind"] == "zip":
            _extract_selected_zip(archive_path, work, project_root, selected)
        else:
            _extract_selected_tar(archive_path, work, project_root, selected)

        project_path = work / "project.json"
        if not project_path.is_file():
            raise ValueError("Selected import did not contain project.json")
        meta = json.loads(project_path.read_text(encoding="utf-8"))
        source_id = str(meta.get("id") or "")
        old_root = _old_project_root(meta)

        if identity_mode == "clone":
            new_id = (clone_id or "").strip()
            new_name = (clone_name or "").strip()
            if not new_id or not _PROJECT_ID_RE.fullmatch(new_id):
                raise ValueError("Clone project ID must contain only letters, numbers, dot, underscore or dash")
            if not new_name:
                raise ValueError("Clone project name is required")
            meta["id"] = new_id
            meta["name"] = new_name
            meta["cloned_from"] = {
                "project_id": source_id,
                "project_name": info.get("project", {}).get("name"),
                "dataset_revision": meta.get("current_dataset_revision"),
                "imported_at": _now(),
            }
            meta["created_at"] = _now()
            meta["updated_at"] = meta["created_at"]

        if "run_metadata" not in selected:
            meta["runs"] = []
            meta["current_run"] = None
        if "imports" not in selected:
            meta["imports"] = []
            meta["current_import"] = ""

        project_id = str(meta.get("id") or "")
        if not _PROJECT_ID_RE.fullmatch(project_id):
            raise ValueError("Imported project has an invalid project ID")
        destination = (projects_root / project_id).resolve()
        if destination.parent != projects_root:
            raise ValueError("Imported project ID resolves outside the projects root")
        if destination.exists():
            raise FileExistsError(f"Project already exists: {project_id}")

        project_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        import_manifest = {
            "schema_version": 1,
            "imported_at": _now(),
            "source_archive": info.get("filename"),
            "source_project_id": source_id,
            "identity_mode": identity_mode,
            "selected_components": sorted(selected),
            "archive_manifest": info.get("archive_manifest"),
        }
        (work / "import_manifest.json").write_text(
            json.dumps(import_manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

        shutil.move(str(work), str(destination))
        moved = True
        _rebase_project_json(destination, old_root)
        return json.loads((destination / "project.json").read_text(encoding="utf-8"))
    except Exception:
        if moved and destination is not None and destination.exists():
            shutil.rmtree(destination, ignore_errors=True)
        raise
    finally:
        shutil.rmtree(stage, ignore_errors=True)
