from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

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


def _fingerprints_path() -> Path:
    raw = os.environ.get(
        "FIZGIG_TRAINING_MODEL_FINGERPRINTS",
        "/workspace/fizgig-web/training-model-fingerprints.json",
    )
    return Path(raw).expanduser()


class ModelDownloadManager:
    """Process-local job manager for caption and training-model downloads.

    Model bytes live in /workspace and survive API restarts. Jobs are deliberately
    ephemeral and only describe work performed by this process. Training-model
    SHA-256 fingerprints are persistent: a prepared run is not reproducible until
    the exact base-model bytes are known, so core model readiness includes a valid
    fingerprint for each configured file.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._fingerprint_lock = threading.Lock()
        self._hash_io_lock = threading.Lock()
        self._fingerprint_worker: threading.Thread | None = None
        self._hashing_key: str | None = None
        self._hash_errors: dict[str, str] = {}

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

    # ---- training-model fingerprints ---------------------------------------

    def _load_fingerprints(self) -> dict[str, Any]:
        path = _fingerprints_path()
        if not path.is_file():
            return {"schema_version": 1, "algorithm": "sha256", "assets": {}}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"schema_version": 1, "algorithm": "sha256", "assets": {}}
        if not isinstance(value, dict) or not isinstance(value.get("assets"), dict):
            return {"schema_version": 1, "algorithm": "sha256", "assets": {}}
        return value

    @staticmethod
    def _file_identity(path: Path) -> tuple[str, int, int]:
        resolved = path.expanduser().resolve()
        stat = resolved.stat()
        return str(resolved), int(stat.st_size), int(stat.st_mtime_ns)

    def _valid_fingerprint(self, key: str, path: Path) -> dict[str, Any] | None:
        if not path.is_file():
            return None
        try:
            resolved, size, mtime_ns = self._file_identity(path)
        except OSError:
            return None
        with self._fingerprint_lock:
            entry = self._load_fingerprints().get("assets", {}).get(key)
        if not isinstance(entry, dict):
            return None
        if (
            entry.get("path") != resolved
            or int(entry.get("size_bytes", -1)) != size
            or int(entry.get("mtime_ns", -1)) != mtime_ns
            or not isinstance(entry.get("sha256"), str)
            or len(str(entry.get("sha256"))) != 64
        ):
            return None
        return dict(entry)

    @staticmethod
    def _sha256_file(path: Path, progress: Callable[[int, int], None] | None = None) -> str:
        total = int(path.stat().st_size)
        done = 0
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(8 * 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                done += len(chunk)
                if progress is not None:
                    progress(done, total)
        return digest.hexdigest()

    def _fingerprint_asset(
        self,
        *,
        family: str,
        key: str,
        label: str,
        repo: str,
        filename: str,
        path: Path,
        progress: Callable[[int, int], None] | None = None,
    ) -> dict[str, Any]:
        resolved = path.expanduser().resolve()
        with self._hash_io_lock:
            sha256 = self._sha256_file(resolved, progress)
            resolved_text, size, mtime_ns = self._file_identity(resolved)
        entry = {
            "family": family,
            "key": key,
            "label": label,
            "repo": repo,
            "filename": filename,
            "path": resolved_text,
            "size_bytes": size,
            "mtime_ns": mtime_ns,
            "sha256": sha256,
            "verified_at": _now(),
        }
        fingerprint_path = _fingerprints_path()
        with self._fingerprint_lock:
            value = self._load_fingerprints()
            value["schema_version"] = 1
            value["algorithm"] = "sha256"
            value.setdefault("assets", {})[key] = entry
            fingerprint_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = fingerprint_path.with_suffix(fingerprint_path.suffix + ".tmp")
            tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            os.replace(tmp, fingerprint_path)
        with self._lock:
            self._hash_errors.pop(key, None)
        return entry

    def _run_fingerprint_backfill(self) -> None:
        try:
            prefs = settings_dict()
            for family, spec in _TRAINING_FAMILIES.items():
                for key, (label, repo, filename, _gb) in spec["assets"].items():
                    raw = str(prefs.get(key) or "").strip()
                    if not raw:
                        continue
                    path = Path(raw).expanduser()
                    if not path.is_file() or self._valid_fingerprint(key, path) is not None:
                        continue
                    with self._lock:
                        self._hashing_key = key
                        self._hash_errors.pop(key, None)
                    try:
                        self._fingerprint_asset(
                            family=family,
                            key=key,
                            label=label,
                            repo=repo,
                            filename=filename,
                            path=path,
                        )
                    except Exception as exc:
                        with self._lock:
                            self._hash_errors[key] = f"{type(exc).__name__}: {exc}"
        finally:
            with self._lock:
                self._hashing_key = None

    def _ensure_background_fingerprints(self) -> None:
        with self._lock:
            worker = self._fingerprint_worker
            if worker is not None and worker.is_alive():
                return
            worker = threading.Thread(
                target=self._run_fingerprint_backfill,
                daemon=True,
                name="training-model-sha256",
            )
            self._fingerprint_worker = worker
            worker.start()

    def snapshot_family(self, family: str) -> dict[str, Any]:
        family = family.strip().lower()
        spec = _TRAINING_FAMILIES.get(family)
        if spec is None:
            raise ValueError(f"Unsupported training model family: {family}")
        prefs = settings_dict()
        assets: list[dict[str, Any]] = []
        for key in spec["core"]:
            label, repo, filename, _gb = spec["assets"][key]
            raw = str(prefs.get(key) or "").strip()
            path = Path(raw).expanduser() if raw else Path("/__missing__")
            entry = self._valid_fingerprint(key, path) if raw else None
            if entry is None:
                if not raw or not path.is_file():
                    raise ValueError(f"Training model is missing: {label}")
                self._ensure_background_fingerprints()
                raise RuntimeError(f"SHA-256 verification is still pending for {label}")
            assets.append({
                "key": key,
                "label": label,
                "repo": repo,
                "filename": filename,
                "path": entry["path"],
                "size_bytes": entry["size_bytes"],
                "sha256": entry["sha256"],
                "verified_at": entry.get("verified_at"),
                "core": True,
            })
        return {
            "schema_version": 1,
            "algorithm": "sha256",
            "family": family,
            "family_name": spec["name"],
            "captured_at": _now(),
            "assets": assets,
        }

    def require_fingerprinted_family(self, family: str) -> dict[str, Any]:
        """Hard preparation gate: exact core model bytes must be fingerprinted."""
        return self.snapshot_family(family)

    def verify_manifest(self, manifest: dict[str, Any]) -> None:
        """Cheap start-time integrity check against the prepared model snapshot.

        We do not reread tens of gigabytes at every start. The persisted SHA is accepted only
        while path/size/mtime still match the file that was hashed. Any changed file loses its
        verified state, queues a fresh background hash, and requires the run to be prepared again.
        """
        family = str(manifest.get("family") or "").strip().lower()
        if family not in _TRAINING_FAMILIES:
            raise ValueError("Prepared run has no supported model fingerprint manifest")
        for expected in manifest.get("assets", []):
            if not isinstance(expected, dict):
                continue
            key = str(expected.get("key") or "")
            path = Path(str(expected.get("path") or "")).expanduser()
            current = self._valid_fingerprint(key, path)
            if current is None:
                self._ensure_background_fingerprints()
                raise ValueError(
                    f"Training model changed or is no longer fingerprinted since run preparation: {expected.get('label') or key}. Re-prepare the run after verification completes."
                )
            if current.get("sha256") != expected.get("sha256"):
                raise ValueError(
                    f"Training model SHA-256 differs from the prepared run: {expected.get('label') or key}. Re-prepare the run to accept the new model bytes."
                )

    # ---- download jobs ------------------------------------------------------

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
        spec = _TRAINING_FAMILIES[family]
        model_dir = str(Path(job["model_dir"]).expanduser().resolve())
        self._patch(job_id, status="running", phase="loading manifest", started_at=_now())
        try:
            # Fizgig is installed in the Runpod image and is the source of truth for the actual
            # download manifest. The UI fallback metadata above is presentation/readiness only.
            from fizgig.scripts import fetch_models

            fetch_models.EMIT_PROGRESS = True
            weights = {weight.pref_key: weight for weight in fetch_models.FAMILIES[family]}
            expected = tuple(spec["assets"].keys())
            missing_manifest = [key for key in expected if key not in weights]
            if missing_manifest:
                raise RuntimeError(f"Installed Fizgig model manifest is missing: {', '.join(missing_manifest)}")

            Path(model_dir).mkdir(parents=True, exist_ok=True)
            prefs = settings_dict()
            prefs["training_model_dir"] = model_dir
            save_settings({"training_model_dir": model_dir})

            for index, key in enumerate(expected, start=1):
                weight = weights[key]
                label, repo, filename, _gb = spec["assets"][key]
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

                # The download worker is already asynchronous from the UI. Hash each file as soon
                # as it lands, before advancing to the next asset, so job completion means both
                # bytes and SHA-256 provenance are durable. Progress reuses the existing byte meter.
                resolved = Path(str(prefs[key])).expanduser().resolve()
                self._patch(
                    job_id,
                    phase=f"verifying SHA-256 {resolved.name}",
                    current_asset=key,
                    bytes_done=0,
                    bytes_total=int(resolved.stat().st_size),
                )
                self._fingerprint_asset(
                    family=family,
                    key=key,
                    label=label,
                    repo=repo,
                    filename=filename,
                    path=resolved,
                    progress=lambda done, total, _job=job_id: self._patch(_job, bytes_done=done, bytes_total=total),
                )
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
        # Existing persistent model files may predate fingerprint support. Kick one low-priority
        # sequential background pass; callers can poll while core readiness remains blocked.
        self._ensure_background_fingerprints()
        prefs = settings_dict()
        with self._lock:
            hashing_key = self._hashing_key
            hash_errors = dict(self._hash_errors)
            worker_alive = bool(self._fingerprint_worker and self._fingerprint_worker.is_alive())
        families: list[dict[str, Any]] = []
        for family_id, spec in _TRAINING_FAMILIES.items():
            rows: list[dict[str, Any]] = []
            for key, (label, repo, filename, gb) in spec["assets"].items():
                path = str(prefs.get(key) or "")
                resolved = Path(path).expanduser() if path else None
                exists = bool(resolved and resolved.is_file())
                fingerprint = self._valid_fingerprint(key, resolved) if exists and resolved is not None else None
                if not exists:
                    hash_status = "missing"
                elif fingerprint is not None:
                    hash_status = "verified"
                elif key in hash_errors:
                    hash_status = "error"
                elif hashing_key == key:
                    hash_status = "hashing"
                elif worker_alive:
                    hash_status = "queued"
                else:
                    hash_status = "pending"
                rows.append({
                    "key": key,
                    "label": label,
                    "repo": repo,
                    "filename": filename,
                    "size_gb": gb,
                    "path": path,
                    "exists": exists,
                    "verified": fingerprint is not None,
                    "hash_status": hash_status,
                    "sha256": fingerprint.get("sha256") if fingerprint else None,
                    "hash_error": hash_errors.get(key),
                    "core": key in spec["core"],
                })
            core_rows = [row for row in rows if row["core"]]
            support = [row for row in rows if not row["core"]]
            files_ready = all(row["exists"] for row in core_rows)
            fingerprints_ready = all(row["verified"] for row in core_rows)
            families.append({
                "id": family_id,
                "name": spec["name"],
                "ready": files_ready and fingerprints_ready,
                "files_ready": files_ready,
                "fingerprints_ready": fingerprints_ready,
                "support_ready": all(row["exists"] and row["verified"] for row in support) if support else True,
                "gated": bool(spec.get("gated")),
                "assets": rows,
            })
        return {
            "model_dir": str(prefs.get("training_model_dir") or load_settings().training_model_dir),
            "hf_token_available": bool(os.environ.get("HF_TOKEN")),
            "fingerprint_algorithm": "sha256",
            "fingerprint_store": str(_fingerprints_path()),
            "fingerprinting": worker_alive,
            "families": families,
        }


model_download_manager = ModelDownloadManager()
