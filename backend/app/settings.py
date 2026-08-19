from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

DEFAULT_QWEN_CAPTION_MODEL = "Qwen/Qwen3-VL-8B-Instruct"
DEFAULT_CAPTION_MODEL_DIR = "/workspace/models/captioning"
DEFAULT_TRAINING_MODEL_DIR = "/workspace/models/training"
DEFAULT_WANDB_RUN_PATTERN = "{project}-{model}-{run_id}"


@dataclass
class AppSettings:
    # Caption VLM. Deliberately independent from the text encoders used by training.
    qwen_caption_model: str = DEFAULT_QWEN_CAPTION_MODEL
    qwen_caption_processor: str = ""
    qwen_caption_revision: str = ""
    caption_model_dir: str = DEFAULT_CAPTION_MODEL_DIR

    # Training model storage / Fizgig-compatible model paths.
    training_model_dir: str = DEFAULT_TRAINING_MODEL_DIR
    krea2_raw_dit: str = ""
    krea2_text_encoder: str = ""
    krea2_vae: str = ""
    krea2_turbo_lora: str = ""
    krea2_turbo_dit: str = ""
    base_dit: str = ""
    text_encoder: str = ""
    vae: str = ""
    distilled_dit: str = ""

    # Generic experiment tracking. Run-specific names are resolved by the training harness.
    log_with: str = "all"
    wandb_api_key: str = ""
    wandb_entity: str = ""
    wandb_project: str = "fizgig"
    wandb_run_pattern: str = DEFAULT_WANDB_RUN_PATTERN


def _settings_path() -> Path:
    raw = os.environ.get("FIZGIG_WEB_SETTINGS", "/workspace/fizgig-web/preferences.json")
    return Path(raw).expanduser()


def load_settings() -> AppSettings:
    env_wandb_key = os.environ.get("WANDB_API_KEY", "")
    settings = AppSettings(
        qwen_caption_model=os.environ.get("FIZGIG_QWEN_CAPTION_MODEL", DEFAULT_QWEN_CAPTION_MODEL),
        qwen_caption_processor=os.environ.get("FIZGIG_QWEN_CAPTION_PROCESSOR", ""),
        qwen_caption_revision=os.environ.get("FIZGIG_QWEN_CAPTION_REVISION", ""),
        caption_model_dir=os.environ.get("FIZGIG_CAPTION_MODEL_DIR", DEFAULT_CAPTION_MODEL_DIR),
        training_model_dir=os.environ.get("FIZGIG_TRAINING_MODEL_DIR", DEFAULT_TRAINING_MODEL_DIR),
        wandb_api_key=env_wandb_key,
        wandb_entity=os.environ.get("WANDB_ENTITY", ""),
        wandb_project=os.environ.get("WANDB_PROJECT", "fizgig"),
        wandb_run_pattern=os.environ.get("FIZGIG_WANDB_RUN_PATTERN", DEFAULT_WANDB_RUN_PATTERN),
        log_with=os.environ.get("FIZGIG_LOG_WITH", "all"),
    )
    path = _settings_path()
    if not path.is_file():
        return settings
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return settings
    for key in asdict(settings):
        value = data.get(key)
        if not isinstance(value, str):
            continue
        # An explicitly configured pod secret remains authoritative when the stored
        # preference is blank. This lets users keep WANDB_API_KEY out of preferences.json.
        if key == "wandb_api_key" and not value.strip() and env_wandb_key:
            continue
        setattr(settings, key, value)
    return settings


def save_settings(values: dict[str, Any]) -> AppSettings:
    current = load_settings()
    for key in asdict(current):
        value = values.get(key)
        if isinstance(value, str):
            setattr(current, key, value.strip())
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(current), indent=2) + "\n", encoding="utf-8")
    return current


def settings_dict() -> dict[str, str]:
    return asdict(load_settings())
