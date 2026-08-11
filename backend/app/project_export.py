from __future__ import annotations

import os
import tarfile
import threading
from collections.abc import Iterator
from pathlib import Path


def _portable_member(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
    # Project archives should contain project-owned files only. Never follow or
    # preserve a symlink that could point at a model/cache outside the project.
    if info.issym() or info.islnk():
        return None
    return info


def stream_project_archive(project_dir: Path, project_id: str) -> Iterator[bytes]:
    """Produce a gzip tar stream with pipe backpressure and no temporary archive."""
    read_fd, write_fd = os.pipe()
    errors: list[BaseException] = []

    def produce() -> None:
        try:
            with os.fdopen(write_fd, "wb", buffering=0) as output:
                with tarfile.open(fileobj=output, mode="w|gz", dereference=False) as tf:
                    tf.add(project_dir, arcname=project_id, recursive=True, filter=_portable_member)
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
        name=f"project-export-{project_id}",
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
