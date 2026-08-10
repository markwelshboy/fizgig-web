from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

DEFAULT_QWEN_CAPTION_MODEL = "Qwen/Qwen3-VL-8B-Instruct"
DEFAULT_CAPTION_MODEL_DIR = "/workspace/Fizgig/models/captioning"


@dataclass
class AppSettings:
    qwen_caption_model: str = DEFAULT_QWEN_CAPTION_MODEL
    qwen_caption_processor: str = ""
    qwen_caption_revision: str = ""
    caption_model_dir: str = DEFAULT_CAPTION_MODEL_DIR


def _settings_path() -> Path:
    raw = os.environ.get("FIZGIG_WEB_SETTINGS", "/workspace/fizgig-web/preferences.json")
    return Path(raw).expanduser()


def load_settings() -> AppSettings:
    settings = AppSettings(
        qwen_caption_model=os.environ.get("FIZGIG_QWEN_CAPTION_MODEL", DEFAULT_QWEN_CAPTION_MODEL),
        qwen_caption_processor=os.environ.get("FIZGIG_QWEN_CAPTION_PROCESSOR", ""),
        qwen_caption_revision=os.environ.get("FIZGIG_QWEN_CAPTION_REVISION", ""),
        caption_model_dir=os.environ.get("FIZGIG_CAPTION_MODEL_DIR", DEFAULT_CAPTION_MODEL_DIR),
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
        if isinstance(value, str):
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
