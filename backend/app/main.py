from __future__ import annotations

import base64
import hashlib
import hmac
import os
import platform
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .captioning import add_trigger, caption_service, download_qwen_snapshot
from .project_api import router as project_router
from .settings import save_settings, settings_dict
from . import image_prep as image_prep_module
from .crop_geometry import crop_box as scalable_crop_box
from .prepared_derivatives import _effective_transform as prepared_effective_transform

# Image-prep functions resolve these helpers dynamically. Patch in the shared
# scalable crop geometry and baked-derivative-aware transform semantics so
# previews, analysis, and run materialization stay consistent.
image_prep_module._crop_box = scalable_crop_box
image_prep_module._effective_transform = prepared_effective_transform

app = FastAPI(title="Fizgig Web API", version="0.1.0")
app.include_router(project_router)

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".jxl"}
_DATASETS: dict[str, Path] = {}


@app.middleware("http")
async def optional_basic_auth(request: Request, call_next):
    """Protect a public pod proxy when FIZGIG_WEB_PASSWORD is configured.

    Runpod's HTTP proxy is public. Basic auth keeps the single-service pod usable
    from an ordinary browser without requiring a separate login UI. Local dev is
    unchanged because no password is configured by docker-compose.local.yml.
    """
    password = os.environ.get("FIZGIG_WEB_PASSWORD", "")
    if not password or request.url.path == "/api/health":
        return await call_next(request)

    username = os.environ.get("FIZGIG_WEB_USERNAME", "fizgig")
    authorization = request.headers.get("authorization", "")
    supplied_user = ""
    supplied_password = ""
    if authorization.startswith("Basic "):
        try:
            decoded = base64.b64decode(authorization[6:], validate=True).decode("utf-8")
            supplied_user, supplied_password = decoded.split(":", 1)
        except (ValueError, UnicodeDecodeError):
            pass

    if hmac.compare_digest(supplied_user, username) and hmac.compare_digest(supplied_password, password):
        return await call_next(request)

    return Response(
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="Fizgig Web"'},
        content="Authentication required",
    )


class DatasetRequest(BaseModel):
    path: str


class CaptionUpdate(BaseModel):
    caption: str


class CaptionGenerateRequest(BaseModel):
    provider: str = "qwen"
    model: str | None = None
    model_path: str | None = None
    processor: str | None = None
    revision: str | None = None
    task: str | None = None
    instruction: str | None = None
    max_tokens: int | None = Field(default=None, ge=16, le=1024)
    trigger_word: str = ""
    add_trigger_word: bool = True
    save: bool = False


class PreferencesUpdate(BaseModel):
    qwen_caption_model: str | None = None
    qwen_caption_processor: str | None = None
    qwen_caption_revision: str | None = None
    caption_model_dir: str | None = None


class ModelDownloadRequest(BaseModel):
    repo_id: str
    revision: str = ""
    model_dir: str = ""
    use_as_qwen_caption_model: bool = True


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


@app.get("/api/runtime")
def runtime_status() -> dict[str, object]:
    """Small deployment probe for GPU pods before a model is loaded."""
    result: dict[str, object] = {
        "python": platform.python_version(),
        "workspace": str(Path("/workspace").resolve()),
        "fizgig_root": os.environ.get("FIZGIG_ROOT", ""),
        "static_dir": os.environ.get("FIZGIG_WEB_STATIC_DIR", ""),
    }
    try:
        import torch

        cuda_available = bool(torch.cuda.is_available())
        result.update({
            "torch": torch.__version__,
            "torch_cuda": torch.version.cuda,
            "cuda_available": cuda_available,
            "cuda_device_count": torch.cuda.device_count() if cuda_available else 0,
            "cuda_device": torch.cuda.get_device_name(0) if cuda_available else None,
        })
    except Exception as exc:
        result.update({"cuda_available": False, "torch_error": f"{type(exc).__name__}: {exc}"})
    return result


@app.get("/api/model-families")
def model_families() -> list[dict[str, object]]:
    return [
        {"id": "krea2", "name": "Krea 2", "features": {"per_image_loss": True, "per_image_lr": True, "auto_recaption": True}},
        {"id": "klein", "name": "Klein 9B", "features": {"per_image_loss": False, "per_image_lr": False, "auto_recaption": False}},
    ]


@app.get("/api/preferences")
def get_preferences() -> dict[str, str]:
    return settings_dict()


@app.put("/api/preferences")
def update_preferences(update: PreferencesUpdate) -> dict[str, str]:
    current = save_settings(update.model_dump(exclude_none=True))
    caption_service.unload()
    return {
        "qwen_caption_model": current.qwen_caption_model,
        "qwen_caption_processor": current.qwen_caption_processor,
        "qwen_caption_revision": current.qwen_caption_revision,
        "caption_model_dir": current.caption_model_dir,
    }


@app.post("/api/models/qwen/download")
def download_qwen_model(request: ModelDownloadRequest) -> dict[str, object]:
    try:
        path = download_qwen_snapshot(request.repo_id, revision=request.revision, model_dir=request.model_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Model download failed: {type(exc).__name__}: {exc}") from exc

    if request.use_as_qwen_caption_model:
        save_settings({
            "qwen_caption_model": path,
            "qwen_caption_processor": "",
            "qwen_caption_revision": "",
            **({"caption_model_dir": request.model_dir} if request.model_dir else {}),
        })
        caption_service.unload()
    return {"repo_id": request.repo_id, "path": path, "selected": request.use_as_qwen_caption_model}


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

    images = sorted((path for path in dataset.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS), key=lambda path: path.name.lower())
    if not images:
        raise HTTPException(status_code=400, detail="No supported images found in dataset folder")

    dataset_id = _dataset_id(dataset)
    _DATASETS[dataset_id] = dataset
    records = [_image_record(dataset_id, image) for image in images]
    caption_count = sum(1 for record in records if record["has_caption"])
    return {"id": dataset_id, "path": str(dataset), "image_count": len(records), "caption_count": caption_count, "missing_caption_count": len(records) - caption_count, "images": records}


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
    return {"filename": image.name, "caption": caption_path.read_text(encoding="utf-8").strip() if caption_path.is_file() else ""}


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
            processor=request.processor,
            revision=request.revision,
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

    return {"filename": image.name, "caption": caption, "saved": request.save, "provider": request.provider}


# In the Runpod image the Vite build is copied into FIZGIG_WEB_STATIC_DIR and
# FastAPI becomes the single origin for both UI and API. Local development does
# not set this variable, so Vite continues to serve the UI and proxy /api.
_static_raw = os.environ.get("FIZGIG_WEB_STATIC_DIR", "").strip()
if _static_raw:
    _static_root = Path(_static_raw).expanduser().resolve()
    _index = _static_root / "index.html"
    if _index.is_file():
        @app.get("/{web_path:path}", include_in_schema=False)
        def serve_web_app(web_path: str) -> FileResponse:
            if web_path.startswith("api/"):
                raise HTTPException(status_code=404, detail="API route not found")
            candidate = (_static_root / web_path).resolve()
            if candidate.is_file() and candidate.is_relative_to(_static_root):
                return FileResponse(candidate)
            return FileResponse(_index)
