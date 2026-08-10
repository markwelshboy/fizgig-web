# Fizgig Web

Modern browser-first front end for Fizgig training workflows.

The project is intentionally not a remote-desktop wrapper. Fizgig remains the underlying training engine while Fizgig Web owns project state, dataset construction, reproducibility, and the browser UX.

## Current POC scope

- persistent Project → Dataset Revision → Run model
- external source dataset is never modified
- immutable import snapshots for reproducibility
- model-specific scratch working datasets for Krea 2 and Klein
- Image Prep intake selection with per-image include/exclude state
- run-local trainer datasets containing only included assets
- project-owned canonical captions; `.txt` files are trainer compatibility shims
- Qwen3-VL and Florence captioning
- arbitrary Qwen3-VL model/checkpoint selection, including local HF-compatible directories
- caption provider/model/prompt provenance in project history
- run/event/artifact foundations for later training intelligence

## Image Prep model

Image Prep is a dataset-construction flow rather than a destructive image editor:

```text
external source
    ↓
immutable import
    ↓
incoming batch
    ↓ include / exclude
face/detail derivatives
    ↓
effective working set
    ↓
model-aware crop / resize / adjustments
    ↓
Captions
    ↓
run-local trainer dataset
```

The current workbench implements real inclusion/exclusion state and the working-set flow. Face detection/derived-image materialization and model-aware transformation execution are the next backend pieces.

See `docs/PROJECT_MODEL.md` for the detailed provenance and ownership rules.

## Development

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0
```

Vite proxies `/api` to the FastAPI backend.
