from __future__ import annotations

import gc
import os
import sys
import threading
from pathlib import Path
from typing import Any

FLORENCE_DEFAULT_MODEL = "MiaoshouAI/Florence-2-base-PromptGen"
FLORENCE_MODELS = [
    FLORENCE_DEFAULT_MODEL,
    "microsoft/Florence-2-base",
    "microsoft/Florence-2-large",
]
FLORENCE_REVISIONS = {
    "MiaoshouAI/Florence-2-base-PromptGen": "da7ac9f3deac56a928e2fd4d94d8bb985d231299",
    "microsoft/Florence-2-base": "5ca5edf5bd017b9919c05d08aebef5e4c7ac3bac",
    "microsoft/Florence-2-large": "21a599d414c4d928c9032694c424fb94458e3594",
}
FLORENCE_CODE_REVISIONS = {
    "MiaoshouAI/Florence-2-base-PromptGen": "f6c1a25888ffc1d945ee8a1a77ac833c7303d46e",
}
FLORENCE_TASKS = ["<CAPTION>", "<DETAILED_CAPTION>", "<MORE_DETAILED_CAPTION>"]

# Fallbacks only. When upstream Fizgig is available we read CAPTION_TASKS directly from it so
# fizgig-web cannot silently drift from the trainer's auto-recaption doctrine.
FALLBACK_QWEN_TASKS = {
    "training": {
        "label": "Training caption (viewpoint-aware)",
        "max_tokens": 120,
        "instruction": (
            "Write one factual training caption for this image as a single sentence, covering these in order: "
            "the subject and what they are doing; the camera viewpoint and whether the face is visible; their pose; "
            "their clothing; the setting; the lighting. Name the subject specifically when visually apparent, begin "
            "directly with the subject, name prominent unusual framing or hidden/cropped details, and state only what "
            "is visible. No speculation, proper names, style or quality commentary."
        ),
    },
    "short": {
        "label": "Short caption",
        "max_tokens": 60,
        "instruction": "Write one short factual caption naming the subject, what they are doing, and the setting.",
    },
    "detailed": {
        "label": "Detailed description",
        "max_tokens": 160,
        "instruction": "Describe the image in 2-3 factual sentences, starting with the subject, pose, clothing, viewpoint, lighting, and setting.",
    },
    "exhaustive": {
        "label": "Exhaustive detail",
        "max_tokens": 240,
        "instruction": "Write a detailed factual training caption in 2-4 sentences covering every visually salient subject, pose, clothing, viewpoint, crop, lighting, object and background detail.",
    },
    "style": {
        "label": "Style — contents only (trigger word names the style)",
        "max_tokens": 160,
        "instruction": "Describe the image with zero references to the image style, just the factual contents of what is depicted.",
    },
}


def _ensure_fizgig_importable() -> None:
    candidates = [
        os.environ.get("FIZGIG_ROOT", ""),
        "/opt/Fizgig",
        "/workspace/Fizgig",
        str(Path(__file__).resolve().parents[3] / "Fizgig"),
    ]
    for raw in candidates:
        if not raw:
            continue
        src = Path(raw).expanduser().resolve() / "src"
        if (src / "fizgig").is_dir():
            value = str(src)
            if value not in sys.path:
                sys.path.insert(0, value)
            return


def qwen_tasks() -> dict[str, dict[str, Any]]:
    _ensure_fizgig_importable()
    try:
        from fizgig.krea2.embedder import CAPTION_TASKS

        return {
            key: {"label": label, "instruction": instruction, "max_tokens": max_tokens}
            for key, (label, instruction, max_tokens) in CAPTION_TASKS.items()
        }
    except Exception:
        return FALLBACK_QWEN_TASKS


def add_trigger(caption: str, trigger_word: str) -> str:
    caption = " ".join(caption.strip().split())
    trigger_word = trigger_word.strip()
    if not trigger_word:
        return caption
    if caption.lower().startswith(trigger_word.lower()):
        return caption
    return f"{trigger_word}, {caption}" if caption else trigger_word


