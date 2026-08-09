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

AI caption generation, bulk caption actions, sampling, and training orchestration are intentionally still placeholders.

## Run the POC locally

Start the API:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

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
