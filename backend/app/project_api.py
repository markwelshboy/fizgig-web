from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field
from .captioning import add_trigger, caption_service
from .image_prep import image_prep_store
from .prepared_derivatives import prepared_derivative_service
from .project_captions import project_caption_store
from .project_policy import project_policy_store
from .projects import project_store

router = APIRouter(prefix="/api/projects", tags=["projects"])

class ProjectCreate(BaseModel): name: str; source_path: str; trigger_word: str = ""; description: str = ""; selected_filenames: list[str] = Field(default_factory=list)
class RevisionCreate(BaseModel): name: str; model_family: str = "generic"; parent_revision: str | None = None; import_id: str | None = None
class RunCreate(BaseModel): name: str; model_family: str; dataset_revision: str; trigger_word: str = ""; config: dict[str, Any] = Field(default_factory=dict)
class RunEventCreate(BaseModel): type: str; payload: dict[str, Any] = Field(default_factory=dict)
class ArtifactCreate(BaseModel): type: str; path: str; metadata: dict[str, Any] = Field(default_factory=dict)
class ProjectCaptionUpdate(BaseModel): caption: str; reason: str = "manual_edit"; metadata: dict[str, Any] = Field(default_factory=dict); materialize: bool = False; run_id: str | None = None
class ProjectCaptionGenerate(BaseModel): provider: str = "qwen"; model: str | None = None; model_path: str | None = None; processor: str | None = None; revision: str | None = None; task: str | None = None; instruction: str | None = None; max_tokens: int | None = Field(default=None, ge=16, le=1024); trigger_word: str = ""; add_trigger_word: bool = True; save: bool = False
class CaptionValidationPolicyUpdate(BaseModel): protected_phrases: list[str] | None = None; spellcheck_enabled: bool | None = None; accepted_words: list[str] | None = None
class AssetPolicyUpdate(BaseModel): training_policy: str | None = None; auto_recaption_policy: str | None = None
class InclusionUpdate(BaseModel): filenames: list[str] = Field(default_factory=list); included: bool
class PrepOperationCreate(BaseModel): filenames: list[str] = Field(default_factory=list); operation: dict[str, Any] = Field(default_factory=dict)
class TransformUpdate(BaseModel): transform: dict[str, Any] = Field(default_factory=dict)
class AssetTransformUpdate(BaseModel): override: dict[str, Any] = Field(default_factory=dict)
class TrainingResolutionUpdate(BaseModel): policy: dict[str, Any] = Field(default_factory=dict)
class ManualCropCreate(BaseModel): filename: str; aspect_ratio: str = "1:1"; crop: dict[str, float] = Field(default_factory=dict)
class FaceCropProposalRequest(BaseModel): filenames: list[str] = Field(default_factory=list); aspect_ratio: str = "1:1"; padding_percent: float = Field(default=60.0, ge=0, le=400)
class FaceCropAcceptRequest(BaseModel): proposals: list[dict[str, Any]] = Field(default_factory=list)

def _not_found(exc: Exception) -> HTTPException: return HTTPException(status_code=404, detail=str(exc))

def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

def _restrict_project_to_selection(result: dict[str, Any], selected: list[str]) -> dict[str, Any]:
    """Creation snapshots the source first; this reduces that snapshot and initial project assets to the user's explicit selection."""
    if not selected:
        return result
    wanted = set(selected)
    project = result["project"]
    revision = result["revision"]
    project_dir = project_store.project_dir(project["id"])
    import_id = project["current_import"]
    import_dir = project_dir / "imports" / import_id
    import_manifest_path = import_dir / "manifest.json"
    import_manifest = json.loads(import_manifest_path.read_text(encoding="utf-8"))
    available = {a["filename"] for a in import_manifest.get("assets", [])}
    unknown = wanted - available
    if unknown:
        raise ValueError(f"Selected source assets are not present: {', '.join(sorted(unknown))}")
    if not wanted:
        raise ValueError("Select at least one source asset")

    def prune_files(files_dir: Path) -> None:
        for path in files_dir.iterdir():
            if not path.is_file():
                continue
            selected_stems = {Path(name).stem for name in wanted}
            if path.suffix.lower() == ".txt":
                keep = path.stem in selected_stems
            else:
                keep = path.name in wanted
            if not keep:
                path.unlink()

    import_manifest["assets"] = [a for a in import_manifest.get("assets", []) if a["filename"] in wanted]
    import_manifest["image_count"] = len(import_manifest["assets"])
    prune_files(Path(import_manifest["files_path"]))
    _write_json(import_manifest_path, import_manifest)

    revision_dir = project_dir / "datasets" / revision["id"]
    revision_manifest_path = revision_dir / "manifest.json"
    revision_manifest = json.loads(revision_manifest_path.read_text(encoding="utf-8"))
    revision_manifest["assets"] = [a for a in revision_manifest.get("assets", []) if a["filename"] in wanted]
    prune_files(Path(revision_manifest["files_path"]))
    _write_json(revision_manifest_path, revision_manifest)

    project_path = project_dir / "project.json"
    persisted = json.loads(project_path.read_text(encoding="utf-8"))
    for item in persisted.get("imports", []):
        if item["id"] == import_id: item["image_count"] = len(wanted)
    for item in persisted.get("dataset_revisions", []):
        if item["id"] == revision["id"]: item["image_count"] = len(wanted)
    _write_json(project_path, persisted)
    return {"project": project_store.get_project(project["id"]), "revision": project_store.get_revision(project["id"], revision["id"])}