class CaptionService:
    """Lazy, process-local caption model cache.

    Generation is serialized because both providers own substantial GPU state. Keeping models
    resident makes iterative Regenerate and Generate Missing useful; unload() is available before
    training when VRAM needs to be reclaimed.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._florence_model = None
        self._florence_processor = None
        self._florence_device = None
        self._florence_name = None
        self._qwen = None
        self._qwen_path = None

    def options(self) -> dict[str, Any]:
        return {
            "providers": [
                {
                    "id": "qwen",
                    "name": "Qwen3-VL 4B",
                    "tasks": qwen_tasks(),
                    "default_task": "training",
                    "supports_instruction_override": True,
                },
                {
                    "id": "florence",
                    "name": "Florence-2",
                    "models": FLORENCE_MODELS,
                    "default_model": FLORENCE_DEFAULT_MODEL,
                    "tasks": FLORENCE_TASKS,
                    "default_task": "<DETAILED_CAPTION>",
                    "supports_instruction_override": False,
                },
            ]
        }

    def generate(
        self,
        *,
        provider: str,
        image_path: Path,
        model: str | None = None,
        model_path: str | None = None,
        task: str | None = None,
        instruction: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        with self._lock:
            if provider == "qwen":
                return self._generate_qwen(
                    image_path,
                    model_path=model_path,
                    task=task or "training",
                    instruction=instruction,
                    max_tokens=max_tokens,
                )
            if provider == "florence":
                return self._generate_florence(
                    image_path,
                    model=model or FLORENCE_DEFAULT_MODEL,
                    task=task or "<DETAILED_CAPTION>",
                    max_tokens=max_tokens or 120,
                )
            raise ValueError(f"Unknown caption provider: {provider}")

    def _generate_qwen(
        self,
        image_path: Path,
        *,
        model_path: str | None,
        task: str,
        instruction: str | None,
        max_tokens: int | None,
    ) -> str:
        _ensure_fizgig_importable()
        try:
            import torch
            from fizgig.krea2.embedder import generate_caption
            from fizgig.krea2.utils import load_krea2_text_encoder
        except Exception as exc:
            raise RuntimeError(
                "Qwen captioning requires the upstream Fizgig Python environment. Set FIZGIG_ROOT "
                "to the Fizgig checkout and run this API from its venv/container."
            ) from exc

        resolved_path = (model_path or os.environ.get("FIZGIG_QWEN_CAPTION_MODEL", "")).strip()
        if not resolved_path or not Path(resolved_path).expanduser().is_file():
            raise RuntimeError(
                "Qwen3-VL text-encoder path is not configured. Set it in Preferences or "
                "FIZGIG_QWEN_CAPTION_MODEL."
            )
        resolved_path = str(Path(resolved_path).expanduser().resolve())

        if self._qwen is None or self._qwen_path != resolved_path:
            self._drop_qwen()
            device = "cuda" if torch.cuda.is_available() else "cpu"
            self._qwen = load_krea2_text_encoder(resolved_path, dtype=torch.bfloat16, device=device)
            self._qwen_path = resolved_path

        tasks = qwen_tasks()
        preset = tasks.get(task, tasks.get("training", FALLBACK_QWEN_TASKS["training"]))
        resolved_instruction = (instruction or "").strip() or str(preset["instruction"])
        resolved_tokens = max_tokens or int(preset["max_tokens"])
        return str(
            generate_caption(
                self._qwen,
                str(image_path),
                max_new_tokens=resolved_tokens,
                instruction=resolved_instruction,
            )
        ).strip()

    def _generate_florence(self, image_path: Path, *, model: str, task: str, max_tokens: int) -> str:
        if model not in FLORENCE_MODELS:
            raise RuntimeError(f"Unsupported Florence model: {model}")
        if task not in FLORENCE_TASKS:
            raise RuntimeError(f"Unsupported Florence task: {task}")
        try:
            import torch
            from PIL import Image
            from transformers import AutoModelForCausalLM, AutoProcessor
        except Exception as exc:
            raise RuntimeError("Florence captioning requires torch, Pillow and transformers") from exc

        if self._florence_model is None or self._florence_name != model:
            self._drop_florence()
            device = "cuda" if torch.cuda.is_available() else "cpu"
            revision = FLORENCE_REVISIONS.get(model)
            code_revision = FLORENCE_CODE_REVISIONS.get(model)
            kwargs = {
                "revision": revision,
                "trust_remote_code": True,
            }
            if code_revision:
                kwargs["code_revision"] = code_revision
            self._florence_processor = AutoProcessor.from_pretrained(model, **kwargs)
            self._florence_model = AutoModelForCausalLM.from_pretrained(
                model,
                **kwargs,
                torch_dtype=torch.float16 if device == "cuda" else torch.float32,
                attn_implementation="eager",
            ).to(device)
            self._florence_device = device
            self._florence_name = model

        image = Image.open(image_path).convert("RGB")
        inputs = self._florence_processor(text=task, images=image, return_tensors="pt").to(self._florence_device)
        inputs["pixel_values"] = inputs["pixel_values"].to(self._florence_model.dtype)
        generated = self._florence_model.generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=max_tokens,
            do_sample=False,
            num_beams=3,
            use_cache=False,
        )
        raw = self._florence_processor.batch_decode(generated, skip_special_tokens=False)[0]
        parsed = self._florence_processor.post_process_generation(
            raw,
            task=task,
            image_size=(image.width, image.height),
        )
        return str(parsed.get(task, raw)).strip()

    def unload(self) -> list[str]:
        with self._lock:
            unloaded: list[str] = []
            if self._qwen is not None:
                self._drop_qwen()
                unloaded.append("qwen")
            if self._florence_model is not None:
                self._drop_florence()
                unloaded.append("florence")
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            gc.collect()
            return unloaded

    def _drop_qwen(self) -> None:
        self._qwen = None
        self._qwen_path = None

    def _drop_florence(self) -> None:
        self._florence_model = None
        self._florence_processor = None
        self._florence_device = None
        self._florence_name = None


caption_service = CaptionService()
