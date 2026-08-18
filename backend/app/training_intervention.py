from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

from . import training_runtime as _runtime


def _run_config(run: dict[str, Any]) -> dict[str, Any]:
    value = run.get("config")
    return value if isinstance(value, dict) else {}


def _loss_watch_config(run: dict[str, Any]) -> dict[str, Any]:
    value = _run_config(run).get("loss_watch")
    return value if isinstance(value, dict) else {}


def _intervention_mode(run: dict[str, Any]) -> str:
    # Backward-compatibility boundary: older prepared runs may contain intervention-looking
    # booleans from the former observer UI, where those values were provenance-only. Only a run
    # prepared by the intervention-aware UI opts into changing training behavior.
    if _run_config(run).get("training_mode") != "loss_watch_intervention":
        return "observation_only"
    loss_watch = _loss_watch_config(run)
    active = any(
        bool(loss_watch.get(key))
        for key in ("per_image_lr", "auto_recaption", "warmup_look_outliers")
    )
    return "loss_watch_intervention" if active else "observation_only"


def _append_option(argv: list[str], flag: str, value: str) -> None:
    if flag not in argv:
        argv.extend([flag, value])


def _commands(self: _runtime.TrainingRuntime, run: dict[str, Any], run_dir: Path) -> list[tuple[str, list[str]]]:
    commands = _ORIGINAL_COMMANDS(self, run, run_dir)
    if _intervention_mode(run) != "loss_watch_intervention":
        return commands

    loss_watch = _loss_watch_config(run)
    manifest = run.get("model_manifest") if isinstance(run.get("model_manifest"), dict) else {}
    model_paths = {
        str(asset.get("key")): str(asset.get("path") or "")
        for asset in manifest.get("assets", [])
        if isinstance(asset, dict)
    }
    text_encoder = model_paths.get("krea2_text_encoder", "")

    for stage, argv in commands:
        if stage != "train":
            continue
        if bool(loss_watch.get("per_image_lr")) and "--per_image_lr" not in argv:
            argv.append("--per_image_lr")
        if bool(loss_watch.get("auto_recaption")):
            if "--auto_recaption" not in argv:
                argv.append("--auto_recaption")
            if not text_encoder or not Path(text_encoder).is_file():
                raise ValueError("Automatic recaption requires the prepared Krea 2 Qwen3-VL text encoder")
            _append_option(argv, "--text_encoder", text_encoder)
            instruction = str(loss_watch.get("recaption_instruction") or "").strip()
            detailed = str(loss_watch.get("recaption_instruction_detailed") or "").strip()
            if instruction:
                _append_option(argv, "--recaption_instruction", instruction)
            if detailed:
                _append_option(argv, "--recaption_instruction_detailed", detailed)
        if bool(loss_watch.get("warmup_look_outliers")) and "--warmup_look_outliers" not in argv:
            argv.append("--warmup_look_outliers")
    return commands


def _start(self: _runtime.TrainingRuntime, project_id: str, run_id: str) -> dict[str, Any]:
    run, run_dir, project_dir = self._run_paths(project_id, run_id)
    if run.get("model_family") != "krea2":
        raise ValueError("Loss-watch intervention wiring currently supports Krea 2 only")
    if run.get("status") != "prepared":
        raise ValueError(f"Only a prepared run can be started; this run is {run.get('status', 'unknown')}")

    model_manifest = run.get("model_manifest")
    if not isinstance(model_manifest, dict):
        raise ValueError("This prepared run predates training-model fingerprinting. Prepare a new run before training.")
    from .model_downloads import model_download_manager
    model_download_manager.verify_manifest(model_manifest)

    batch_size = int(run.get("config", {}).get("dataset", {}).get("batch_size", 1) or 1)
    if batch_size != 1:
        raise ValueError("Krea 2 per-image trajectories/interventions require batch size 1 so each loss observation maps to one image")

    sampling_snapshot = self._sampling_snapshot(run, run_dir, project_dir)
    seed = int(run.get("config", {}).get("training", {}).get("seed", 42) or 42)
    mode = _intervention_mode(run)
    key = (project_id, run_id)
    with self._lock:
        existing = self._threads.get(key)
        if existing and existing.is_alive():
            raise ValueError("Run worker is already active")
        self._set_status(
            project_id,
            run_id,
            "starting",
            started_at=_runtime._now(),
            software=_runtime.software_snapshot(),
            telemetry_mode=mode,
            sampling_snapshot=sampling_snapshot,
            reproducibility={
                "seed": seed,
                "bucket_order": "seeded_per_epoch",
                "python_hash_seed": seed,
                "training_rng": "upstream_torch_global_seed",
            },
        )
        worker = threading.Thread(
            target=self._worker,
            args=(project_id, run_id),
            daemon=True,
            name=f"fizgig-{run_id}",
        )
        self._threads[key] = worker
        worker.start()
    return self.status(project_id, run_id)


