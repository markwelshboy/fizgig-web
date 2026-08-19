# Fizgig Web Project Model

Fizgig Web treats a LoRA project as a reproducible experiment history, not as a mutable dataset folder.

## Core invariants

1. **The user's external dataset is the canonical source.** Fizgig Web never modifies it.
2. **A project creates an immutable import snapshot.** This is an archival starting point for reproducibility, not a replacement canonical source.
3. **All model-specific datasets are scratch working sets.** Image Prep, caption generation, training-time recaptioning, exclusions, brightness fixes, face crops, resizing, etc. happen only in project-owned working copies.
4. **Image Prep constructs the effective dataset.** Every incoming asset can be included or excluded; derivatives become new assets with lineage; transformations remain non-destructive and attributable.
5. **Captions live in project JSON.** `.txt` sidecars are disposable trainer compatibility shims generated from project state.
6. **A run materializes only included assets.** The trainer receives a run-local dataset folder containing exactly the effective working set and current project captions.
7. **A run snapshots its exact effective dataset before training.** That includes image hashes and the exact starting caption text for every included image.
8. **Mutations are events, not lost state.** Caption changes, image derivations, exclusions, per-image LR changes, checkpoints, trainer states, samples, and manual interventions are recorded.
9. **Artifacts are identified by hash.** A safetensor or state export is meaningful only together with the dataset/config/history that produced it.

## Dataset construction flow

```text
External canonical source
        │
        ▼
Immutable import snapshot
        │
        ▼
Incoming batch
        │
        ├── include / exclude each source image
        │
        ▼
Derivative generation
        │
        ├── face crops
        ├── upper-body/detail crops
        └── future derived variants
        │
        ▼
Effective working set
        │
        ▼
Model-aware transform pipeline
        │
        ├── aspect/crop
        ├── resize to model-native target/bucket
        └── optional exposure/contrast/etc.
        │
        ▼
Captions (project JSON)
        │
        ▼
Run-local trainer dataset
```

An excluded source image is not deleted and is not considered bad globally. It is simply not a member of this particular working dataset. It remains in the immutable import snapshot and can be included in another revision or later experiment.

A derivative is a first-class project asset. It records its parent asset plus the operation that created it, for example:

```json
{
  "filename": "referenceimage_00012_face01.png",
  "asset_kind": "derived",
  "parent_asset_id": "abc123",
  "included": true,
  "operations": [
    {
      "type": "face_crop",
      "detector": "...",
      "box": [410, 118, 980, 688]
    }
  ],
  "caption": ""
}
```

New derivatives normally enter Captions as missing-caption assets. We may later offer deliberate caption inheritance as an explicit operation, but it must never happen invisibly.

## Run-local trainer shim

The project revision is the authoritative dataset definition. At run preparation Fizgig Web creates:

```text
runs/run-0001/dataset/
├── included_image_01.png
├── included_image_01.txt
├── included_image_02.png
├── included_image_02.txt
└── ...
```

Only included assets are copied. Caption sidecars are generated from the canonical caption values in project JSON. The trainer never needs to understand projects, revisions, provenance, or caption history; this folder is the shim between Fizgig Web and the upstream trainer.

The run's `dataset_snapshot.json` describes exactly this materialized set, including hashes, captions, lineage, and preparation operations. Excluded images therefore cannot accidentally leak into training merely because their files still exist in the project revision.

## Caption ownership

The revision manifest is authoritative:

```json
{
  "filename": "referenceimage_00042.png",
  "included": true,
  "caption": "the current canonical caption",
  "caption_sha256": "..."
}
```

When a caption changes, Fizgig Web updates JSON and appends an event containing the before/after text and provenance. A `.txt` file is written only when a trainer-facing materialization or active-run intervention requires one.

If JSON and a scratch sidecar ever disagree, JSON wins.

## Event history

Project and run event logs are append-only JSONL. Expected events include:

- `image_inclusion_changed`
- `image_derived`
- `image_prep_operation_queued` / transformation-completed events
- `caption_changed`
- `trainer_dataset_materialized`
- `run_prepared`
- `training_started`
- `training_stopped`
- `training_resumed`
- `image_status_changed`
- `per_image_lr_changed`
- `image_excluded`
- `image_readmitted`
- `checkpoint_saved`
- `trainer_state_saved`
- `sample_generated`
- `artifact_registered`
- `plateau_detected`

Caption events preserve the exact provider/model/prompt used. Image events preserve the exact operation geometry/parameters used. This lets the UI later answer whether a recaption, crop, brightness adjustment, or other intervention actually improved the subsequent training trajectory.

## Project versus run knowledge

The **project** is the long-lived body of dataset knowledge: canonical external-source reference, immutable imports, dataset revisions, image lineage, caption history, recurring problem images, and cross-run comparisons.

A **dataset revision** is a scratch construction of an effective training set for a model or experiment direction.

A **run** is an immutable experiment history: exact included assets and captions at start, configuration, loss history, interventions, checkpoints, state exports, and samples.

This separation lets multiple Krea/Klein/other-model experiments reuse the same source material without silently mutating one another's inputs.
