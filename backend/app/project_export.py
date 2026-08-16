from __future__ import annotations

import io
import json
import os
import re
import tarfile
import threading
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Literal

ArchiveMode = Literal["portable", "workspace"]
ArchivePreset = Literal["clean", "standard", "full", "exhaustive", "custom"]
IdentityMode = Literal["preserve", "clone"]

_NUMBERED_CHECKPOINT_RE = re.compile(r"^.+-\d{6}\.safetensors$")
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_REV_ID_RE = re.compile(r"^(?P<base>.+?)-rev\d+$", re.IGNORECASE)
_REV_NAME_RE = re.compile(r"^(?P<base>.+?)\s+rev\d+$", re.IGNORECASE)

COMPONENTS: dict[str, dict[str, Any]] = {
    "project_core": {
        "label": "Project definition",
        "group": "Project",
        "description": "Project identity, description, trigger binding and project-owned settings.",
        "dependencies": [],
        "required": True,
    },
    "project_history": {
        "label": "Project audit history",
        "group": "Project",
        "description": "Project-level event history outside individual training runs.",
        "dependencies": ["project_core"],
    },
    "imports": {
        "label": "Source / import snapshots",
        "group": "Assets",
        "description": "Project-owned source snapshots and their manifests.",
        "dependencies": ["project_core"],
    },
    "datasets": {
        "label": "Dataset revisions, captions & transforms",
        "group": "Assets",
        "description": "Prepared dataset revisions including custom captions, crop/transform state, validation policy and training filenames.",
        "dependencies": ["project_core"],
        "required": True,
    },
    "run_metadata": {
        "label": "Run configuration & provenance",
        "group": "Run history",
        "description": "Run snapshots, dataset manifests, commands, model SHA manifests, policies and software provenance.",
        "dependencies": ["project_core", "datasets"],
    },
    "run_datasets": {
        "label": "Frozen run datasets",
        "group": "Run history",
        "description": "The exact materialized images and captions consumed by each trainer run.",
        "dependencies": ["run_metadata"],
    },
    "telemetry": {
        "label": "Telemetry, decisions & console",
        "group": "Run history",
        "description": "Global/per-image loss, decision history, events and persistent console logs.",
        "dependencies": ["run_metadata"],
    },
    "samples": {
        "label": "Generated training samples",
        "group": "Run history",
        "description": "Preview images rendered during training and preserved with the run.",
        "dependencies": ["run_metadata"],
    },
    "final_lora": {
        "label": "Final LoRA artifacts",
        "group": "Training artifacts",
        "description": "Unnumbered final LoRA outputs registered for completed runs.",
        "dependencies": ["run_metadata"],
    },
    "intermediate_checkpoints": {
        "label": "Intermediate epoch LoRAs",
        "group": "Training artifacts",
        "description": "Numbered epoch checkpoint safetensors.",
        "dependencies": ["run_metadata"],
    },
    "resume_states": {
        "label": "Resumable optimizer states",
        "group": "Training artifacts",
        "description": "LoRA, optimizer and RNG state directories used to resume training.",
        "dependencies": ["run_metadata"],
    },
    "caches": {
        "label": "Latent / text caches",
        "group": "Training artifacts",
        "description": "Regenerable trainer caches. These can be very large.",
        "dependencies": ["run_metadata", "run_datasets"],
    },
}

