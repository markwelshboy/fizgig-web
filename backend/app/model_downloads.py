from __future__ import annotations

import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .captioning import caption_service, download_qwen_snapshot
from .settings import load_settings, save_settings, settings_dict


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Core means the trainer can load and train. Support assets are used by previews/workbenches.
_TRAINING_FAMILIES: dict[str, dict[str, Any]] = {
    "krea2": {
        "name": "Krea 2",
        "core": ("krea2_raw_dit", "krea2_text_encoder", "krea2_vae"),
        "support": ("krea2_turbo_lora", "krea2_turbo_dit"),
        "assets": {
            "krea2_raw_dit": ("RAW DiT", "Comfy-Org/Krea-2", "diffusion_models/krea2_raw_bf16.safetensors", 26.0),
            "krea2_text_encoder": ("Qwen3-VL training text encoder", "Comfy-Org/Krea-2", "text_encoders/qwen3vl_4b_fp8_scaled.safetensors", 5.2),
            "krea2_vae": ("Qwen-Image VAE", "Comfy-Org/Krea-2", "vae/qwen_image_vae.safetensors", 0.25),
            "krea2_turbo_lora": ("Turbo LoRA", "Comfy-Org/Krea-2", "loras/krea2_turbo_lora_rank_64_bf16.safetensors", 0.47),
            "krea2_turbo_dit": ("Turbo DiT", "Comfy-Org/Krea-2", "diffusion_models/krea2_turbo_fp8_scaled.safetensors", 13.0),
        },
    },
    "klein": {
        "name": "Klein 9B",
        "core": ("base_dit", "text_encoder", "vae"),
        "support": ("distilled_dit",),
        "assets": {
            "base_dit": ("Base DiT", "black-forest-labs/FLUX.2-klein-base-9b-fp8", "flux-2-klein-base-9b-fp8.safetensors", 9.5),
            "text_encoder": ("Qwen3-8B training text encoder", "Comfy-Org/vae-text-encorder-for-flux-klein-9b", "split_files/text_encoders/qwen_3_8b.safetensors", 15.0),
            "vae": ("FLUX.2 VAE", "black-forest-labs/FLUX.2-dev", "ae.safetensors", 0.32),
            "distilled_dit": ("Distilled DiT", "black-forest-labs/FLUX.2-klein-9b-fp8", "flux-2-klein-9b-fp8.safetensors", 9.0),
        },
        "gated": True,
    },
}


