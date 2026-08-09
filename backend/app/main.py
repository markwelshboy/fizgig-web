from __future__ import annotations

import hashlib
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .captioning import add_trigger, caption_service

app = FastAPI(title="Fizgig Web API", version="0.1.0")

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".jxl"}
_DATASETS: dict[str, Path] = {}


class DatasetRequest(BaseModel):
    path: str


class CaptionUpdate(BaseModel):
    caption: str


class CaptionGenerateRequest(BaseModel):
    provider: str = "qwen"
    model: str | None = None
    model_path: str | None = None
    task: str | None = None
    instruction: str | None = None
    max_tokens: int | None = Field(default=None, ge=16, le=1024)
    trigger_word: str = ""
    add_trigger_word: bool = True
    save: bool = False


def _dataset_id(path: Path) -> str:
    return hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:16]


def _get_dataset(dataset_id: str) -> Path:
    path = _DATASETS.get(dataset_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Dataset is not registered in this server session")
    return path


def _safe_image(dataset: Path, filename: str) -> Path:
    image = (dataset / filename).resolve()
    if image.parent != dataset or image.suffix.lower() not in IMAGE_EXTENSIONS or not image.is_file():
        raise HTTPException(status_code=404, detail="Image not found in dataset")
    return image


def _write_caption(image: Path, caption: str) -> str:
    cleaned = caption.strip()
    image.with_suffix(".txt").write_text(cleaned + ("\n" if cleaned else ""), encoding="utf-8")
    return cleaned


def _image_record(dataset_id: str, image: Path) -> dict[str, object]:
    caption_path = image.with_suffix(".txt")
    caption = caption_path.read_text(encoding="utf-8").strip() if caption_path.is_file() else ""
    return {
        "filename": image.name,
        "caption": caption,
        "has_caption": bool(caption),
        "image_url": f"/api/datasets/{dataset_id}/images/{quote(image.name)}",
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/model-families")
def model_families() -> list[dict[str, object]]:
    return [
        {
            "id": "krea2",
            "name": "Krea 2",
            "features": {
                "per_image_loss": True,
                "per_image_lr": True,
                "auto_recaption": True,
            },
        },
        {
            "id": "klein",
            "name": "Klein 9B",
            "features": {
                "per_image_loss": False,
                "per_image_lr": False,
                "auto_recaption": False,
            },
        },
    ]


@app.get("/api/captioning/options")
def captioning_options() -> dict[str, object]:
    return caption_service.options()


@app.post("/api/captioning/unload")
def unload_caption_models() -> dict[str, object]:
    return {"unloaded": caption_service.unload()}


@app.post("/api/datasets/inspect")
def inspect_dataset(request: DatasetRequest) -> dict[str, object]:
    dataset = Path(request.path).expanduser().resolve()
    if not dataset.is_dir():
        raise HTTPException(status_code=404, detail=f"Dataset folder does not exist: {dataset}")

    images = sorted(
        (path for path in dataset.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS),
        key=lambda path: path.name.lower(),
    )
    if not images:
        raise HTTPException(status_code=400, detail="No supported images found in dataset folder")

    dataset_id = _dataset_id(dataset)
    _DATASETS[dataset_id] = dataset
    records = [_image_record(dataset_id, image) for image in images]
    caption_count = sum(1 for record in records if record["has_caption"])

    return {
        "id": dataset_id,
        "path": str(dataset),
        "image_count": len(records),
        "caption_count": caption_count,
        "missing_caption_count": len(records) - caption_count,
        "images": records,
    }


@app.get("/api/datasets/{dataset_id}")
def get_dataset(dataset_id: str) -> dict[str, object]:
    dataset = _get_dataset(dataset_id)
    return inspect_dataset(DatasetRequest(path=str(dataset)))


@app.get("/api/datasets/{dataset_id}/images/{filename}")
def get_image(dataset_id: str, filename: str) -> FileResponse:
    dataset = _get_dataset(dataset_id)
    return FileResponse(_safe_image(dataset, filename))


@app.get("/api/datasets/{dataset_id}/captions/{filename}")
def get_caption(dataset_id: str, filename: str) -> dict[str, str]:
    dataset = _get_dataset(dataset_id)
    image = _safe_image(dataset, filename)
    caption_path = image.with_suffix(".txt")
    return {
        "filename": image.name,
        "caption": caption_path.read_text(encoding="utf-8").strip() if caption_path.is_file() else "",
    }


@app.put("/api/datasets/{dataset_id}/captions/{filename}")
def update_caption(dataset_id: str, filename: str, update: CaptionUpdate) -> dict[str, str]:
    dataset = _get_dataset(dataset_id)
    image = _safe_image(dataset, filename)
    return {"filename": image.name, "caption": _write_caption(image, update.caption)}


@app.post("/api/datasets/{dataset_id}/captions/{filename}/generate")
def generate_caption(dataset_id: str, filename: str, request: CaptionGenerateRequest) -> dict[str, object]:
    dataset = _get_dataset(dataset_id)
    image = _safe_image(dataset, filename)
    try:
        caption = caption_service.generate(
            provider=request.provider,
            image_path=image,
            model=request.model,
            model_path=request.model_path,
            task=request.task,
            instruction=request.instruction,
            max_tokens=request.max_tokens,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Caption generation failed: {type(exc).__name__}: {exc}") from exc

    if request.add_trigger_word:
        caption = add_trigger(caption, request.trigger_word)
    if request.save:
        caption = _write_caption(image, caption)

    return {
        "filename": image.name,
        "caption": caption,
        "saved": request.save,
        "provider": request.provider,
    }
