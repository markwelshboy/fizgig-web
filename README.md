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

## Design goals

- Clean, modern, dark UI
- Minimal chrome; training state stays central
- Thin API wrapper over Fizgig rather than reimplementing training logic
- Model-family abstraction so Krea 2 and Klein share the same workflow where possible

## Status

Initial proof-of-concept scaffold in progress.