class ModelDownloadManager:
    """Process-local job manager for caption and training-model downloads.

    Model bytes live in /workspace and survive API restarts. Jobs are deliberately
    ephemeral and only describe work performed by this process.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}

    def _active_job(self) -> dict[str, Any] | None:
        return next((job for job in self._jobs.values() if job["status"] in {"queued", "running"}), None)

    def _new_job(self, values: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            active = self._active_job()
            if active is not None:
                label = active.get("repo_id") or active.get("family") or active["kind"]
                raise RuntimeError(f"A model download is already in progress: {label} ({active['id']})")
            job_id = uuid.uuid4().hex[:16]
            job = {
                "id": job_id,
                "status": "queued",
                "phase": "queued",
                "created_at": _now(),
                "started_at": None,
                "finished_at": None,
                "path": None,
                "selected": False,
                "error": None,
                "log_tail": [],
                **values,
            }
            self._jobs[job_id] = job
            return dict(job)

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
        job = self._new_job({
            "kind": "qwen_caption_model",
            "repo_id": repo_id,
            "revision": revision.strip(),
            "model_dir": model_dir.strip(),
            "select_when_complete": bool(select_when_complete),
        })
        threading.Thread(target=self._run_qwen, args=(job["id"],), daemon=True, name=f"qwen-download-{job['id']}").start()
        return self.get(job["id"])

    def start_training_family(self, *, family: str, model_dir: str = "") -> dict[str, Any]:
        family = family.strip().lower()
        if family not in _TRAINING_FAMILIES:
            raise ValueError(f"Unsupported training model family: {family}")
        resolved_dir = model_dir.strip() or load_settings().training_model_dir
        job = self._new_job({
            "kind": "training_model_family",
            "family": family,
            "repo_id": _TRAINING_FAMILIES[family]["name"],
            "revision": "",
            "model_dir": resolved_dir,
            "select_when_complete": True,
            "current_asset": None,
            "completed_assets": 0,
            "total_assets": len(_TRAINING_FAMILIES[family]["assets"]),
            "bytes_done": 0,
            "bytes_total": 0,
        })
        threading.Thread(target=self._run_training_family, args=(job["id"],), daemon=True, name=f"training-model-download-{family}-{job['id']}").start()
        return self.get(job["id"])

    def get(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            return dict(job)

    def _patch(self, job_id: str, **values: Any) -> None:
        with self._lock:
            self._jobs[job_id].update(values)

    def _log(self, job_id: str, message: str) -> None:
        message = str(message).strip()
        if not message:
            return
        if "[progress]" in message:
            try:
                tail = message.split("[progress]", 1)[1].strip().split(maxsplit=2)
                done, total = int(tail[0]), int(tail[1])
                self._patch(job_id, bytes_done=done, bytes_total=total)
            except (ValueError, IndexError):
                pass
        with self._lock:
            lines = list(self._jobs[job_id].get("log_tail") or [])
            lines.append(message)
            self._jobs[job_id]["log_tail"] = lines[-40:]

    def _run_qwen(self, job_id: str) -> None:
        job = self.get(job_id)
        self._patch(job_id, status="running", phase="downloading", started_at=_now())
        try:
            path = download_qwen_snapshot(job["repo_id"], revision=job["revision"], model_dir=job["model_dir"])
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
            self._patch(job_id, status="complete", phase="complete", finished_at=_now(), path=path, selected=selected)
        except Exception as exc:
            self._patch(job_id, status="failed", phase="failed", finished_at=_now(), error=f"{type(exc).__name__}: {exc}")

    def _run_training_family(self, job_id: str) -> None:
        job = self.get(job_id)
        family = job["family"]
        model_dir = str(Path(job["model_dir"]).expanduser().resolve())
        self._patch(job_id, status="running", phase="loading manifest", started_at=_now())
        try:
            # Fizgig is installed in the Runpod image and is the source of truth for the actual
            # download manifest. The UI fallback metadata above is presentation/readiness only.
            from fizgig.scripts import fetch_models

            fetch_models.EMIT_PROGRESS = True
            weights = {weight.pref_key: weight for weight in fetch_models.FAMILIES[family]}
            expected = tuple(_TRAINING_FAMILIES[family]["assets"].keys())
            missing_manifest = [key for key in expected if key not in weights]
            if missing_manifest:
                raise RuntimeError(f"Installed Fizgig model manifest is missing: {', '.join(missing_manifest)}")

            Path(model_dir).mkdir(parents=True, exist_ok=True)
            prefs = settings_dict()
            prefs["training_model_dir"] = model_dir
            save_settings({"training_model_dir": model_dir})

            for index, key in enumerate(expected, start=1):
                weight = weights[key]
                self._patch(
                    job_id,
                    phase=f"downloading {weight.filename}",
                    current_asset=key,
                    completed_assets=index - 1,
                    bytes_done=0,
                    bytes_total=0,
                )
                ok = fetch_models.fetch_weight(
                    weight,
                    model_dir,
                    prefs,
                    token=os.environ.get("HF_TOKEN") or None,
                    log=lambda line, _job=job_id: self._log(_job, line),
                )
                if not ok:
                    raise RuntimeError(
                        f"Unable to download {weight.filename}. For gated Klein models, accept the Hugging Face licence and provide HF_TOKEN to the pod."
                    )
                save_settings({key: str(prefs[key]), "training_model_dir": model_dir})
                self._patch(job_id, completed_assets=index)

            self._patch(
                job_id,
                status="complete",
                phase="complete",
                current_asset=None,
                finished_at=_now(),
                path=model_dir,
                selected=True,
            )
        except Exception as exc:
            self._patch(job_id, status="failed", phase="failed", finished_at=_now(), error=f"{type(exc).__name__}: {exc}")

    def training_state(self) -> dict[str, Any]:
        prefs = settings_dict()
        families: list[dict[str, Any]] = []
        for family_id, spec in _TRAINING_FAMILIES.items():
            rows: list[dict[str, Any]] = []
            for key, (label, repo, filename, gb) in spec["assets"].items():
                path = str(prefs.get(key) or "")
                exists = bool(path and Path(path).expanduser().is_file())
                rows.append({
                    "key": key,
                    "label": label,
                    "repo": repo,
                    "filename": filename,
                    "size_gb": gb,
                    "path": path,
                    "exists": exists,
                    "core": key in spec["core"],
                })
            core_ready = all(row["exists"] for row in rows if row["core"])
            support = [row for row in rows if not row["core"]]
            families.append({
                "id": family_id,
                "name": spec["name"],
                "ready": core_ready,
                "support_ready": all(row["exists"] for row in support) if support else True,
                "gated": bool(spec.get("gated")),
                "assets": rows,
            })
        return {
            "model_dir": str(prefs.get("training_model_dir") or load_settings().training_model_dir),
            "hf_token_available": bool(os.environ.get("HF_TOKEN")),
            "families": families,
        }


model_download_manager = ModelDownloadManager()