@router.get("")
def list_projects(): return project_store.list_projects()
@router.post("")
def create_project(request: ProjectCreate):
    try:
        if request.selected_filenames == []: raise ValueError("Select at least one source asset")
        result = project_store.create_project(name=request.name, source_path=request.source_path, trigger_word=request.trigger_word, description=request.description)
        return _restrict_project_to_selection(result, request.selected_filenames)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
@router.get("/{project_id}")
def get_project(project_id: str):
    try: return project_store.get_project(project_id)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.post("/{project_id}/revisions")
def create_revision(project_id: str, request: RevisionCreate):
    try: return project_store.create_revision(project_id, name=request.name, model_family=request.model_family, parent_revision=request.parent_revision, import_id=request.import_id)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
@router.get("/{project_id}/revisions/{revision_id}")
def get_revision(project_id: str, revision_id: str):
    try: return project_store.get_revision(project_id, revision_id)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.get("/{project_id}/revisions/{revision_id}/policy")
def get_revision_policy(project_id: str, revision_id: str):
    try: return project_policy_store.get(project_id, revision_id)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.put("/{project_id}/revisions/{revision_id}/policy/caption-validation")
def update_caption_validation_policy(project_id: str, revision_id: str, request: CaptionValidationPolicyUpdate):
    try:
        return project_policy_store.update_validation(project_id, revision_id, protected_phrases=request.protected_phrases, spellcheck_enabled=request.spellcheck_enabled, accepted_words=request.accepted_words)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
@router.put("/{project_id}/revisions/{revision_id}/policy/assets/{filename}")
def update_asset_policy(project_id: str, revision_id: str, filename: str, request: AssetPolicyUpdate):
    try:
        return project_policy_store.update_asset(project_id, revision_id, filename, training_policy=request.training_policy, auto_recaption_policy=request.auto_recaption_policy)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
@router.get("/{project_id}/revisions/{revision_id}/prep")
def get_image_prep_state(project_id: str, revision_id: str):
    try: return image_prep_store.state(project_id, revision_id)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.put("/{project_id}/revisions/{revision_id}/prep/inclusion")
def update_image_inclusion(project_id: str, revision_id: str, request: InclusionUpdate):
    try: return image_prep_store.set_inclusion(project_id, revision_id, request.filenames, request.included)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.put("/{project_id}/revisions/{revision_id}/prep/inclusion-all")
def update_all_image_inclusion(project_id: str, revision_id: str, request: InclusionUpdate):
    try: return image_prep_store.set_all_inclusion(project_id, revision_id, request.included)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.put("/{project_id}/revisions/{revision_id}/prep/global-transform")
def update_global_transform(project_id: str, revision_id: str, request: TransformUpdate):
    try: return image_prep_store.set_global_transform(project_id, revision_id, request.transform)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.put("/{project_id}/revisions/{revision_id}/prep/training-resolution")
def update_training_resolution(project_id: str, revision_id: str, request: TrainingResolutionUpdate):
    try: return image_prep_store.set_training_resolution(project_id, revision_id, request.policy)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except (TypeError, ValueError) as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
@router.put("/{project_id}/revisions/{revision_id}/prep/assets/{filename}/transform")
def update_asset_transform(project_id: str, revision_id: str, filename: str, request: AssetTransformUpdate):
    try: return image_prep_store.set_asset_transform(project_id, revision_id, filename, request.override)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.get("/{project_id}/revisions/{revision_id}/prep/assets/{filename}/prepared-preview")
