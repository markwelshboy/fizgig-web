# Runpod GPU test flow

This image is intentionally different from the local CPU review harness:

- one HTTP service on port `8000`
- React is built to static files and served by FastAPI
- upstream Fizgig's pinned GPU/ML dependency set is installed into the same Python environment
- project data, model caches and preferences live under persistent `/workspace`
- optional HTTP Basic auth protects the public Runpod proxy
- optional SSH starts only when `PUBLIC_KEY` is supplied

## Build and push

The helper follows the same buildx pattern used by the other `markwelshboy` pod images. The default builder is `buildkit-scratch` and the default image is `markwelshboy/fizgig-web:caption-test`.

```bash
git switch agent/initial-web-poc
git pull

bash build_fizgig-web.sh
```

Useful variants:

```bash
# Different test tag
bash build_fizgig-web.sh --tag caption-test-2

# Build without pushing
bash build_fizgig-web.sh --no-push

# Load a single-platform build into local Docker
bash build_fizgig-web.sh --load --tag local-test
```

The first build is large because it resolves Fizgig's CUDA-enabled PyTorch stack. Subsequent source/UI changes should reuse buildx layers unless the upstream requirements or base runtime changes.

## Runpod template

Recommended first test:

```text
Container image:      markwelshboy/fizgig-web:caption-test
Expose HTTP ports:   8000
Expose TCP ports:    22        # optional; only useful with PUBLIC_KEY
Volume mount path:   /workspace
Volume size:         100 GB+   # leaves room for later Krea/Klein model testing
```

Environment variables:

```text
FIZGIG_WEB_PASSWORD=<choose-a-password>
FIZGIG_WEB_USERNAME=fizgig             # optional; this is the default
PUBLIC_KEY=<ssh-ed25519 ...>            # optional
HF_TOKEN=<hf_...>                       # optional for public Qwen caption testing
```

If `FIZGIG_WEB_PASSWORD` is omitted, the startup script generates one and prints it in the pod log. Supplying one in the template is more convenient across restarts.

Do not override the image entrypoint/start command for the initial test.

## Connect

Runpod's HTTP proxy URL for an exposed internal port 8000 is:

```text
https://<POD_ID>-8000.proxy.runpod.net
```

The browser should prompt for Basic Auth. Use `fizgig` and the configured/generated password.

The health endpoint is intentionally unauthenticated:

```bash
curl https://<POD_ID>-8000.proxy.runpod.net/api/health
```

The runtime probe is authenticated and should be the first GPU check:

```bash
curl -u 'fizgig:<password>' \
  https://<POD_ID>-8000.proxy.runpod.net/api/runtime
```

Expected fields include:

```json
{
  "torch": "...",
  "torch_cuda": "...",
  "cuda_available": true,
  "cuda_device_count": 1,
  "cuda_device": "NVIDIA ...",
  "fizgig_root": "/opt/Fizgig"
}
```

You can also verify from the pod terminal:

```bash
nvidia-smi
python - <<'PY'
import torch
print(torch.__version__)
print(torch.version.cuda)
print(torch.cuda.is_available())
print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else None)
PY
```

## Persistent paths

The Runpod image sets these explicitly:

```text
/workspace/projects/               Fizgig Web project/revision/run state
/workspace/datasets/               test/source datasets
/workspace/models/captioning/      explicit caption-model downloads
/workspace/.cache/huggingface/     normal Hugging Face model cache
/workspace/.insightface/           InsightFace cache
/workspace/fizgig-web/preferences.json
```

This means a Qwen model fetched by Transformers on first generation is reused after a pod restart as long as `/workspace` persists.

## Captioning smoke test

1. Put a small dataset under `/workspace/datasets/...`.
2. Open/create the Fizgig Web project from that path.
3. Complete Image Prep and go to Captions.
4. Open **AI Captioning Assistant**.
5. Start with `Qwen3-VL`, the `Training caption` preset, and its default max tokens.
6. Click **Generate Candidate** for one image.
7. Confirm the generated text appears only in **Generated Candidate** and does not change **Working Caption**.
8. Use **Use as Working Caption**, then **Save Caption**, and confirm the saved project caption updates.
9. Navigate away/back and confirm the saved caption persists.
10. Click **Unload AI model** and verify GPU memory falls with `nvidia-smi`.

For the first test, use a 24 GB-or-larger GPU if practical. Qwen3-VL-8B in BF16 is much more comfortable there than on a 16 GB card, and it keeps the test focused on our integration rather than memory pressure.

## What this test does not cover yet

The current image establishes the GPU/web runtime and captioner path. It does **not** yet implement the broader model-manifest/downloader plumbing for Krea/Klein DiT, text encoder, VAE, trainer assets, or the new per-image training policy hooks. Those are the next layer once caption generation is proven on the pod.
