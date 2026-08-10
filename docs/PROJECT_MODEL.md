# Fizgig Web Project Model

Fizgig Web treats a LoRA project as a reproducible experiment history, not as a mutable dataset folder.

## Core invariants

1. **The user's external dataset is the canonical source.** Fizgig Web never modifies it.
2. **A project creates an immutable import snapshot.** This is an archival starting point for reproducibility, not a replacement canonical source.
3. **All model-specific datasets are scratch working sets.** Image Prep, caption generation, training-time recaptioning, exclusions, brightness fixes, face crops, resizing, etc. happen only in project-owned working copies.
4. **A run snapshots its exact effective dataset before training.** That includes image hashes and the exact starting caption text for every image.
5. **Mutations are events, not lost state.** Caption changes, image derivations, exclusions, per-image LR changes, checkpoints, trainer states, samples, and manual interventions are recorded.
6. **Artifacts are identified by hash.** A safetensor or state export is meaningful only together with the dataset/config/history that produced it.

## Layout

```text
projects/<project-id>/
├── project.json
├── events.jsonl
│
├── imports/
│   └── import-0001/
│       ├── manifest.json
│       └── files/
│           ├── image_0001.png
│           ├── image_0001.txt
│           └── ...
│
├── datasets/
│   ├── ds-0001/
│   │   ├── manifest.json
│   │   ├── prep.json
│   │   └── files/               # scratch working dataset
│   └── ds-0002/
│       └── ...
│
└── runs/
    └── run-0001/
        ├── run.json
        ├── dataset_snapshot.json
        ├── events.jsonl
        ├── loss_log/
        ├── samples/
        ├── checkpoints/
        ├── state/
        └── artifacts/
```

## External source versus import snapshot

`project.json` records the external source path explicitly:

```json
{
  "external_source": {
    "path": "/workspace/reference-datasets/person-a",
    "owned_by_project": false,
    "mutable_by_project": false
  }
}
```

When the project is created, Fizgig Web copies the current files into `imports/import-0001/files/` and hashes every image/caption. This snapshot answers "what did the source look like when this project began?" even if the external canonical source evolves later.

The import snapshot is never edited.

## Dataset revisions are scratchpads

A dataset revision is a materialized working set for a particular training direction or model family. It can contain:

- model-specific crop/resize geometry
- face crops that did not exist in the external source
- exposure/brightness/contrast corrections
- generated or manually edited captions
- removed or excluded images
- future Image Prep transformations

A revision has lineage via its `basis` field:

```json
{
  "id": "ds-0003",
  "model_family": "krea2",
  "basis": {"type": "import_snapshot", "id": "import-0001"},
  "scratch": true
}
```

or from another scratch revision:

```json
{
  "basis": {"type": "dataset_revision", "id": "ds-0002"}
}
```

No scratch dataset is ever promoted to canonical source automatically.

## Run snapshot

Immediately before training begins, the chosen scratch dataset is frozen logically into `dataset_snapshot.json`.

For every image it records at minimum:

```json
{
  "asset_id": "...",
  "filename": "referenceimage_00042.png",
  "image_sha256": "...",
  "caption": "the exact starting caption",
  "caption_sha256": "...",
  "origin": "external_source_import",
  "parent_asset_id": null,
  "operations": []
}
```

This is the immutable start point for that run. The actual scratch `.txt` files can then change during training without destroying reproducibility.

## Event history

Project and run event logs are append-only JSONL.

Expected run events include:

- `run_prepared`
- `training_started`
- `training_stopped`
- `training_resumed`
- `image_status_changed`
- `per_image_lr_changed`
- `caption_changed`
- `caption_regenerated`
- `image_derived`
- `image_excluded`
- `image_readmitted`
- `image_removed`
- `checkpoint_saved`
- `trainer_state_saved`
- `sample_generated`
- `artifact_registered`
- `plateau_detected`

Caption events should preserve the actual prompt/model used, not just a preset name:

```json
{
  "type": "caption_changed",
  "epoch": 8,
  "image": "referenceimage_00042.png",
  "reason": "auto_recaption_stuck",
  "provider": "qwen",
  "model": "Qwen/Qwen3-VL-8B-Instruct",
  "model_revision": "...",
  "task": "detailed",
  "instruction": "the exact resolved prompt text",
  "before": "...",
  "after": "..."
}
```

This lets the UI show whether a recaption or image intervention actually improved the subsequent loss trajectory.

## Artifacts

Every saved checkpoint/state/sample can be registered with:

- type
- path
- timestamp
- file size
- SHA-256
- epoch/step and other metadata

A checkpoint therefore belongs to a known run with a known starting dataset and full intervention history.

## Future comparison

Because runs share a project, Fizgig Web can eventually compare experiments and flag hidden differences:

- identical or changed starting captions
- identical or changed image sets/hashes
- LoRA versus LoKR
- learning-rate changes
- adaptive per-image LR changes
- recaption provider/task/prompt changes
- recurring stuck images across runs
- exclusions and image interventions
- checkpoint/sample outcomes

The project is the long-lived body of knowledge. A dataset revision is a scratchpad. A run is an immutable experiment history.