PRESETS: dict[str, dict[str, Any]] = {
    "clean": {
        "label": "Clean",
        "description": "Reusable project state with prepared assets/captions/settings, no training runs.",
        "components": ["project_core", "imports", "datasets"],
        "identity_mode": "clone",
    },
    "standard": {
        "label": "Standard",
        "description": "Portable experiment archive with run history, telemetry and final LoRAs; excludes resume-only scratch.",
        "components": [
            "project_core", "project_history", "imports", "datasets", "run_metadata",
            "run_datasets", "telemetry", "samples", "final_lora",
        ],
        "identity_mode": "preserve",
    },
    "full": {
        "label": "Full",
        "description": "Standard archive plus intermediate checkpoints and resumable optimizer/RNG states.",
        "components": [
            "project_core", "project_history", "imports", "datasets", "run_metadata",
            "run_datasets", "telemetry", "samples", "final_lora",
            "intermediate_checkpoints", "resume_states",
        ],
        "identity_mode": "preserve",
    },
    "exhaustive": {
        "label": "Exhaustive",
        "description": "Every project-owned byte, including all checkpoints, states and regenerable caches.",
        "components": list(COMPONENTS),
        "identity_mode": "preserve",
    },
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def suggest_clone_identity(projects_root: Path, project_id: str, project_name: str) -> dict[str, str]:
    """Return a predictable collision-safe revision-style identity for a project clone."""
    projects_root = projects_root.resolve()
    id_match = _REV_ID_RE.match(project_id)
    name_match = _REV_NAME_RE.match(project_name.strip())
    base_id = (id_match.group("base") if id_match else project_id).rstrip("-_") or "project"
    base_name = (name_match.group("base") if name_match else project_name.strip()) or base_id
    for revision in range(1, 10000):
        candidate_id = f"{base_id}-rev{revision}"
        if not (projects_root / candidate_id).exists():
            return {"id": candidate_id, "name": f"{base_name} rev{revision}"}
    raise ValueError("Unable to find an available project revision identity")


def _relative_parts(name: str) -> tuple[str, ...]:
    parts = PurePosixPath(name.replace("\\", "/")).parts
    if not parts:
        return ()
    return tuple(parts[1:]) if len(parts) > 1 else ()


def component_for_relative_parts(parts: tuple[str, ...], *, is_dir: bool = False) -> str:
    """Classify a project-relative archive member into one non-overlapping export component."""
    if not parts:
        return "project_core"
    if parts[0] == "project.json":
        return "project_core"
    if len(parts) == 1 and parts[0] == "events.jsonl":
        return "project_history"
    if parts[0] == "imports":
        return "imports"
    if parts[0] == "datasets":
        return "datasets"
    if parts[0] != "runs":
        return "project_core"

    if len(parts) <= 2:
        return "run_metadata"
    run_relative = parts[2:]
    first = run_relative[0]

    if first == "cache":
        return "caches"
    if first == "state" or first.endswith("-state"):
        return "resume_states"
    if first in {"sample", "samples"}:
        return "samples"
    if first == "dataset":
        return "run_datasets"
    if first == "loss_log" or first in {"metrics.jsonl", "events.jsonl", "console.log"}:
        return "telemetry"
    if len(run_relative) == 1 and first.endswith(".safetensors"):
        return "intermediate_checkpoints" if _NUMBERED_CHECKPOINT_RE.fullmatch(first) else "final_lora"
    return "run_metadata"


def component_for_archive_name(name: str, project_id: str | None = None, *, is_dir: bool = False) -> str:
    parts = PurePosixPath(name.replace("\\", "/")).parts
    if project_id and parts and parts[0] == project_id:
        rel = tuple(parts[1:])
    elif len(parts) > 1:
        rel = tuple(parts[1:])
    else:
        rel = tuple(parts)
    return component_for_relative_parts(rel, is_dir=is_dir)


def normalize_components(components: set[str] | list[str] | tuple[str, ...]) -> set[str]:
    selected = {str(value) for value in components if str(value) in COMPONENTS}
    selected.add("project_core")
    selected.add("datasets")
    changed = True
    while changed:
        changed = False
        for component in list(selected):
            for dependency in COMPONENTS[component].get("dependencies", []):
                if dependency not in selected:
                    selected.add(dependency)
                    changed = True
    return selected


def components_for_preset(preset: str) -> set[str]:
    if preset not in PRESETS:
        raise ValueError(f"Unsupported project archive preset: {preset}")
    return normalize_components(PRESETS[preset]["components"])


def inventory_project(project_dir: Path) -> dict[str, dict[str, int]]:
    inventory = {key: {"bytes": 0, "file_count": 0} for key in COMPONENTS}
    for path in project_dir.rglob("*"):
        if not path.is_file() or path.is_symlink() or path.name == "archive_manifest.json":
            continue
        relative = tuple(path.relative_to(project_dir).parts)
        component = component_for_relative_parts(relative)
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        inventory[component]["bytes"] += int(size)
        inventory[component]["file_count"] += 1
    return inventory


def _read_project(project_dir: Path) -> dict[str, Any]:
    return json.loads((project_dir / "project.json").read_text(encoding="utf-8"))


def _read_optional_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _sampling_archive_summary(project_dir: Path, selected: set[str]) -> dict[str, Any]:
    """Expose sampling provenance in archive_manifest without duplicating the full JSON payloads."""
    project_plan = _read_optional_json(project_dir / "sampling_plan.json")
    project_plan_included = "project_core" in selected and project_plan is not None
    project_summary: dict[str, Any] = {
        "path": "sampling_plan.json",
        "present": project_plan is not None,
        "included": project_plan_included,
    }
    if project_plan is not None:
        project_summary.update({
            "schema_version": project_plan.get("schema_version"),
            "seed_policy": project_plan.get("seed_policy"),
            "enabled": bool(project_plan.get("enabled")),
            "sample_count": len(project_plan.get("samples") or []),
        })

    frozen_runs: list[dict[str, Any]] = []
    runtime_snapshots: list[dict[str, Any]] = []
    if "run_metadata" in selected:
        runs_dir = project_dir / "runs"
        if runs_dir.is_dir():
            for run_dir in sorted((path for path in runs_dir.iterdir() if path.is_dir()), key=lambda path: path.name):
                run_json = _read_optional_json(run_dir / "run.json")
                if run_json is not None:
                    config = run_json.get("config") if isinstance(run_json.get("config"), dict) else {}
                    sampling = config.get("sampling") if isinstance(config, dict) else None
                    if isinstance(sampling, dict):
                        frozen_runs.append({
                            "run_id": run_dir.name,
                            "path": f"runs/{run_dir.name}/run.json",
                            "schema_version": sampling.get("schema_version"),
                            "seed_policy": sampling.get("seed_policy"),
                            "enabled": bool(sampling.get("enabled")),
                            "sample_count": len(sampling.get("samples") or []),
                        })
                snapshot = _read_optional_json(run_dir / "sampling_snapshot.json")
                if snapshot is not None:
                    runtime_snapshots.append({
                        "run_id": run_dir.name,
                        "path": f"runs/{run_dir.name}/sampling_snapshot.json",
                        "schema_version": snapshot.get("schema_version"),
                        "active": bool(snapshot.get("active")),
                        "plan_source": snapshot.get("plan_source"),
                    })

    return {
        "project_plan": project_summary,
        "frozen_run_configs": {
            "included": "run_metadata" in selected,
            "count": len(frozen_runs),
            "runs": frozen_runs,
        },
        "runtime_snapshots": {
            "included": "run_metadata" in selected,
            "count": len(runtime_snapshots),
            "runs": runtime_snapshots,
        },
        "contract": "sampling_plan.json is editable project state; run.json config.sampling is frozen at Prepare; sampling_snapshot.json records resolved/effective Start-time settings.",
    }


def export_options(project_dir: Path, project_id: str) -> dict[str, Any]:
    inventory = inventory_project(project_dir)
    components = []
    for component_id, definition in COMPONENTS.items():
        counts = inventory[component_id]
        components.append({
            "id": component_id,
            **definition,
            "bytes": counts["bytes"],
            "file_count": counts["file_count"],
            "available": counts["file_count"] > 0 or bool(definition.get("required")),
        })
    project = _read_project(project_dir)
    return {
        "schema_version": 2,
        "project_id": project_id,
        "components": components,
        "presets": [{"id": key, **value} for key, value in PRESETS.items()],
        "suggested_clone": suggest_clone_identity(
            project_dir.parent,
            project_id,
            str(project.get("name") or project_id),
        ),
    }


def _project_json_for_export(
    project_dir: Path,
    *,
    export_project_id: str,
    export_project_name: str | None,
    selected: set[str],
    identity_mode: IdentityMode,
) -> bytes:
    value = _read_project(project_dir)
    original_id = str(value.get("id", project_dir.name))
    original_name = str(value.get("name", original_id))

    if identity_mode == "clone":
        value["id"] = export_project_id
        value["name"] = (export_project_name or export_project_id).strip() or export_project_id
        value["created_at"] = _now()
        value["updated_at"] = value["created_at"]
        value["cloned_from"] = {
            "project_id": original_id,
            "project_name": original_name,
            "dataset_revision": value.get("current_dataset_revision"),
            "exported_at": value["created_at"],
        }

    if "run_metadata" not in selected:
        value["runs"] = []
        value["current_run"] = None

    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _archive_manifest(
    project_dir: Path,
    *,
    source_project_id: str,
    export_project_id: str,
    preset: str,
    selected: set[str],
    identity_mode: IdentityMode,
    export_project_name: str | None,
) -> bytes:
    options = export_options(project_dir, source_project_id)
    component_rows = []
    for component in options["components"]:
        component_rows.append({
            "id": component["id"],
            "label": component["label"],
            "group": component["group"],
            "description": component["description"],
            "dependencies": component.get("dependencies", []),
            "selected": component["id"] in selected,
            "available": component.get("available", False),
            "bytes": component.get("bytes", 0),
            "file_count": component.get("file_count", 0),
        })
    value = {
        "schema_version": 2,
        "archive_type": "project",
        "preset": preset,
        "created_at": _now(),
        "source_project_id": source_project_id,
        "project_id": export_project_id,
        "project_name": export_project_name,
        "identity_mode": identity_mode,
        "components": component_rows,
        "selected_components": sorted(selected),
        "estimated_uncompressed_bytes": sum(row["bytes"] for row in component_rows if row["selected"]),
        "sampling": _sampling_archive_summary(project_dir, selected),
        "notes": [
            "Components are classified into non-overlapping groups so size estimates can be summed.",
            "Symbolic links are never exported.",
            "The manifest describes intended archive semantics; import may select a dependency-safe subset.",
            "Sampling values remain authoritative in sampling_plan.json and each run.json; the manifest summarizes their presence/schema without duplicating every probe value.",
        ],
    }
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def stream_project_archive(
    project_dir: Path,
    project_id: str,
    *,
    mode: ArchiveMode | None = None,
    preset: ArchivePreset = "standard",
    components: set[str] | None = None,
    identity_mode: IdentityMode = "preserve",
    clone_id: str | None = None,
    clone_name: str | None = None,
) -> Iterator[bytes]:
    """Produce a selectable gzip project archive with pipe backpressure.

    ``mode`` remains as a compatibility alias: portable -> standard, workspace -> exhaustive.
    New callers should use presets/components and identity_mode.
    """
    if mode is not None:
        preset = "exhaustive" if mode == "workspace" else "standard"
    if preset != "custom" and preset not in PRESETS:
        raise ValueError(f"Unsupported project archive preset: {preset}")

    selected = normalize_components(components or (components_for_preset(preset) if preset != "custom" else set()))
    if identity_mode not in {"preserve", "clone"}:
        raise ValueError(f"Unsupported identity mode: {identity_mode}")

    export_project_id = project_id
    if identity_mode == "clone":
        export_project_id = (clone_id or "").strip()
        if not export_project_id or not _PROJECT_ID_RE.fullmatch(export_project_id):
            raise ValueError("Clone project ID must contain only letters, numbers, dot, underscore or dash")
        if export_project_id == project_id:
            raise ValueError("Clone project ID must differ from the source project ID")
        if not (clone_name or "").strip():
            raise ValueError("Clone project name is required")

    project_json = _project_json_for_export(
        project_dir,
        export_project_id=export_project_id,
        export_project_name=clone_name,
        selected=selected,
        identity_mode=identity_mode,
    )
    manifest = _archive_manifest(
        project_dir,
        source_project_id=project_id,
        export_project_id=export_project_id,
        preset=preset,
        selected=selected,
        identity_mode=identity_mode,
        export_project_name=clone_name if identity_mode == "clone" else _read_project(project_dir).get("name"),
    )

    read_fd, write_fd = os.pipe()
    errors: list[BaseException] = []

    def member_filter(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
        if info.issym() or info.islnk():
            return None
        relative = _relative_parts(info.name)
        if relative and relative[-1] == "archive_manifest.json":
            return None
        if relative == ("project.json",):
            return None
        component = component_for_relative_parts(relative, is_dir=info.isdir())
        return info if component in selected else None

    def produce() -> None:
        try:
            with os.fdopen(write_fd, "wb", buffering=0) as output:
                with tarfile.open(fileobj=output, mode="w|gz", dereference=False) as tf:
                    tf.add(
                        project_dir,
                        arcname=export_project_id,
                        recursive=True,
                        filter=member_filter,
                    )
                    project_info = tarfile.TarInfo(name=f"{export_project_id}/project.json")
                    project_info.size = len(project_json)
                    project_info.mtime = int(datetime.now(timezone.utc).timestamp())
                    project_info.mode = 0o644
                    tf.addfile(project_info, io.BytesIO(project_json))

                    manifest_info = tarfile.TarInfo(name=f"{export_project_id}/archive_manifest.json")
                    manifest_info.size = len(manifest)
                    manifest_info.mtime = int(datetime.now(timezone.utc).timestamp())
                    manifest_info.mode = 0o644
                    tf.addfile(manifest_info, io.BytesIO(manifest))
        except BrokenPipeError:
            pass
        except BaseException as exc:
            errors.append(exc)
            try:
                os.close(write_fd)
            except OSError:
                pass

    producer = threading.Thread(
        target=produce,
        daemon=True,
        name=f"project-export-{project_id}-{preset}",
    )
    producer.start()

    try:
        with os.fdopen(read_fd, "rb", buffering=0) as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk
    finally:
        try:
            os.close(read_fd)
        except OSError:
            pass
        producer.join(timeout=2)

    if errors:
        raise errors[0]
