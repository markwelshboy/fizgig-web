from __future__ import annotations

import hashlib
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
    side = 1024.0 * math.sqrt(max(0.05, float(value)))
    step = 16
    return max(256, int(round(side / step)) * step)


def _schedule_manifest(run_dir: Path, seed: int) -> dict[str, Any] | None:
    """Hash the observed image/timestep schedule so comparison runs can prove alignment."""
    path = run_dir / "loss_log" / "per_image_loss.jsonl"
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    order_digest = hashlib.sha256()
    count = 0
    first = None
    last = None
    try:
        with path.open("r", encoding="utf-8") as source:
            for raw in source:
                if not raw.strip():
                    continue
                row = json.loads(raw)
                record = {
                    "epoch": row.get("epoch"),
                    "step": row.get("step"),
                    "key": row.get("key"),
                    "timestep": row.get("t", row.get("timestep")),
                }
                order_record = {"epoch": record["epoch"], "step": record["step"], "key": record["key"]}
                digest.update(json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n")
                order_digest.update(json.dumps(order_record, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n")
                count += 1
                if first is None:
                    first = record
                last = record
    except (OSError, json.JSONDecodeError):
        return None
    value = {
        "schema_version": 1,
        "created_at": _now(),
        "seed": int(seed),
        "record_count": count,
        "bucket_order": "seeded_per_epoch",
        "image_order_sha256": order_digest.hexdigest(),
        "image_timestep_schedule_sha256": digest.hexdigest(),
        "first_observation": first,
        "last_observation": last,
        "rng_policy": "Upstream torch global RNG is seeded by --seed; dataset order is isolated by Fizgig's seeded bucket sampler. Training noise/timestep RNG remains Fizgig's upstream global RNG.",
    }
    _write_json(run_dir / "schedule_manifest.json", value)
    return value


def _read_sampling_plan(project_dir: Path) -> dict[str, Any]:
    path = project_dir / "sampling_plan.json"
    if not path.is_file():
        return {
            "schema_version": 1,
            "enabled": False,
            "schedule": {"sample_at_start": False, "every_n_epochs": 0, "every_n_steps": 0},
            "renderer": {"use_distilled": True, "steps": 8, "negative_prompt": "", "flow_shift": None},
            "samples": [],
        }
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Project sampling plan is invalid: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("Project sampling plan must contain an object")
    return value


def _same_number(values: list[Any], label: str) -> float:
    numbers = [float(value) for value in values]
    if not numbers:
        raise ValueError(f"Sampling requires at least one {label}")
    first = numbers[0]
    if any(abs(value - first) > 1e-9 for value in numbers[1:]):
        raise ValueError(
            f"Krea 2 standalone previews use one shared {label} for the whole prompt set. "
            f"Make all configured samples use the same {label} before starting training."
        )
    return first


class TrainingRuntime:
    """Launch a prepared run using stock Fizgig entry points with passive web telemetry."""

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

    def _sampling_snapshot(self, run: dict[str, Any], run_dir: Path, project_dir: Path) -> dict[str, Any]:
        """Freeze the prepared sampling plan and map only stock Krea CLI capabilities.

        New runs carry the project sampling plan inside run.config from preparation time. Imported
        older runs fall back to the current project plan so they retain the legacy start behavior.
        """
        config = run.get("config") if isinstance(run.get("config"), dict) else {}
        prepared_plan = config.get("sampling") if isinstance(config, dict) else None
        plan = prepared_plan if isinstance(prepared_plan, dict) else _read_sampling_plan(project_dir)
        plan_source = "prepared_run_config" if isinstance(prepared_plan, dict) else "project_plan_legacy_fallback"

        samples = plan.get("samples") if isinstance(plan.get("samples"), list) else []
        schedule = plan.get("schedule") if isinstance(plan.get("schedule"), dict) else {}
        renderer = plan.get("renderer") if isinstance(plan.get("renderer"), dict) else {}
        enabled = bool(plan.get("enabled")) and bool(samples)
        sample_at_start = bool(schedule.get("sample_at_start"))
        every_n_epochs = int(schedule.get("every_n_epochs", 0) or 0)
        every_n_steps = int(schedule.get("every_n_steps", 0) or 0)
        active = enabled and (sample_at_start or every_n_epochs > 0 or every_n_steps > 0)

        snapshot: dict[str, Any] = {
            "schema_version": 1,
            "captured_at": _now(),
            "plan_source": plan_source,
            "engine": "stock_fizgig_krea2_preview_cli",
            "active": active,
            "project_plan": plan,
            "resolved_prompts": [],
            "preview_model": None,
        }
        if not active:
            _write_json(run_dir / "sampling_snapshot.json", snapshot)
            return snapshot

        if every_n_steps:
            raise ValueError(
                "Krea 2 standalone training previews currently support epoch cadence, not every-N-step sampling. "
                "Set Every N steps to 0 on the Sampling page."
            )
        if renderer.get("use_distilled", True) is not True:
            raise ValueError(
                "Krea 2 in-training previews currently use Fizgig's distilled/Turbo preview path. "
                "Enable distilled / turbo sampling on the Sampling page."
            )
        if renderer.get("flow_shift") is not None:
            raise ValueError(
                "Krea 2 standalone in-training previews do not expose a custom preview Flow Shift. "
                "Clear Flow Shift on the Sampling page to use Fizgig's stock preview behavior."
            )

        widths = [sample.get("width", 1024) for sample in samples if isinstance(sample, dict)]
        heights = [sample.get("height", 1024) for sample in samples if isinstance(sample, dict)]
        cfgs = [sample.get("cfg_scale", 1.0) for sample in samples if isinstance(sample, dict)]
        if len(widths) != len(samples):
            raise ValueError("Sampling plan contains an invalid sample definition")
        width = int(_same_number(widths, "width"))
        height = int(_same_number(heights, "height"))
        cfg_scale = float(_same_number(cfgs, "CFG scale"))

        seeds = [int(sample.get("seed", 42) if sample.get("seed") is not None else 42) for sample in samples]
        base_seed = seeds[0]
        expected_seeds = [base_seed + index for index in range(len(seeds))]
        if seeds != expected_seeds:
            raise ValueError(
                "Krea 2 standalone previews use one base seed and render prompt i with seed+i. "
                f"For this set, use seeds {expected_seeds[0]} through {expected_seeds[-1]} in prompt order."
            )

        trigger = str(run.get("trigger_word") or "").strip()
        prompts: list[str] = []
        for sample in samples:
            prompt = str(sample.get("prompt_template") or "").strip()
            if not prompt:
                raise ValueError("Every enabled sampling definition needs a prompt")
            prompts.append(prompt.replace("__trigger__", trigger))
        prompts_path = run_dir / "sample_prompts.txt"
        prompts_path.write_text("\n".join(prompts) + "\n", encoding="utf-8")

        from .model_downloads import model_download_manager
        state = model_download_manager.training_state()
        family = next((item for item in state.get("families", []) if item.get("id") == "krea2"), None)
        preview_asset = next(
            (item for item in (family or {}).get("assets", []) if item.get("key") == "krea2_turbo_dit"),
            None,
        )
        if not isinstance(preview_asset, dict) or not preview_asset.get("exists"):
            raise ValueError("Krea 2 sampling is enabled but the Turbo DiT preview model is missing. Download / verify the Krea 2 model bundle first.")
        if not preview_asset.get("verified") or not preview_asset.get("sha256"):
            raise ValueError("Krea 2 sampling is enabled but the Turbo DiT SHA-256 verification is still pending. Wait for model verification before starting the run.")
        preview_manifest = {
            "schema_version": 1,
            "algorithm": "sha256",
            "family": "krea2",
            "family_name": "Krea 2",
            "captured_at": _now(),
            "assets": [{
                "key": "krea2_turbo_dit",
                "label": preview_asset.get("label"),
                "repo": preview_asset.get("repo"),
                "filename": preview_asset.get("filename"),
                "path": preview_asset.get("path"),
                "sha256": preview_asset.get("sha256"),
                "core": False,
            }],
        }
        model_download_manager.verify_manifest(preview_manifest)

        snapshot.update({
            "resolved_prompts": prompts,
            "prompts_file": str(prompts_path),
            "preview_model": preview_manifest,
            "stock_options": {
                "sample_at_start": sample_at_start,
                "every_n_epochs": every_n_epochs,
                "width": width,
                "height": height,
                "steps": int(renderer.get("steps", 8) or 8),
                "cfg_scale": cfg_scale,
                "negative_prompt": str(renderer.get("negative_prompt") or ""),
                "base_seed": base_seed,
                "seed_rule": "base_seed + prompt_index",
            },
        })
        _write_json(run_dir / "sampling_snapshot.json", snapshot)
        _write_json(run_dir / "sampling_model_manifest.json", preview_manifest)
        _append_jsonl(run_dir / "events.jsonl", {
            "time": _now(),
            "type": "sampling_snapshot_captured",
            "plan_source": plan_source,
            "sample_count": len(prompts),
            "sample_at_start": sample_at_start,
            "every_n_epochs": every_n_epochs,
            "preview_model_sha256": preview_asset.get("sha256"),
        })
        return snapshot

    def start(self, project_id: str, run_id: str) -> dict[str, Any]:
        run, run_dir, project_dir = self._run_paths(project_id, run_id)
        if run.get("model_family") != "krea2":
            raise ValueError("Observer-first trainer wiring currently supports Krea 2 only")
        if run.get("status") != "prepared":
            raise ValueError(f"Only a prepared run can be started; this run is {run.get('status', 'unknown')}")

        model_manifest = run.get("model_manifest")
        if not isinstance(model_manifest, dict):
            raise ValueError("This prepared run predates training-model fingerprinting. Prepare a new run before training.")
        from .model_downloads import model_download_manager
        model_download_manager.verify_manifest(model_manifest)

        batch_size = int(run.get("config", {}).get("dataset", {}).get("batch_size", 1) or 1)
        if batch_size != 1:
            raise ValueError("The telemetry baseline requires Krea 2 batch size 1 so each loss observation maps to one image")

        sampling_snapshot = self._sampling_snapshot(run, run_dir, project_dir)
        seed = int(run.get("config", {}).get("training", {}).get("seed", 42) or 42)
        key = (project_id, run_id)
        with self._lock:
            existing = self._threads.get(key)
            if existing and existing.is_alive():
                raise ValueError("Run worker is already active")
            self._set_status(
                project_id,
                run_id,
                "starting",
                started_at=_now(),
                software=software_snapshot(),
                telemetry_mode="observation_only",
                sampling_snapshot=sampling_snapshot,
                reproducibility={
                    "seed": seed,
                    "bucket_order": "seeded_per_epoch",
                    "python_hash_seed": seed,
                    "training_rng": "upstream_torch_global_seed",
                },
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
        manifest = run.get("model_manifest") or {}
        model_paths = {
            str(asset.get("key")): str(asset.get("path") or "")
            for asset in manifest.get("assets", [])
            if isinstance(asset, dict)
        }
        raw_dit = model_paths.get("krea2_raw_dit", "")
        vae = model_paths.get("krea2_vae", "")
        text_encoder = model_paths.get("krea2_text_encoder", "")
        required = {"Krea 2 RAW DiT": raw_dit, "Krea 2 VAE": vae, "Krea 2 text encoder": text_encoder}
        missing = [label for label, path in required.items() if not path or not Path(path).is_file()]
        if missing:
            raise ValueError("Prepared training model paths are not ready: " + ", ".join(missing))

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

        cache_latents = [py, str(scripts / "krea2_cache_latents.py"), "--dataset_config", str(dataset_toml), "--vae", vae, "--skip_existing"]
        cache_text = [py, str(scripts / "krea2_cache_text.py"), "--dataset_config", str(dataset_toml), "--text_encoder", text_encoder]

        output_name = _safe_output_name(str(run["project_id"]), str(run["id"]))
        train = [
            py, str(scripts / "krea2_train.py"),
            "--dataset_config", str(dataset_toml),
            "--dit", raw_dit,
            "--output_dir", str(run_dir),
            "--output_name", output_name,
            "--network_dim", str(int(network.get("rank", 32) or 32)),
            "--network_alpha", str(float(network.get("alpha", 32) or 32)),
            "--max_train_epochs", str(int(training.get("max_epochs", 30) or 30)),
            "--save_every_n_epochs", str(int(training.get("save_every_n_epochs", 1) or 1)),
            "--keep_last_n_states", str(int(training.get("keep_last_states", 4) or 4)),
            "--save_state", "--save_state_on_train_end",
            "--seed", str(int(training.get("seed", 42) or 42)),
            "--gradient_accumulation_steps", str(int(optimizer.get("gradient_accumulation", 1) or 1)),
            "--max_grad_norm", str(float(optimizer.get("max_grad_norm", 1.0) or 0.0)),
            "--optimizer_type", str(optimizer.get("type", "adamw")),
            "--compile_blocks", str(runtime.get("compile_blocks", "auto")),
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
            train += ["--learning_rate", str(math.sqrt(min_lr * max_lr)), "--adaptive_lr", "--adaptive_lr_min", str(min_lr), "--adaptive_lr_max", str(max_lr)]
        else:
            train += ["--learning_rate", str(float(lr.get("lr", 1e-4) or 1e-4))]

        sampling = run.get("sampling_snapshot")
        if isinstance(sampling, dict) and sampling.get("active"):
            stock = sampling.get("stock_options") if isinstance(sampling.get("stock_options"), dict) else {}
            preview_manifest = sampling.get("preview_model") if isinstance(sampling.get("preview_model"), dict) else {}
            preview_asset = next((asset for asset in preview_manifest.get("assets", []) if isinstance(asset, dict) and asset.get("key") == "krea2_turbo_dit"), None)
            turbo_dit = str((preview_asset or {}).get("path") or "")
            if not turbo_dit or not Path(turbo_dit).is_file():
                raise ValueError("Prepared Krea 2 preview Turbo path is missing")
            train += [
                "--turbo_dit", turbo_dit,
                "--vae", vae,
                "--text_encoder", text_encoder,
                "--sample_prompts", str(sampling.get("prompts_file")),
                "--sample_every_n_epochs", str(int(stock.get("every_n_epochs", 0) or 0)),
                "--sample_width", str(int(stock.get("width", 1024) or 1024)),
                "--sample_height", str(int(stock.get("height", 1024) or 1024)),
                "--sample_steps", str(int(stock.get("steps", 8) or 8)),
                "--sample_cfg_scale", str(float(stock.get("cfg_scale", 1.0) if stock.get("cfg_scale") is not None else 1.0)),
                "--sample_seed", str(int(stock.get("base_seed", 42) if stock.get("base_seed") is not None else 42)),
            ]
            if bool(stock.get("sample_at_start")):
                train.append("--sample_at_first")
            negative = str(stock.get("negative_prompt") or "").strip()
            if float(stock.get("cfg_scale", 1.0) if stock.get("cfg_scale") is not None else 1.0) > 1.0 and negative:
                train += ["--sample_negative", negative]

        return [("cache_latents", cache_latents), ("cache_text", cache_text), ("train", train)]

    def _run_command(self, label: str, command: list[str], *, run_dir: Path, env: dict[str, str]) -> int:
        console = run_dir / "console.log"
        _append_jsonl(run_dir / "events.jsonl", {"time": _now(), "type": "command_started", "stage": label, "command": command})
        with console.open("a", encoding="utf-8", buffering=1) as log:
            log.write(f"[{_now()}] === {label} ===\n")
            log.write(f"[{_now()}] $ {' '.join(command)}\n")
            process = subprocess.Popen(command, cwd=os.environ.get("FIZGIG_ROOT", "/opt/Fizgig"), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
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

            seed = int(run.get("config", {}).get("training", {}).get("seed", 42) or 42)
            env = os.environ.copy()
            env["FIZGIG_TELEMETRY_DIR"] = str(run_dir)
            env["FIZGIG_PERIMAGE_LOSS_LOG"] = "1"
            env["FIZGIG_BUCKET_ORDER"] = "1"
            env["PYTHONHASHSEED"] = str(seed)
            env["PYTHONUNBUFFERED"] = "1"
            _append_jsonl(run_dir / "events.jsonl", {"time": _now(), "type": "reproducibility_contract", "seed": seed, "bucket_order": "seeded_per_epoch", "python_hash_seed": seed, "training_rng": "upstream_torch_global_seed"})

            for stage, command in commands:
                self._set_status(project_id, run_id, "training" if stage == "train" else stage)
                code = self._run_command(stage, command, run_dir=run_dir, env=env)
                if code != 0:
                    raise RuntimeError(f"{stage} exited with status {code}")

            schedule = _schedule_manifest(run_dir, seed)
            final_path = run_dir / f"{_safe_output_name(project_id, run_id)}.safetensors"
            completed = self._set_status(project_id, run_id, "completed", completed_at=_now(), final_lora=str(final_path) if final_path.is_file() else None, schedule_manifest=schedule)
            _append_jsonl(run_dir / "events.jsonl", {"time": _now(), "type": "training_baseline_completed", "final_lora": completed.get("final_lora"), "schedule_sha256": schedule.get("image_timestep_schedule_sha256") if schedule else None})
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
