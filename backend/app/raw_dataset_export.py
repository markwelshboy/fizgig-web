from __future__ import annotations

import io
import json
import os
import tarfile
import tempfile
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from . import image_prep as image_prep_module
from .projects import project_store
from .training_filenames import training_filename_store


class RawDatasetExport:
    def __init__(
        self,
        *,
        project_id: str,
        revision_id: str,
        manifest: dict[str, Any],
        source_dir: Path,
        assets: list[tuple[dict[str, Any], Path, str]],
    ) -> None:
        self.project_id = project_id
        self.revision_id = revision_id
        self.manifest = manifest
        self.source_dir = source_dir
        self.assets = assets


def _safe_archive_name(name: str) -> str:
    value = str(name or "").strip()
    candidate = Path(value)
    if not value or candidate.name != value or value in {".", ".."}:
        raise ValueError(f"Unsafe dataset export filename: {value!r}")
    return value


def prepare_raw_dataset_export(project_id: str, revision_id: str) -> RawDatasetExport:
    project_dir = project_store.project_dir(project_id)
    manifest_path = (project_dir / "datasets" / revision_id / "manifest.json").resolve()
    if project_dir not in manifest_path.parents or not manifest_path.is_file():
        raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")

    # Sync the active filename policy first so newly-added derivatives have any
    # required stable normalized assignments before we construct the archive.
    filename_state = training_filename_store.get(project_id, revision_id)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    rows = filename_state.get("rows", [])
    row_by_id = {str(row.get("asset_id")): row for row in rows if row.get("asset_id")}
    row_by_project = {str(row.get("project_filename")): row for row in rows}

    source_dir = Path(manifest["files_path"]).resolve()
    if project_dir not in source_dir.parents or not source_dir.is_dir():
        raise ValueError("Dataset revision files path is outside the project archive boundary")

    prepared: list[tuple[dict[str, Any], Path, str]] = []
    archive_names: set[str] = set()

    for asset in manifest.get("assets", []):
        if not asset.get("included", True):
            continue
        project_filename = str(asset.get("filename", ""))
        source = (source_dir / project_filename).resolve()
        if not project_filename or source.parent != source_dir or not source.is_file():
            raise FileNotFoundError(f"Included dataset image is missing: {project_filename}")

        row = row_by_id.get(str(asset.get("id"))) or row_by_project.get(project_filename)
        export_filename = _safe_archive_name(str(row.get("training_filename")) if row else project_filename)
        caption_filename = _safe_archive_name(str(Path(export_filename).with_suffix(".txt")))
        for name in (export_filename, caption_filename):
            if name in archive_names:
                raise ValueError(f"Dataset export filename collision: {name}")
            archive_names.add(name)
        prepared.append((asset, source, export_filename))

    if not prepared:
        raise ValueError("Working dataset contains no included images")

    return RawDatasetExport(
        project_id=project_id,
        revision_id=revision_id,
        manifest=manifest,
        source_dir=source_dir,
        assets=prepared,
    )


def stream_raw_dataset_archive(export: RawDatasetExport) -> Iterator[bytes]:
    """Stream the effective training dataset without creating a complete archive.

    Each included image is materialized with the same effective Image Prep
    transform used for run datasets. Only one temporary image exists at a time;
    the gzip tar itself is piped directly to the HTTP response.
    """
    read_fd, write_fd = os.pipe()
    errors: list[BaseException] = []

    def produce() -> None:
        try:
            with tempfile.TemporaryDirectory(prefix="fizgig-dataset-export-") as temp_root:
                temp_dir = Path(temp_root)
                with os.fdopen(write_fd, "wb", buffering=0) as output:
                    with tarfile.open(fileobj=output, mode="w|gz") as tf:
                        for asset, source, export_filename in export.assets:
                            target = temp_dir / export_filename
                            transform = image_prep_module._effective_transform(export.manifest, asset)
                            image_prep_module._materialize_transform(source, target, transform)
                            tf.add(target, arcname=export_filename, recursive=False)
                            target.unlink(missing_ok=True)

                            caption = str(asset.get("caption", "")).strip()
                            caption_bytes = (caption + ("\n" if caption else "")).encode("utf-8")
                            caption_name = str(Path(export_filename).with_suffix(".txt"))
                            info = tarfile.TarInfo(name=caption_name)
                            info.size = len(caption_bytes)
                            info.mode = 0o644
                            tf.addfile(info, io.BytesIO(caption_bytes))
        except BrokenPipeError:
            # Normal if the browser cancels the download.
            pass
        except BaseException as exc:
            errors.append(exc)
            try:
                os.close(write_fd)
            except OSError:
                pass

    producer = threading.Thread(
        target=produce,
        daemon=True,
        name=f"dataset-export-{export.project_id}-{export.revision_id}",
    )
    producer.start()

    try:
        with os.fdopen(read_fd, "rb", buffering=0) as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk
    finally:
        try:
            os.close(read_fd)
        except OSError:
            pass
        producer.join(timeout=2)

    if errors:
        raise errors[0]
