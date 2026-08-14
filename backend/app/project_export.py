from __future__ import annotations

import io
import json
import os
import re
import tarfile
import threading
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Literal

ArchiveMode = Literal["portable", "workspace"]
_NUMBERED_CHECKPOINT_RE = re.compile(r"^.+-\d{6}\.safetensors$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _portable_member(info: tarfile.TarInfo, *, project_id: str, mode: ArchiveMode) -> tarfile.TarInfo | None:
    # Never follow or preserve a symlink that could point at a model/cache outside
    # the project. This applies to both archive modes.
    if info.issym() or info.islnk():
        return None

    parts = PurePosixPath(info.name).parts
    if parts and parts[-1] == "archive_manifest.json":
        # An imported archive may already contain an older export manifest. The
        # current export writes a fresh one after walking the project tree.
        return None

    if mode == "workspace":
        return info

    # A portable/full project archive is the complete experimental record, not a
    # byte-for-byte copy of regenerable training scratch. Keep the frozen run
    # dataset, config, telemetry, logs, samples, final LoRA and provenance, while
    # dropping the heavyweight pieces that can be rebuilt or are only needed for
    # an exact in-place resume.
    try:
        runs_index = parts.index("runs")
    except ValueError:
        return info

    # <project>/runs/<run-id>/<run-relative-path...>
    run_relative = parts[runs_index + 2 :]
    if not run_relative:
        return info

    first = run_relative[0]
    if first in {"cache", "state"}:
        return None
    if first.endswith("-state"):
        return None

    # Fizgig writes intermediate epoch LoRAs directly in the run root as
    # <output-name>-000002.safetensors, etc. The unnumbered final LoRA remains.
    if len(run_relative) == 1 and _NUMBERED_CHECKPOINT_RE.fullmatch(first):
        return None

    return info


def _archive_manifest(project_id: str, mode: ArchiveMode) -> bytes:
    if mode == "workspace":
        semantics = {
            "description": "Literal project workspace snapshot.",
            "excludes": ["symbolic links"],
            "includes": [
                "run caches",
                "intermediate epoch checkpoints",
                "optimizer/resume state",
                "all project-owned run artifacts",
            ],
        }
    else:
        semantics = {
            "description": "Portable full project archive for experiment provenance and reproduction from epoch zero.",
            "excludes": [
                "symbolic links",
                "run cache directories",
                "optimizer/resume state directories",
                "numbered intermediate epoch LoRA checkpoints",
            ],
            "includes": [
                "project/import and dataset revisions",
                "frozen run datasets",
                "captions, transforms and project policy",
                "run configuration and model/software provenance",
                "telemetry, decisions and console logs",
                "samples and explicitly retained artifacts",
                "unnumbered final LoRA outputs",
            ],
        }
    value = {
        "schema_version": 1,
        "archive_type": mode,
        "created_at": _now(),
        "project_id": project_id,
        **semantics,
    }
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def stream_project_archive(project_dir: Path, project_id: str, *, mode: ArchiveMode = "portable") -> Iterator[bytes]:
    """Produce a gzip tar stream with pipe backpressure and no temporary archive.

    ``portable`` is the normal project export: it keeps the complete experiment
    record while omitting regenerable caches, intermediate epoch LoRAs and resume
    state. ``workspace`` preserves every project-owned byte and may be very large.
    """
    if mode not in {"portable", "workspace"}:
        raise ValueError(f"Unsupported project archive mode: {mode}")

    read_fd, write_fd = os.pipe()
    errors: list[BaseException] = []

    def produce() -> None:
        try:
            with os.fdopen(write_fd, "wb", buffering=0) as output:
                with tarfile.open(fileobj=output, mode="w|gz", dereference=False) as tf:
                    tf.add(
                        project_dir,
                        arcname=project_id,
                        recursive=True,
                        filter=lambda info: _portable_member(info, project_id=project_id, mode=mode),
                    )

                    manifest = _archive_manifest(project_id, mode)
                    info = tarfile.TarInfo(name=f"{project_id}/archive_manifest.json")
                    info.size = len(manifest)
                    info.mtime = int(datetime.now(timezone.utc).timestamp())
                    info.mode = 0o644
                    tf.addfile(info, io.BytesIO(manifest))
        except BrokenPipeError:
            # Normal when the browser cancels a download.
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
        name=f"project-export-{project_id}-{mode}",
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
