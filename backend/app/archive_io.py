from __future__ import annotations

import json
import os
import re
import shutil
import stat
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".jxl"}
_ARCHIVE_FILE_LIMIT = int(os.environ.get("FIZGIG_MAX_ARCHIVE_FILES", "200000"))
_ARCHIVE_BYTE_LIMIT = int(os.environ.get("FIZGIG_MAX_ARCHIVE_BYTES", str(100 * 1024**3)))
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def sources_root() -> Path:
    root = Path(os.environ.get("FIZGIG_SOURCES_ROOT", "/workspace/sources")).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_source_destination(destination: str) -> Path:
    root = sources_root()
    raw = Path(destination.strip() or ".").expanduser()
    target = (raw if raw.is_absolute() else root / raw).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"Archive destination must be inside {root}")
    return target


def _safe_member_parts(name: str) -> tuple[str, ...]:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or any(part in {"..", ""} for part in path.parts):
        raise ValueError(f"Unsafe archive path: {name}")
    if path.parts and ":" in path.parts[0]:
        raise ValueError(f"Unsafe archive path: {name}")
    return tuple(part for part in path.parts if part not in {"."})


def _check_limits(file_count: int, byte_count: int) -> None:
    if file_count > _ARCHIVE_FILE_LIMIT:
        raise ValueError(f"Archive contains too many files (limit {_ARCHIVE_FILE_LIMIT})")
    if byte_count > _ARCHIVE_BYTE_LIMIT:
        raise ValueError(
            f"Archive expands beyond the configured limit ({_ARCHIVE_BYTE_LIMIT / 1024**3:.0f} GiB)"
        )


def _extract_zip(archive: Path, destination: Path) -> int:
    count = 0
    total = 0
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            parts = _safe_member_parts(info.filename)
            if not parts:
                continue
            unix_mode = (info.external_attr >> 16) & 0xFFFF
            if unix_mode and stat.S_ISLNK(unix_mode):
                raise ValueError(f"Archive contains a symbolic link: {info.filename}")
            target = destination.joinpath(*parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            count += 1
            total += int(info.file_size)
            _check_limits(count, total)
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info, "r") as source, target.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
    return count


def _extract_tar(archive: Path, destination: Path) -> int:
    count = 0
    total = 0
    with tarfile.open(archive, mode="r:*") as tf:
        for member in tf:
            parts = _safe_member_parts(member.name)
            if not parts:
                continue
            if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                raise ValueError(f"Archive contains an unsupported link/device entry: {member.name}")
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise ValueError(f"Archive contains an unsupported entry: {member.name}")
            count += 1
            total += int(member.size)
            _check_limits(count, total)
            source = tf.extractfile(member)
            if source is None:
                raise ValueError(f"Unable to read archive member: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
    return count


def _archive_kind(filename: str) -> str:
    name = filename.lower()
    if name.endswith(".zip"):
        return "zip"
    if name.endswith(".tar") or name.endswith(".tar.gz") or name.endswith(".tgz"):
        return "tar"
    raise ValueError("Supported archives are .zip, .tar, .tar.gz, and .tgz")


def _write_upload(source: BinaryIO, target: Path) -> None:
    source.seek(0)
    with target.open("wb") as output:
        shutil.copyfileobj(source, output, length=1024 * 1024)


def _extract_archive(source: BinaryIO, filename: str, staging_root: Path) -> tuple[Path, int]:
    kind = _archive_kind(filename)
    work = Path(tempfile.mkdtemp(prefix=".fizgig-incoming-", dir=str(staging_root)))
    archive_path = work / ("upload.zip" if kind == "zip" else "upload.tar")
    extracted = work / "extracted"
    extracted.mkdir()
    try:
        _write_upload(source, archive_path)
        count = _extract_zip(archive_path, extracted) if kind == "zip" else _extract_tar(archive_path, extracted)
        if count == 0:
            raise ValueError("Archive contains no files")
        return work, count
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise


def _payload_root(extracted: Path) -> Path:
    """Strip one wrapper directory when the archive has exactly one top-level folder."""
    children = list(extracted.iterdir())
    if len(children) == 1 and children[0].is_dir():
        return children[0]
    return extracted


def import_source_archive(source: BinaryIO, filename: str, destination: str) -> dict[str, Any]:
    target = resolve_source_destination(destination)
    if target.exists() and any(target.iterdir()):
        raise FileExistsError(f"Source destination is not empty: {target}")

    root = sources_root()
    work, file_count = _extract_archive(source, filename, root)
    try:
        payload = _payload_root(work / "extracted")
        target.mkdir(parents=True, exist_ok=True)
        for item in list(payload.iterdir()):
            shutil.move(str(item), str(target / item.name))
    except Exception:
        if target.exists() and not any(target.iterdir()):
            target.rmdir()
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)

    images = [p for p in target.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS]
    captions = [p for p in target.rglob("*.txt") if p.is_file()]
    return {
        "path": str(target),
        "archive_name": filename,
        "file_count": file_count,
        "image_count": len(images),
        "caption_count": len(captions),
    }


