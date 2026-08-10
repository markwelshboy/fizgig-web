from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".jxl"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip()).strip("-._")
    return value or "project"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_caption(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8-sig", errors="replace").strip()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(value, ensure_ascii=False) + "\n")
        f.flush()


class ProjectStore:
    """Portable, file-based provenance store.

    The external dataset is always the user's canonical source and is never modified by Fizgig Web.
    A project stores an immutable import snapshot for reproducibility, plus model-specific scratch
    dataset revisions derived from that snapshot. Scratch revisions are working material only: they
    may be cropped, resized, brightened, recaptioned, extended with face crops, or otherwise changed
    without ever becoming the canonical source.
    """

    def __init__(self, root: str | None = None) -> None:
        self.root = Path(root or os.environ.get("FIZGIG_PROJECTS_ROOT", "/workspace/Fizgig/projects")).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def list_projects(self) -> list[dict[str, Any]]:
        projects: list[dict[str, Any]] = []
        for path in sorted(self.root.iterdir() if self.root.exists() else []):
            meta = path / "project.json"
            if path.is_dir() and meta.is_file():
                try:
                    projects.append(_read_json(meta))
                except Exception:
                    continue
        projects.sort(key=lambda item: item.get("updated_at", item.get("created_at", "")), reverse=True)
        return projects

    def project_dir(self, project_id: str) -> Path:
        path = (self.root / project_id).resolve()
        if path.parent != self.root or not (path / "project.json").is_file():
            raise FileNotFoundError(f"Unknown project: {project_id}")
        return path

    def get_project(self, project_id: str) -> dict[str, Any]:
        return _read_json(self.project_dir(project_id) / "project.json")

    def _save_project(self, project_dir: Path, project: dict[str, Any]) -> None:
        project["updated_at"] = _now()
        _write_json(project_dir / "project.json", project)

    def _event(self, project_dir: Path, event_type: str, **payload: Any) -> dict[str, Any]:
        event = {"time": _now(), "type": event_type, **payload}
        _append_jsonl(project_dir / "events.jsonl", event)
        return event

    def create_project(self, *, name: str, source_path: str, trigger_word: str = "", description: str = "") -> dict[str, Any]:
        external_source = Path(source_path).expanduser().resolve()
        if not external_source.is_dir():
            raise FileNotFoundError(f"Source dataset folder does not exist: {external_source}")
        images = sorted(
            (p for p in external_source.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS),
            key=lambda p: p.name.lower(),
        )
        if not images:
            raise ValueError("Source dataset contains no supported images")

        base = _slug(name)
        project_id = base
        n = 2
        while (self.root / project_id).exists():
            project_id = f"{base}-{n}"
            n += 1

        project_dir = self.root / project_id
        import_id = "import-0001"
        import_dir = project_dir / "imports" / import_id
        import_files = import_dir / "files"
        import_files.mkdir(parents=True)

        assets: list[dict[str, Any]] = []
        for image in images:
            dest_image = import_files / image.name
            shutil.copy2(image, dest_image)
            caption_source = image.with_suffix(".txt")
            caption = _read_caption(caption_source)
            if caption_source.is_file():
                shutil.copy2(caption_source, dest_image.with_suffix(".txt"))
            assets.append({
                "id": uuid.uuid4().hex[:16],
                "filename": image.name,
                "external_source_path": str(image),
                "image_sha256": _sha256(dest_image),
                "caption": caption,
                "caption_sha256": hashlib.sha256(caption.encode("utf-8")).hexdigest(),
                "origin": "external_source_import",
                "parent_asset_id": None,
                "operations": [],
            })

        import_manifest = {
            "id": import_id,
            "created_at": _now(),
            "external_source_path": str(external_source),
            "purpose": "immutable_reproducibility_snapshot",
            "files_path": str(import_files),
            "image_count": len(assets),
            "assets": assets,
        }
        _write_json(import_dir / "manifest.json", import_manifest)

        project = {
            "id": project_id,
            "name": name.strip() or project_id,
            "description": description.strip(),
            "trigger_word": trigger_word.strip(),
            "created_at": _now(),
            "updated_at": _now(),
            "external_source": {
                "path": str(external_source),
                "owned_by_project": False,
                "mutable_by_project": False,
            },
            "imports": [{
                "id": import_id,
                "created_at": import_manifest["created_at"],
                "image_count": len(assets),
                "path": str(import_files),
            }],
            "current_import": import_id,
            "current_dataset_revision": None,
            "current_run": None,
            "dataset_revisions": [],
            "runs": [],
        }
        _write_json(project_dir / "project.json", project)
        self._event(project_dir, "project_created", project_id=project_id, name=project["name"], trigger_word=project["trigger_word"])
        self._event(
            project_dir,
            "external_source_snapshotted",
            external_source_path=str(external_source),
            import_id=import_id,
            image_count=len(assets),
        )

        revision = self.create_revision(
            project_id,
            name="Initial working dataset",
            model_family="generic",
            parent_revision=None,
            import_id=import_id,
        )
        return {"project": self.get_project(project_id), "revision": revision}

    def create_revision(
        self,
        project_id: str,
        *,
        name: str,
        model_family: str,
        parent_revision: str | None = None,
        import_id: str | None = None,
    ) -> dict[str, Any]:
        project_dir = self.project_dir(project_id)
        project = self.get_project(project_id)
        next_num = len(project.get("dataset_revisions", [])) + 1
        revision_id = f"ds-{next_num:04d}"
        revision_dir = project_dir / "datasets" / revision_id
        files_dir = revision_dir / "files"
        files_dir.mkdir(parents=True)

        if parent_revision:
            parent_dir = project_dir / "datasets" / parent_revision
            parent_manifest = _read_json(parent_dir / "manifest.json")
            basis_files = parent_dir / "files"
            assets = parent_manifest["assets"]
            basis = {"type": "dataset_revision", "id": parent_revision}
        else:
            selected_import = import_id or project.get("current_import")
            if not selected_import:
                raise ValueError("Project has no import snapshot")
            import_dir = project_dir / "imports" / selected_import
            import_manifest = _read_json(import_dir / "manifest.json")
            basis_files = import_dir / "files"
            assets = import_manifest["assets"]
            basis = {"type": "import_snapshot", "id": selected_import}

        revision_assets: list[dict[str, Any]] = []
        for asset in assets:
            image_name = asset["filename"]
            src_image = basis_files / image_name
            if not src_image.is_file():
                continue
            dest_image = files_dir / image_name
            shutil.copy2(src_image, dest_image)
            src_caption = src_image.with_suffix(".txt")
            if src_caption.is_file():
                shutil.copy2(src_caption, dest_image.with_suffix(".txt"))
            caption = _read_caption(dest_image.with_suffix(".txt"))
            revision_assets.append({
                **asset,
                "caption": caption,
                "caption_sha256": hashlib.sha256(caption.encode("utf-8")).hexdigest(),
            })

        manifest = {
            "id": revision_id,
            "name": name.strip() or revision_id,
            "model_family": model_family,
            "created_at": _now(),
            "basis": basis,
            "scratch": True,
            "files_path": str(files_dir),
            "assets": revision_assets,
        }
        prep = {
            "revision": revision_id,
            "model_family": model_family,
            "scratch": True,
            "operations": [],
            "notes": "Working dataset only. Never treated as canonical source material.",
        }
        _write_json(revision_dir / "manifest.json", manifest)
        _write_json(revision_dir / "prep.json", prep)

        project["dataset_revisions"].append({
            "id": revision_id,
            "name": manifest["name"],
            "model_family": model_family,
            "basis": basis,
            "created_at": manifest["created_at"],
            "image_count": len(revision_assets),
            "path": str(files_dir),
            "scratch": True,
        })
        project["current_dataset_revision"] = revision_id
        self._save_project(project_dir, project)
        self._event(
            project_dir,
            "dataset_revision_created",
            revision=revision_id,
            name=manifest["name"],
            model_family=model_family,
            basis=basis,
            image_count=len(revision_assets),
            scratch=True,
        )
        return manifest

    def get_revision(self, project_id: str, revision_id: str) -> dict[str, Any]:
        project_dir = self.project_dir(project_id)
        path = (project_dir / "datasets" / revision_id / "manifest.json").resolve()
        if project_dir not in path.parents or not path.is_file():
            raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")
        return _read_json(path)

    def create_run(
        self,
        project_id: str,
        *,
        name: str,
        model_family: str,
        dataset_revision: str,
        trigger_word: str,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        project_dir = self.project_dir(project_id)
        project = self.get_project(project_id)
        revision = self.get_revision(project_id, dataset_revision)
        run_num = len(project.get("runs", [])) + 1
        run_id = f"run-{run_num:04d}"
        run_dir = project_dir / "runs" / run_id
        for child in ("loss_log", "samples", "checkpoints", "state", "artifacts"):
            (run_dir / child).mkdir(parents=True, exist_ok=True)

        snapshot_assets: list[dict[str, Any]] = []
        files_dir = Path(revision["files_path"])
        for asset in revision["assets"]:
            image = files_dir / asset["filename"]
            if not image.is_file():
                continue
            caption = _read_caption(image.with_suffix(".txt"))
            snapshot_assets.append({
                "asset_id": asset.get("id"),
                "filename": asset["filename"],
                "image_sha256": _sha256(image),
                "caption": caption,
                "caption_sha256": hashlib.sha256(caption.encode("utf-8")).hexdigest(),
                "origin": asset.get("origin"),
                "parent_asset_id": asset.get("parent_asset_id"),
                "operations": asset.get("operations", []),
            })

        snapshot = {
            "created_at": _now(),
            "project_id": project_id,
            "run_id": run_id,
            "dataset_revision": dataset_revision,
            "dataset_is_scratch": True,
            "image_count": len(snapshot_assets),
            "assets": snapshot_assets,
        }
        _write_json(run_dir / "dataset_snapshot.json", snapshot)

        run = {
            "id": run_id,
            "name": name.strip() or run_id,
            "created_at": _now(),
            "status": "prepared",
            "project_id": project_id,
            "model_family": model_family,
            "trigger_word": trigger_word.strip(),
            "dataset_revision": dataset_revision,
            "dataset_path": revision["files_path"],
            "dataset_is_scratch": True,
            "output_dir": str(run_dir),
            "config": config or {},
            "software": {},
            "artifacts": [],
        }
        _write_json(run_dir / "run.json", run)
        _append_jsonl(run_dir / "events.jsonl", {
            "time": _now(),
            "type": "run_prepared",
            "run_id": run_id,
            "dataset_revision": dataset_revision,
            "model_family": model_family,
            "trigger_word": trigger_word.strip(),
            "config": config or {},
        })

        project["runs"].append({
            "id": run_id,
            "name": run["name"],
            "created_at": run["created_at"],
            "status": run["status"],
            "model_family": model_family,
            "dataset_revision": dataset_revision,
            "path": str(run_dir),
        })
        project["current_run"] = run_id
        self._save_project(project_dir, project)
        self._event(project_dir, "run_prepared", run_id=run_id, dataset_revision=dataset_revision, model_family=model_family)
        return run

    def get_run(self, project_id: str, run_id: str) -> dict[str, Any]:
        project_dir = self.project_dir(project_id)
        path = (project_dir / "runs" / run_id / "run.json").resolve()
        if project_dir not in path.parents or not path.is_file():
            raise FileNotFoundError(f"Unknown run: {run_id}")
        return _read_json(path)

    def append_run_event(self, project_id: str, run_id: str, event_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        project_dir = self.project_dir(project_id)
        run = self.get_run(project_id, run_id)
        run_dir = Path(run["output_dir"]).resolve()
        if project_dir not in run_dir.parents:
            raise ValueError("Run output path is outside the project")
        event = {"time": _now(), "type": event_type, **(payload or {})}
        _append_jsonl(run_dir / "events.jsonl", event)
        self._event(project_dir, "run_event", run_id=run_id, event=event)
        return event

    def register_artifact(
        self,
        project_id: str,
        run_id: str,
        *,
        artifact_type: str,
        path: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        project_dir = self.project_dir(project_id)
        run = self.get_run(project_id, run_id)
        run_file = project_dir / "runs" / run_id / "run.json"
        artifact_path = Path(path).expanduser().resolve()
        if not artifact_path.is_file():
            raise FileNotFoundError(f"Artifact does not exist: {artifact_path}")
        artifact = {
            "id": uuid.uuid4().hex[:16],
            "type": artifact_type,
            "path": str(artifact_path),
            "size_bytes": artifact_path.stat().st_size,
            "sha256": _sha256(artifact_path),
            "created_at": _now(),
            "metadata": metadata or {},
        }
        run.setdefault("artifacts", []).append(artifact)
        _write_json(run_file, run)
        self.append_run_event(project_id, run_id, "artifact_registered", {"artifact": artifact})
        return artifact


project_store = ProjectStore()
