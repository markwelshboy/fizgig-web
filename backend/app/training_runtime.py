from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .projects import project_store
from .runtime_info import software_snapshot
from .settings import load_settings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(value, ensure_ascii=False) + "\n")
        f.flush()


def _safe_output_name(project_id: str, run_id: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", f"{project_id}-{run_id}").strip("-._")
    return value or run_id


def _resolution_from_megapixels(value: float) -> int:
    # Match Fizgig's user-facing convention: [1024,1024] is called the 1 MP target and
    # [512,512] the 0.25 MP target. Krea 2 buckets on a 16-pixel grid, so round to that same
    # grid instead of silently producing a slightly smaller target from decimal 1,000,000.
    side = 1024.0 * math.sqrt(max(0.05, float(value)))
    step = 16
    return max(256, int(round(side / step)) * step)


class TrainingRuntime:
    """Launch a prepared run in observation-only mode.

    This deliberately wires the stock Fizgig pipeline first: cache latents, cache text, train.
    Per-image telemetry is enabled, but the harness does NOT yet enable per-image LR, automatic
    recaptioning, look-outlier warm-up, or policy overrides. That lets us compare the web harness
    against an equivalent ordinary Fizgig command before allowing the harness to shape a run.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._threads: dict[tuple[str, str], threading.Thread] = {}

    def _run_paths(self, project_id: str, run_id: str) -> tuple[dict[str, Any], Path, Path]:
        run = project_store.get_run(project_id, run_id)
        run_dir = Path(run["output_dir"]).resolve()
        project_dir = project_store.project_dir(project_id)
        if project_dir not in run_dir.parents:
            raise ValueError("Run output path is outside the project")
        return run, run_dir, project_dir

    def _set_status(self, project_id: str, run_id: str, status: str, **extra: Any) -> dict[str, Any]:
        run, run_dir, project_dir = self._run_paths(project_id, run_id)
        run.update({"status": status, "updated_at": _now(), **extra})
        _write_json(run_dir / "run.json", run)

        project_path = project_dir / "project.json"
        project = json.loads(project_path.read_text(encoding="utf-8"))
        for summary in project.get("runs", []):
            if summary.get("id") == run_id:
                summary["status"] = status
                break
        project["updated_at"] = _now()
        _write_json(project_path, project)
        return run

    def status(self, project_id: str, run_id: str) -> dict[str, Any]:
        run = project_store.get_run(project_id, run_id)
        with self._lock:
            alive = bool(self._threads.get((project_id, run_id)) and self._threads[(project_id, run_id)].is_alive())
        return {"run": run, "worker_alive": alive}

    def start(self, project_id: str, run_id: str) -> dict[str, Any]:
        run, _, _ = self._run_paths(project_id, run_id)
        if run.get("model_family") != "krea2":
            raise ValueError("Observer-first trainer wiring currently supports Krea 2 only")
        if run.get("status") != "prepared":
            raise ValueError(f"Only a prepared run can be started; this run is {run.get('status', 'unknown')}")

        batch_size = int(run.get("config", {}).get("dataset", {}).get("batch_size", 1) or 1)
        if batch_size != 1:
            raise ValueError("The telemetry baseline requires Krea 2 batch size 1 so each loss observation maps to one image")

        key = (project_id, run_id)
        with self._lock:
            existing = self._threads.get(key)
            if existing and existing.is_alive():
                raise ValueError("Run worker is already active")
            # Publish STARTING before returning from the API. That makes the browser's first
            # response authoritative and guarantees its live polling starts even if the worker
            # thread has not reached Python scheduling yet.
            self._set_status(
                project_id,
                run_id,
                "starting",
                started_at=_now(),
                software=software_snapshot(),
                telemetry_mode="observation_only",
            )
            worker = threading.Thread(target=self._worker, args=(project_id, run_id), daemon=True, name=f"fizgig-{run_id}")
            self._threads[key] = worker
            worker.start()
        return self.status(project_id, run_id)

    def _dataset_toml(self, run: dict[str, Any], run_dir: Path) -> Path:
        config = run.get("config", {})
        dataset = config.get("dataset", {})
        training = config.get("training", {})
        side = _resolution_from_megapixels(float(training.get("target_megapixels", 1.0) or 1.0))
        cache_dir = run_dir / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        text = "\n".join([
            "[general]",
            f"resolution = [{side}, {side}]",
            'caption_extension = ".txt"',
            f"batch_size = {int(dataset.get('batch_size', 1) or 1)}",
            "num_repeats = 1",
            f"enable_bucket = {'true' if dataset.get('enable_bucket', True) else 'false'}",
            f"bucket_no_upscale = {'true' if dataset.get('bucket_no_upscale', True) else 'false'}",
            "",
            "[[datasets]]",
            f"image_directory = {json.dumps(str(run['dataset_path']))}",
            f"cache_directory = {json.dumps(str(cache_dir))}",
            "",
        ])
        path = run_dir / "Fizgig_train.toml"
        path.write_text(text, encoding="utf-8")
        return path

    def _commands(self, run: dict[str, Any], run_dir: Path) -> list[tuple[str, list[str]]]:
        settings = load_settings()
        required = {
            "Krea 2 RAW DiT": settings.krea2_raw_dit,
            "Krea 2 VAE": settings.krea2_vae,
            "Krea 2 text encoder": settings.krea2_text_encoder,
        }
        missing = [label for label, path in required.items() if not path or not Path(path).is_file()]
        if missing:
            raise ValueError("Training model paths are not ready: " + ", ".join(missing))

        fizgig_root = Path(os.environ.get("FIZGIG_ROOT", "/opt/Fizgig")).resolve()
        scripts = fizgig_root / "src" / "fizgig" / "scripts"
        dataset_toml = self._dataset_toml(run, run_dir)
        py = sys.executable
        config = run.get("config", {})
        network = config.get("network", {})
        training = config.get("training", {})
        optimizer = config.get("optimizer", {})
        lr = config.get("learning_rate", {})
        runtime = config.get("runtime", {})

        cache_latents = [
            py, str(scripts / "krea2_cache_latents.py"),
            "--dataset_config", str(dataset_toml),
            "--vae", settings.krea2_vae,
            "--skip_existing",
        ]
        cache_text = [
            py, str(scripts / "krea2_cache_text.py"),
            "--dataset_config", str(dataset_toml),
            "--text_encoder", settings.krea2_text_encoder,
        ]

        output_name = _safe_output_name(str(run["project_id"]), str(run["id"]))
        train = [
            py, str(scripts / "krea2_train.py"),
            "--dataset_config", str(dataset_toml),
            "--dit", settings.krea2_raw_dit,
            "--output_dir", str(run_dir),
            "--output_name", output_name,
            "--network_dim", str(int(network.get("rank", 32) or 32)),
            "--network_alpha", str(float(network.get("alpha", 32) or 32)),
            "--max_train_epochs", str(int(training.get("max_epochs", 30) or 30)),
            "--save_every_n_epochs", str(int(training.get("save_every_n_epochs", 1) or 1)),
            "--keep_last_n_states", str(int(training.get("keep_last_states", 4) or 4)),
            "--save_state",
            "--save_state_on_train_end",
            "--seed", str(int(training.get("seed", 42) or 42)),
            "--gradient_accumulation_steps", str(int(optimizer.get("gradient_accumulation", 1) or 1)),
            "--max_grad_norm", str(float(optimizer.get("max_grad_norm", 1.0) or 0.0)),
            "--optimizer_type", str(optimizer.get("type", "adamw")),
            "--compile_blocks", str(runtime.get("compile_blocks", "auto")),
            # Observation-only: this writes the raw per-image log and current verdicts but does
            # not apply per-image LR or rewrite/exclude anything on our behalf.
            "--log_per_image_loss",
        ]

        if run.get("trigger_word"):
            train += ["--trigger_word", str(run["trigger_word"])]

        precision = str(runtime.get("base_precision", "fp8"))
        if precision == "nf4":
            train.append("--quantize_4bit")
        elif precision == "bf16":
            train.append("--no_fp8")

        if lr.get("mode") == "adaptive":
            min_lr = float(lr.get("min_lr", 1e-4) or 1e-4)
            max_lr = float(lr.get("max_lr", 4e-4) or 4e-4)
            train += [
                "--learning_rate", str(math.sqrt(min_lr * max_lr)),
                "--adaptive_lr",
                "--adaptive_lr_min", str(min_lr),
                "--adaptive_lr_max", str(max_lr),
            ]
        else:
            train += ["--learning_rate", str(float(lr.get("lr", 1e-4) or 1e-4))]

        return [("cache_latents", cache_latents), ("cache_text", cache_text), ("train", train)]

    def _run_command(self, label: str, command: list[str], *, run_dir: Path, env: dict[str, str]) -> int:
        console = run_dir / "console.log"
        _append_jsonl(run_dir / "events.jsonl", {"time": _now(), "type": "command_started", "stage": label, "command": command})
        with console.open("a", encoding="utf-8", buffering=1) as log:
            log.write(f"[{_now()}] === {label} ===\n")
            log.write(f"[{_now()}] $ {' '.join(command)}\n")
            process = subprocess.Popen(
                command,
                cwd=os.environ.get("FIZGIG_ROOT", "/opt/Fizgig"),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert process.stdout is not None
            for line in process.stdout:
                log.write(f"[{_now()}] {line.rstrip()}\n")
            code = process.wait()
            log.write(f"[{_now()}] === {label} exit {code} ===\n")
        _append_jsonl(run_dir / "events.jsonl", {"time": _now(), "type": "command_finished", "stage": label, "exit_code": code})
        return code

    def _worker(self, project_id: str, run_id: str) -> None:
        try:
            run, run_dir, _ = self._run_paths(project_id, run_id)
            software = run.get("software") or software_snapshot()
            commands = self._commands(run, run_dir)
            _write_json(run_dir / "commands.json", {"created_at": _now(), "commands": [{"stage": stage, "argv": argv} for stage, argv in commands]})
            _append_jsonl(run_dir / "events.jsonl", {"time": _now(), "type": "training_baseline_started", "software": software, "mode": "observation_only"})

            env = os.environ.copy()
            env["FIZGIG_TELEMETRY_DIR"] = str(run_dir)
            env["FIZGIG_PERIMAGE_LOSS_LOG"] = "1"
            env["PYTHONUNBUFFERED"] = "1"

            for stage, command in commands:
                self._set_status(project_id, run_id, "training" if stage == "train" else stage)
                code = self._run_command(stage, command, run_dir=run_dir, env=env)
                if code != 0:
                    raise RuntimeError(f"{stage} exited with status {code}")

            final_path = run_dir / f"{_safe_output_name(project_id, run_id)}.safetensors"
            completed = self._set_status(project_id, run_id, "completed", completed_at=_now(), final_lora=str(final_path) if final_path.is_file() else None)
            _append_jsonl(run_dir / "events.jsonl", {"time": _now(), "type": "training_baseline_completed", "final_lora": completed.get("final_lora")})
            if final_path.is_file():
                try:
                    project_store.register_artifact(project_id, run_id, artifact_type="lora", path=str(final_path), metadata={"telemetry_mode": "observation_only"})
                except Exception:
                    pass
        except Exception as exc:
            try:
                self._set_status(project_id, run_id, "failed", failed_at=_now(), error=f"{type(exc).__name__}: {exc}")
                _, run_dir, _ = self._run_paths(project_id, run_id)
                _append_jsonl(run_dir / "events.jsonl", {"time": _now(), "type": "training_failed", "error": f"{type(exc).__name__}: {exc}"})
                with (run_dir / "console.log").open("a", encoding="utf-8") as log:
                    log.write(f"[{_now()}] ERROR: {type(exc).__name__}: {exc}\n")
            except Exception:
                pass


training_runtime = TrainingRuntime()