def prepared_asset_preview(project_id: str, revision_id: str, filename: str):
    try: return Response(content=prepared_derivative_service.preview_png(project_id, revision_id, filename), media_type="image/png", headers={"Cache-Control": "no-store"})
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
@router.delete("/{project_id}/revisions/{revision_id}/prep/assets/{filename}")
def delete_derivative(project_id: str, revision_id: str, filename: str):
    try: return prepared_derivative_service.delete_derivative(project_id, revision_id, filename)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
@router.post("/{project_id}/revisions/{revision_id}/prep/manual-crops")
def create_manual_crop(project_id: str, revision_id: str, request: ManualCropCreate):
    try: return prepared_derivative_service.create_manual_crop(project_id, revision_id, request.filename, request.crop, request.aspect_ratio)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
@router.post("/{project_id}/revisions/{revision_id}/prep/face-crops/propose")
def propose_face_crops(project_id: str, revision_id: str, request: FaceCropProposalRequest):
    try: return prepared_derivative_service.propose_face_crops(project_id, revision_id, request.filenames, request.aspect_ratio, request.padding_percent)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
@router.post("/{project_id}/revisions/{revision_id}/prep/face-crops/accept")
def accept_face_crops(project_id: str, revision_id: str, request: FaceCropAcceptRequest):
    try: return prepared_derivative_service.accept_face_crops(project_id, revision_id, request.proposals)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
@router.post("/{project_id}/revisions/{revision_id}/prep/operations")
def queue_image_prep_operation(project_id: str, revision_id: str, request: PrepOperationCreate):
    try: return image_prep_store.append_operation(project_id, revision_id, request.filenames, request.operation)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.get("/{project_id}/revisions/{revision_id}/captions/{filename}")
def get_project_caption(project_id: str, revision_id: str, filename: str):
    try: return project_caption_store.get_caption(project_id, revision_id, filename)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.post("/{project_id}/revisions/{revision_id}/captions/{filename}/generate")
def generate_project_caption(project_id: str, revision_id: str, filename: str, request: ProjectCaptionGenerate):
    try:
        prepared_png = prepared_derivative_service.preview_png(project_id, revision_id, filename)
        with tempfile.NamedTemporaryFile(suffix=".png") as temp:
            temp.write(prepared_png)
            temp.flush()
            caption = caption_service.generate(provider=request.provider, image_path=Path(temp.name), model=request.model, model_path=request.model_path, processor=request.processor, revision=request.revision, task=request.task, instruction=request.instruction, max_tokens=request.max_tokens)
        if request.add_trigger_word:
            caption = add_trigger(caption, request.trigger_word)
        return {"filename": filename, "caption": caption, "saved": False, "provider": request.provider, "prepared_asset": True}
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc: raise HTTPException(status_code=500, detail=f"Caption generation failed: {type(exc).__name__}: {exc}") from exc
@router.put("/{project_id}/revisions/{revision_id}/captions/{filename}")
def update_project_caption(project_id: str, revision_id: str, filename: str, request: ProjectCaptionUpdate):
    try: return project_caption_store.set_caption(project_id, revision_id, filename, request.caption, reason=request.reason, metadata=request.metadata, materialize=request.materialize, run_id=request.run_id)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
@router.post("/{project_id}/revisions/{revision_id}/materialize-captions")
def materialize_project_captions(project_id: str, revision_id: str):
    try: return project_caption_store.materialize_revision(project_id, revision_id)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.post("/{project_id}/runs")
def create_run(project_id: str, request: RunCreate):
    try:
        project_caption_store.materialize_revision(project_id, request.dataset_revision)
        run = project_store.create_run(project_id, name=request.name, model_family=request.model_family, dataset_revision=request.dataset_revision, trigger_word=request.trigger_word, config=request.config)
        run = image_prep_store.materialize_run_dataset(project_id, request.dataset_revision, run)
        project_policy_store.materialize_for_run(project_id, request.dataset_revision, run)
        return run
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
@router.get("/{project_id}/runs/{run_id}")
def get_run(project_id: str, run_id: str):
    try: return project_store.get_run(project_id, run_id)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
@router.post("/{project_id}/runs/{run_id}/events")
def append_run_event(project_id: str, run_id: str, request: RunEventCreate):
    try: return project_store.append_run_event(project_id, run_id, request.type, request.payload)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc
@router.post("/{project_id}/runs/{run_id}/artifacts")
def register_artifact(project_id: str, run_id: str, request: ArtifactCreate):
    try: return project_store.register_artifact(project_id, run_id, artifact_type=request.type, path=request.path, metadata=request.metadata)
    except FileNotFoundError as exc: raise _not_found(exc) from exc
    except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc)) from exc