def _worker(self: _runtime.TrainingRuntime, project_id: str, run_id: str) -> None:
    try:
        run, run_dir, _ = self._run_paths(project_id, run_id)
        mode = _intervention_mode(run)
        software = run.get("software") or _runtime.software_snapshot()
        commands = self._commands(run, run_dir)
        _runtime._write_json(
            run_dir / "commands.json",
            {"created_at": _runtime._now(), "commands": [{"stage": stage, "argv": argv} for stage, argv in commands]},
        )
        _runtime._append_jsonl(
            run_dir / "events.jsonl",
            {"time": _runtime._now(), "type": "training_started", "software": software, "mode": mode},
        )

        seed = int(run.get("config", {}).get("training", {}).get("seed", 42) or 42)
        env = os.environ.copy()
        env["FIZGIG_TELEMETRY_DIR"] = str(run_dir)
        env["FIZGIG_PERIMAGE_LOSS_LOG"] = "1"
        env["FIZGIG_BUCKET_ORDER"] = "1"
        env["PYTHONHASHSEED"] = str(seed)
        env["PYTHONUNBUFFERED"] = "1"
        _runtime._append_jsonl(
            run_dir / "events.jsonl",
            {
                "time": _runtime._now(),
                "type": "reproducibility_contract",
                "seed": seed,
                "bucket_order": "seeded_per_epoch",
                "python_hash_seed": seed,
                "training_rng": "upstream_torch_global_seed",
            },
        )

        for stage, command in commands:
            self._set_status(project_id, run_id, "training" if stage == "train" else stage)
            code = self._run_command(stage, command, run_dir=run_dir, env=env)
            if code != 0:
                raise RuntimeError(f"{stage} exited with status {code}")

        schedule = _runtime._schedule_manifest(run_dir, seed)
        final_path = run_dir / f"{_runtime._safe_output_name(project_id, run_id)}.safetensors"
        completed = self._set_status(
            project_id,
            run_id,
            "completed",
            completed_at=_runtime._now(),
            final_lora=str(final_path) if final_path.is_file() else None,
            schedule_manifest=schedule,
        )
        _runtime._append_jsonl(
            run_dir / "events.jsonl",
            {
                "time": _runtime._now(),
                "type": "training_completed",
                "mode": mode,
                "final_lora": completed.get("final_lora"),
                "schedule_sha256": schedule.get("image_timestep_schedule_sha256") if schedule else None,
            },
        )
        if final_path.is_file():
            try:
                _runtime.project_store.register_artifact(
                    project_id,
                    run_id,
                    artifact_type="lora",
                    path=str(final_path),
                    metadata={"telemetry_mode": mode},
                )
            except Exception:
                pass
    except Exception as exc:
        try:
            self._set_status(project_id, run_id, "failed", failed_at=_runtime._now(), error=f"{type(exc).__name__}: {exc}")
            _, run_dir, _ = self._run_paths(project_id, run_id)
            _runtime._append_jsonl(
                run_dir / "events.jsonl",
                {"time": _runtime._now(), "type": "training_failed", "error": f"{type(exc).__name__}: {exc}"},
            )
            with (run_dir / "console.log").open("a", encoding="utf-8") as log:
                log.write(f"[{_runtime._now()}] ERROR: {type(exc).__name__}: {exc}\n")
        except Exception:
            pass


_ORIGINAL_COMMANDS = _runtime.TrainingRuntime._commands
_runtime.TrainingRuntime._commands = _commands
_runtime.TrainingRuntime.start = _start
_runtime.TrainingRuntime._worker = _worker
