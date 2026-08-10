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
- captioning VLMs are independent tools; they do not reuse or constrain Krea/Klein training encoders

## Current vertical slice

The Start and Captions pages now work against a real server-side dataset folder:

- scan supported image files in a dataset directory
- discover same-basename `.txt` caption sidecars
- show real image thumbnails and caption coverage
- share the selected dataset/model family/trigger word across the browser flow
- browse/search actual dataset images on the Captions page
- edit and save caption sidecars through FastAPI
- serve images only from dataset folders registered during the current API session
- generate captions with an arbitrary Transformers-compatible Qwen3-VL model or Florence-2
- regenerate one image into the editor for review before saving
- generate and save all missing captions with progress feedback
- choose the upstream Fizgig Qwen caption preset and edit its captioning instruction
- choose Florence model/task and max-token budget
- optionally prepend the dataset trigger word
- lazily keep caption models resident for iterative work and unload them when VRAM is needed

Sampling and training orchestration are still placeholders.

## Caption VLM configuration

Qwen captioning is deliberately decoupled from the model being trained. The default is:

```text
Qwen/Qwen3-VL-8B-Instruct
```

Preferences can instead point to:

- another Hugging Face Qwen3-VL repository
- a persistent local Hugging Face-compatible Qwen3-VL model/checkpoint directory
- an optional separate processor/tokenizer source
- an optional branch, tag, or commit revision

The Captions page can override those defaults for one run without changing the saved preference.

A **Download & Select** action snapshots a Hub repository into the configured caption-model directory and makes the resulting local directory the default. The default persistent location is:

```text
/workspace/Fizgig/models/captioning
```

Preferences themselves default to:

```text
/workspace/fizgig-web/preferences.json
```

and can be redirected with `FIZGIG_WEB_SETTINGS`.

A bare standalone `.safetensors` file is not treated as a complete generic VLM checkpoint because Transformers also needs the architecture/config and processor assets. Put those files together in a Hugging Face-compatible model directory, or use the processor override when the processor lives elsewhere.

Fizgig's Qwen caption preset list and prompt text are still read from upstream `fizgig.krea2.embedder.CAPTION_TASKS` when Fizgig is available. That keeps caption doctrine aligned with upstream auto-recaption behavior without coupling the actual caption model weights to Krea's text encoder.

## Run the POC locally

Start the API:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Torch is intentionally expected from the target CUDA/Fizgig environment. Qwen3-VL captioning uses the standard Transformers multimodal generation path. If the chosen model is a Hub ID, normal Hugging Face cache/authentication rules apply.

If upstream Fizgig is installed, point the web layer at it when it is not in one of the normal container paths so the caption preset definitions can be imported:

```bash
export FIZGIG_ROOT=/opt/Fizgig
```

Optional environment defaults are also supported:

```bash
export FIZGIG_QWEN_CAPTION_MODEL=Qwen/Qwen3-VL-8B-Instruct
export FIZGIG_QWEN_CAPTION_PROCESSOR=
export FIZGIG_QWEN_CAPTION_REVISION=
export FIZGIG_CAPTION_MODEL_DIR=/workspace/Fizgig/models/captioning
```

Florence models are loaded independently and follow the model/task choices exposed by the web UI.

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
