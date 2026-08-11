# Fizgig Web

Modern browser-first front end for Fizgig training workflows.

The project is intentionally not a remote-desktop wrapper. Fizgig remains the underlying training engine while Fizgig Web owns project state, dataset construction, reproducibility, and the browser UX.

## Current POC scope

- persistent Project → Dataset Revision → Run model
- external source dataset is never modified
- immutable import snapshots for reproducibility
- model-specific scratch working datasets for Krea 2 and Klein
- Image Prep intake selection with per-image include/exclude state
- manual and InsightFace-derived crops with provenance
- global composition/tonal recipes plus per-image exceptions
- one maximum training-resolution policy with aspect buckets and downscale-only support
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
automatic + manual derivatives
    ↓
effective working set
    ↓
composition / image adjustments
    ↓
maximum training-resolution policy
    ↓
Captions
    ↓
run-local trainer dataset
```

Project assets retain useful source resolution. Crop/tonal transforms are materialized into the run-local dataset, then Fizgig performs the configured aspect-bucket/downscale stage. The default policy is no upscaling.

See `docs/PROJECT_MODEL.md` for the detailed provenance and ownership rules.

## Local CPU Docker harness

For UI review and Image Prep work on a machine with no GPU:

```bash
git switch agent/initial-web-poc
mkdir -p .local/workspace/datasets

docker compose -f docker-compose.local.yml up --build
```

Open:

```text
http://localhost:5173
```

FastAPI is also exposed directly at `http://localhost:8000` for debugging.

The compose harness deliberately requests no NVIDIA runtime. Its persistent host workspace is:

```text
./.local/workspace/
```

which is mounted into both application expectations as `/workspace`. Put a dataset you want to test under, for example:

```text
.local/workspace/datasets/test-person/
```

and enter this path in Fizgig Web:

```text
/workspace/datasets/test-person
```

Projects created by the local harness are persisted under:

```text
.local/workspace/projects/
```

CPU-safe project and image operations work normally. InsightFace uses ONNX Runtime CPU. Qwen/Florence generation and real training are intentionally not part of the no-GPU review harness; those actions require the target Fizgig/CUDA runtime.

Stop the harness with:

```bash
docker compose -f docker-compose.local.yml down
```

The `.local/` workspace is gitignored, so project/test data is not committed.

## Runpod GPU image

`Dockerfile.runpod` builds a single-service GPU image for real captioning and later trainer integration. React is built to static files and FastAPI serves both the UI and `/api` from port `8000`; `/workspace` holds persistent projects, datasets, model caches and preferences.

The default build helper uses the same `buildkit-scratch` convention as the other pod images:

```bash
bash build_fizgig-web.sh
```

That pushes `markwelshboy/fizgig-web:caption-test` by default.

For a local smoke test on the Docker build host, `--load-test` keeps the completed image out of the production Docker store under `/var/lib/docker`. It streams the BuildKit result directly into the isolated `docker-test` daemon (default socket `unix:///run/docker-test/docker.sock`):

```bash
./build_fizgig-web.sh --load-test --tag local-test

docker-test image ls markwelshboy/fizgig-web:local-test
```

`--load` remains available when an image really should be imported into the normal local Docker daemon; `--no-push` leaves the result in BuildKit cache only. Set `DOCKER_TEST_HOST` to override the test-daemon endpoint.

The first Runpod template should expose `8000/http`, mount persistent storage at `/workspace`, and set `FIZGIG_WEB_PASSWORD` so the public proxy is protected with browser Basic Auth.

See `docs/RUNPOD_TESTING.md` for the complete build, template, GPU-probe and captioning smoke-test flow.

## Native development

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

Vite proxies `/api` to the FastAPI backend. Set `VITE_API_PROXY_TARGET` to override the default `http://127.0.0.1:8000`, as the Docker harness does.