# Fizgig Web

A modern browser-based front end for [Fizgig](https://github.com/shootthesound/Fizgig), focused first on the core training workflow while preserving Fizgig as the underlying ML/training engine.

## Initial scope

- Projects and reproducible run history
- Start / run configuration
- Captions
- Samples
- Training
- Preferences / model management
- Krea 2 and Klein model families
- Image Prep route reserved for the next phase

## Project-first architecture

Fizgig Web no longer treats a mutable dataset folder as the experiment record.

- the **external dataset remains the user's canonical source** and is never modified by Fizgig Web
- project creation makes an **immutable import snapshot** for reproducibility
- Image Prep / Captions operate on **project-owned scratch dataset revisions**
- every model family can derive its own crop/resize/image set from the same external source
- a run records an immutable **dataset snapshot** with exact image hashes and starting caption text
- project/run JSONL event logs are the future audit trail for recaptions, exclusions, per-image LR changes, image interventions, checkpoints, state exports, samples, and training lifecycle
- registered artifacts carry SHA-256 hashes and run metadata

See [`docs/PROJECT_MODEL.md`](docs/PROJECT_MODEL.md) for the invariants, directory layout, and event model.

## Architecture

- `frontend/` — React + Vite + TypeScript
- `backend/` — FastAPI orchestration/API layer
- Fizgig remains the source of truth for training scripts and model logic
- Browser talks to the backend over REST and WebSocket/SSE-style job streams

## Current vertical slice

The Start and Captions pages now work against real files:

- create/open persistent Fizgig Web projects
- snapshot an external source dataset without modifying it
- create model-specific scratch dataset revisions
- scan supported image files in the active working dataset
- discover same-basename `.txt` caption sidecars
- show real image thumbnails and caption coverage
- share the selected project/dataset/model family/trigger word across the browser flow
- browse/search actual scratch dataset images on the Captions page
- edit and save scratch caption sidecars through FastAPI
- serve images only from dataset folders registered during the current API session
- generate captions with an independent Qwen3-VL caption VLM or Florence-2
- regenerate one image into the editor for review before saving
- generate and save all missing captions with progress feedback
- choose the upstream Qwen caption preset and edit its captioning instruction
- choose Florence model/task and max-token budget
- optionally prepend the dataset trigger word
- lazily keep caption models resident for iterative work and unload them when VRAM is needed

The first training run snapshot/event/artifact APIs are also present; actual trainer subprocess orchestration is still to be wired.

## Independent caption VLM

Captioning is deliberately separate from Krea/Klein's training text encoders. The default is:

```text
Qwen/Qwen3-VL-8B-Instruct
```

Preferences accepts either a Hugging Face model id or a local HF-compatible checkpoint directory, plus an optional separate processor/tokenizer source and revision. A model can be snapshot-downloaded into persistent caption-model storage and selected as the default.

The Qwen preset list and prompt text are read directly from upstream `fizgig.krea2.embedder.CAPTION_TASKS` whenever Fizgig is available, keeping the web UI aligned with Fizgig's auto-recaption behavior without coupling caption model weights to the trainer.

## Run the POC locally

For basic project/dataset browsing and editing:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Project storage defaults to:

```text
/workspace/Fizgig/projects
```

Override it with:

```bash
export FIZGIG_PROJECTS_ROOT=/some/persistent/path
```

For AI captioning, run the backend in an environment with Torch/Transformers and the relevant model dependencies installed.

In another shell:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to FastAPI on port 8000.

## Design goals

- Clean, modern, dark UI
- Minimal chrome; training state stays central
- Thin orchestration layer over Fizgig rather than reimplementing training logic
- Model-family abstraction so Krea 2 and Klein share the same workflow where possible
- Every run should be reproducible even after live recaptioning or dataset intervention
- Project files should remain human-readable and portable