def create_project_archive(project_dir: Path, project_id: str) -> Path:
    exports = project_dir.parent / ".exports"
    exports.mkdir(parents=True, exist_ok=True)
    fd, raw_path = tempfile.mkstemp(prefix=f"fizgig-project-{project_id}-", suffix=".tar.gz", dir=str(exports))
    os.close(fd)
    archive = Path(raw_path)
    try:
        with tarfile.open(archive, mode="w:gz", dereference=True) as tf:
            tf.add(project_dir, arcname=project_id, recursive=True)
        return archive
    except Exception:
        archive.unlink(missing_ok=True)
        raise


def _read_project_meta(project_dir: Path) -> dict[str, Any]:
    path = project_dir / "project.json"
    if not path.is_file():
        raise ValueError("Project archive does not contain project.json")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError("Project archive contains invalid project.json") from exc
    if not isinstance(value, dict):
        raise ValueError("Project archive project.json must contain an object")
    project_id = value.get("id")
    if not isinstance(project_id, str) or not _PROJECT_ID_RE.fullmatch(project_id):
        raise ValueError("Project archive has an invalid project ID")
    return value


def _old_project_root(meta: dict[str, Any]) -> str | None:
    for item in meta.get("imports", []):
        path = item.get("path") if isinstance(item, dict) else None
        if isinstance(path, str) and "/imports/" in path:
            return path.split("/imports/", 1)[0]
    for item in meta.get("dataset_revisions", []):
        path = item.get("path") if isinstance(item, dict) else None
        if isinstance(path, str) and "/datasets/" in path:
            return path.split("/datasets/", 1)[0]
    return None


def _rebase_value(value: Any, old_root: str, new_root: str) -> Any:
    if isinstance(value, str):
        if value == old_root:
            return new_root
        prefix = old_root.rstrip("/") + "/"
        if value.startswith(prefix):
            return new_root.rstrip("/") + "/" + value[len(prefix):]
        return value
    if isinstance(value, list):
        return [_rebase_value(item, old_root, new_root) for item in value]
    if isinstance(value, dict):
        return {key: _rebase_value(item, old_root, new_root) for key, item in value.items()}
    return value


def _rebase_project_json(project_dir: Path, old_root: str | None) -> None:
    if not old_root:
        return
    new_root = str(project_dir.resolve())
    if old_root.rstrip("/") == new_root.rstrip("/"):
        return
    for path in project_dir.rglob("*.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        path.write_text(
            json.dumps(_rebase_value(value, old_root, new_root), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    for path in project_dir.rglob("*.jsonl"):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
            values = [json.loads(line) for line in lines if line.strip()]
        except (OSError, json.JSONDecodeError):
            continue
        path.write_text(
            "".join(
                json.dumps(_rebase_value(value, old_root, new_root), ensure_ascii=False) + "\n"
                for value in values
            ),
            encoding="utf-8",
        )


def import_project_archive(source: BinaryIO, filename: str, projects_root: Path) -> dict[str, Any]:
    projects_root = projects_root.resolve()
    projects_root.mkdir(parents=True, exist_ok=True)
    work, _ = _extract_archive(source, filename, projects_root)
    try:
        extracted = work / "extracted"
        direct = extracted if (extracted / "project.json").is_file() else None
        candidates = [p for p in extracted.iterdir() if p.is_dir() and (p / "project.json").is_file()]
        payload = direct or (candidates[0] if len(candidates) == 1 else None)
        if payload is None:
            raise ValueError("Project archive must contain exactly one Fizgig project")
        meta = _read_project_meta(payload)
        project_id = str(meta["id"])
        destination = (projects_root / project_id).resolve()
        if destination.parent != projects_root:
            raise ValueError("Project archive has an unsafe project ID")
        if destination.exists():
            raise FileExistsError(f"Project already exists: {project_id}")
        old_root = _old_project_root(meta)
        shutil.move(str(payload), str(destination))
        _rebase_project_json(destination, old_root)
        return json.loads((destination / "project.json").read_text(encoding="utf-8"))
    finally:
        shutil.rmtree(work, ignore_errors=True)
