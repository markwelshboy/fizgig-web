from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from .captioning import caption_service, download_qwen_snapshot
from .settings import save_settings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ModelDownloadManager:
    """Small process-local job manager for long-running model downloads.

    Model files themselves live in /workspace and survive a process restart when
    that workspace is persistent. Job state is intentionally ephemeral: it only
    describes work being performed by this API process.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}

    def start_qwen(
        self,
        *,
        repo_id: str,
        revision: str = "",
        model_dir: str = "",
        select_when_complete: bool = True,
    ) -> dict[str, Any]:
        repo_id = repo_id.strip()
        if not repo_id:
            raise ValueError("Hugging Face repository ID is required")

        with self._lock:
            active = next(
                (job for job in self._jobs.values() if job["status"] in {"queued", "running"}),
                None,
            )
            if active is not None:
                raise RuntimeError(
                    f"A model download is already in progress: {active['repo_id']} ({active['id']})"
                )

            job_id = uuid.uuid4().hex[:16]
            job: dict[str, Any] = {
                "id": job_id,
                "kind": "qwen_caption_model",
                "repo_id": repo_id,
                "revision": revision.strip(),
                "model_dir": model_dir.strip(),
                "select_when_complete": bool(select_when_complete),
                "status": "queued",
                "phase": "queued",
                "created_at": _now(),
                "started_at": None,
                "finished_at": None,
                "path": None,
                "selected": False,
                "error": None,
            }
            self._jobs[job_id] = job

        thread = threading.Thread(
            target=self._run_qwen,
            args=(job_id,),
            daemon=True,
            name=f"qwen-download-{job_id}",
        )
        thread.start()
        return self.get(job_id)

    def get(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            return dict(job)

    def _patch(self, job_id: str, **values: Any) -> None:
        with self._lock:
            self._jobs[job_id].update(values)

    def _run_qwen(self, job_id: str) -> None:
        job = self.get(job_id)
        self._patch(job_id, status="running", phase="downloading", started_at=_now())
        try:
            path = download_qwen_snapshot(
                job["repo_id"],
                revision=job["revision"],
                model_dir=job["model_dir"],
            )
            selected = False
            if job["select_when_complete"]:
                self._patch(job_id, phase="selecting")
                save_settings({
                    "qwen_caption_model": path,
                    "qwen_caption_processor": "",
                    "qwen_caption_revision": "",
                    **({"caption_model_dir": job["model_dir"]} if job["model_dir"] else {}),
                })
                caption_service.unload()
                selected = True
            self._patch(
                job_id,
                status="complete",
                phase="complete",
                finished_at=_now(),
                path=path,
                selected=selected,
            )
        except Exception as exc:
            self._patch(
                job_id,
                status="failed",
                phase="failed",
                finished_at=_now(),
                error=f"{type(exc).__name__}: {exc}",
            )


model_download_manager = ModelDownloadManager()
