# Fizgig Web

A modern browser-based front end for [Fizgig](https://github.com/shootthesound/Fizgig), focused first on the core training workflow while preserving Fizgig as the underlying ML/training engine.

## Initial scope

- Start / run configuration
- Captions
- Samples
- Training
- Preferences / model management
- Krea 2 and Klein model families
- Image Prep route reserved for the next phase

## Architecture

- `frontend/` — React + Vite + TypeScript
- `backend/` — FastAPI orchestration/API layer
- Fizgig remains the source of truth for training scripts and model logic
- Browser talks to the backend over REST and WebSocket/SSE-style job streams

## Current vertical slice

The Start and Captions pages now work against a real server-side dataset folder:

- scan supported image files in a dataset directory
- discover same-basename `.txt` caption sidecars
- show real image thumbnails and caption coverage
- share the selected dataset/model family/trigger word across the browser flow
- browse/search actual dataset images on the Captions page
- edit and save caption sidecars through FastAPI
- serve images only from dataset folders registered during the current API session
- generate captions with Qwen3-VL 4B or Florence-2
- regenerate one image into the editor for review before saving
- generate and save all missing captions with progress feedback
- choose the upstream Qwen caption preset and edit its captioning instruction
- choose Florence model/task and max-token budget
- optionally prepend the dataset trigger word
- lazily keep caption models resident for iterative work and unload them when VRAM is needed

Fizgig's Qwen captioning instruction is editable. Krea 2's separate text-encoding system descriptor is deliberately not changed: it is part of the training/inference conditioning contract and must stay in sync with upstream Fizgig/ComfyUI.

Sampling and training orchestration are still placeholders.

## Run the POC locally

For basic dataset browsing/editing you can run the lightweight backend venv:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

For **AI captioning**, run the API from the same Python environment as upstream Fizgig so Torch, Transformers, its Krea/Qwen loader, and model dependencies are available. Point the web layer at the Fizgig checkout if it is not in one of the normal container paths:

```bash
export FIZGIG_ROOT=/opt/Fizgig
```

Qwen captioning uses the Krea 2 Qwen3-VL text-encoder safetensors. Until Preferences persistence is wired, either enter its path in the Captions page or set:

```bash
export FIZGIG_QWEN_CAPTION_MODEL=/workspace/models/text_encoders/qwen3vl_4b_fp8_scaled.safetensors
```

The Qwen preset list and prompt text are read directly from upstream `fizgig.krea2.embedder.CAPTION_TASKS` whenever that checkout is available, keeping the web UI aligned with Fizgig's auto-recaption behavior. The server has fallback labels only so the UI can still render before Fizgig is configured.

Florence models are lazy-downloaded from Hugging Face on first use and follow the pinned revisions used by upstream Fizgig.

In another shell, start the frontend:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the FastAPI server on port 8000.

On the Start page enter a path that exists **on the machine running FastAPI**, for example:

```text
/workspace/Fizgig/dataset/my_character
```

The folder should contain images and optional matching sidecars such as:

```text
referenceimage_00001.png
referenceimage_00001.txt
referenceimage_00002.jpg
referenceimage_00002.txt
```

## Design goals

- Clean, modern, dark UI
- Minimal chrome; training state stays central
- Thin API wrapper over Fizgig rather than reimplementing training logic
- Model-family abstraction so Krea 2 and Klein share the same workflow where possible
