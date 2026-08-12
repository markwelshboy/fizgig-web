from __future__ import annotations

import gc
import os
import random
import sys
import threading
from pathlib import Path
from typing import Any

from .settings import load_settings

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

# These are fallbacks only. If upstream Fizgig is installed, its CAPTION_TASKS remains the
# source of truth for prompt presets. The caption VLM itself is intentionally independent from
# Fizgig's Krea/Klein training text encoder.
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


def _clean_qwen_caption(value: str) -> str:
    """Normalize whitespace and remove common image-description preambles."""
    text = " ".join(value.strip().split())
    for _ in range(3):
        lower = text.lower()
        matched = False
        for prefix in (
            "this image shows ",
            "this image depicts ",
            "this image features ",
            "the image shows ",
            "the image depicts ",
            "the photo shows ",
            "the photograph shows ",
            "in this image, ",
            "in this photo, ",
            "in the image, ",
            "we see ",
            "here we see ",
        ):
            if lower.startswith(prefix):
                text = text[len(prefix):].lstrip(" ,:-")
                matched = True
                break
        if not matched:
            break
    return text


def _cap_qwen_image(image, megapixels: float = 1.0):
    from PIL import Image

    image = image.convert("RGB")
    cap = int(megapixels * 1024 * 1024)
    width, height = image.size
    if width > 0 and height > 0 and width * height > cap:
        scale = (cap / (width * height)) ** 0.5
        image = image.resize(
            (max(1, round(width * scale)), max(1, round(height * scale))),
            Image.Resampling.LANCZOS,
        )
    return image


def download_qwen_snapshot(repo_id: str, *, revision: str = "", model_dir: str = "") -> str:
    """Download an arbitrary Hugging Face Qwen3-VL checkpoint to a persistent local directory."""
    if not repo_id.strip() or Path(repo_id).expanduser().exists():
        raise ValueError("Download expects a Hugging Face repository ID, not a local path")
    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:
        raise RuntimeError("huggingface_hub is required for model downloads") from exc

    settings = load_settings()
    root = Path(model_dir or settings.caption_model_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    local = root / repo_id.strip().replace("/", "--")
    resolved = snapshot_download(
        repo_id=repo_id.strip(),
        revision=revision.strip() or None,
        local_dir=str(local),
    )
    return str(Path(resolved).resolve())


class CaptionService:
    """Lazy process-local caption model cache, independent from training encoders."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._florence_model = None
        self._florence_processor = None
        self._florence_device = None
        self._florence_name = None
        self._qwen_model = None
        self._qwen_processor = None
        self._qwen_key: tuple[str, str, str] | None = None

    def options(self) -> dict[str, Any]:
        settings = load_settings()
        return {
            "providers": [
                {
                    "id": "qwen",
                    "name": "Qwen3-VL",
                    "tasks": qwen_tasks(),
                    "default_task": "training",
                    "default_model": settings.qwen_caption_model,
                    "default_processor": settings.qwen_caption_processor,
                    "default_revision": settings.qwen_caption_revision,
                    "supports_instruction_override": True,
                    "supports_arbitrary_model": True,
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
        processor: str | None = None,
        revision: str | None = None,
        task: str | None = None,
        instruction: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        with self._lock:
            if provider == "qwen":
                return self._generate_qwen(
                    image_path,
                    model_source=(model_path or model or "").strip(),
                    processor_source=(processor or "").strip(),
                    revision=(revision or "").strip(),
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
        model_source: str,
        processor_source: str,
        revision: str,
        task: str,
        instruction: str | None,
        max_tokens: int | None,
    ) -> str:
        settings = load_settings()
        model_source = model_source or settings.qwen_caption_model
        processor_source = processor_source or settings.qwen_caption_processor or model_source
        revision = revision or settings.qwen_caption_revision
        if not model_source:
            raise RuntimeError("Qwen caption model is not configured in Preferences")

        try:
            import torch
            from PIL import Image
            from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
        except Exception as exc:
            raise RuntimeError(
                "Qwen3-VL captioning requires torch, Pillow and a Transformers version with Qwen3-VL support"
            ) from exc

        allow_cpu = os.environ.get("FIZGIG_ALLOW_CPU_QWEN", "").strip().lower() in {"1", "true", "yes", "on"}
        if not torch.cuda.is_available() and not allow_cpu:
            raise RuntimeError(
                "Qwen3-VL caption generation requires a CUDA GPU in this runtime. "
                "Run caption generation on a GPU pod; set FIZGIG_ALLOW_CPU_QWEN=1 only if you intentionally want CPU generation."
            )

        key = (model_source, processor_source, revision)
        if self._qwen_model is None or self._qwen_key != key:
            self._drop_qwen()
            model_kwargs: dict[str, Any] = {
                "revision": revision or None,
                "torch_dtype": torch.bfloat16 if torch.cuda.is_available() else torch.float32,
            }
            if torch.cuda.is_available():
                model_kwargs["device_map"] = "auto"
            self._qwen_processor = AutoProcessor.from_pretrained(
                processor_source,
                revision=revision or None,
            )
            self._qwen_model = Qwen3VLForConditionalGeneration.from_pretrained(
                model_source,
                **model_kwargs,
            ).eval()
            if not torch.cuda.is_available():
                self._qwen_model = self._qwen_model.to("cpu")
            self._qwen_key = key

        tasks = qwen_tasks()
        preset = tasks.get(task, tasks.get("training", FALLBACK_QWEN_TASKS["training"]))
        resolved_instruction = (instruction or "").strip() or str(preset["instruction"])
        resolved_tokens = max_tokens or int(preset["max_tokens"])

        image = _cap_qwen_image(Image.open(image_path), 1.0)
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": resolved_instruction},
                ],
            }
        ]
        prompt = self._qwen_processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=False,
        )
        inputs = self._qwen_processor(
            text=[prompt],
            images=[image],
            return_tensors="pt",
        )
        inputs.pop("token_type_ids", None)
        device = getattr(self._qwen_model, "device", None)
        if device is not None:
            inputs = inputs.to(device)

        cpu_state = torch.random.get_rng_state()
        cuda_states = torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None
        try:
            torch.manual_seed(random.randint(1, 2**31 - 1))
            with torch.no_grad():
                generated = self._qwen_model.generate(
                    **inputs,
                    max_new_tokens=resolved_tokens,
                    do_sample=True,
                    temperature=0.5,
                    top_p=0.9,
                )
        finally:
            torch.random.set_rng_state(cpu_state)
            if cuda_states is not None:
                torch.cuda.set_rng_state_all(cuda_states)

        prompt_length = inputs["input_ids"].shape[1]
        decoded = self._qwen_processor.batch_decode(
            generated[:, prompt_length:],
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )
        return _clean_qwen_caption(str(decoded[0]))

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
            kwargs: dict[str, Any] = {"revision": revision, "trust_remote_code": True}
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
            if self._qwen_model is not None:
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
        self._qwen_model = None
        self._qwen_processor = None
        self._qwen_key = None

    def _drop_florence(self) -> None:
        self._florence_model = None
        self._florence_processor = None
        self._florence_device = None
        self._florence_name = None


caption_service = CaptionService()
