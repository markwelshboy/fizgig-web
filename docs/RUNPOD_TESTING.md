# Runpod GPU test flow

This image is intentionally different from the local CPU review harness:

- one HTTP service on port `8000`
- React is built to static files and served by FastAPI
- upstream Fizgig's pinned GPU/ML dependency set is installed into the same Python environment
- project data, source uploads, model caches and preferences live under `/workspace`
- optional HTTP Basic auth protects the public Runpod proxy
- optional key-only SSH accepts `SSH_PUBLIC_KEY`, `PUBLIC_KEY`, or an already-provisioned `/root/.ssh/authorized_keys`
- source archives can be uploaded in the browser
- complete project archives can be streamed out of the browser and imported on a later pod

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

The first build is large because it resolves Fizgig's CUDA-enabled PyTorch stack. The heavyweight Fizgig install and the small Fizgig Web API requirements are separate Docker layers, and `uv` has its own BuildKit cache mount, so ordinary UI/backend work should not repeatedly redownload the CUDA stack.

## Runpod template

Recommended first test:

```text
Container image:      markwelshboy/fizgig-web:caption-test
Expose HTTP ports:    8000
Expose TCP ports:     22        # optional; for direct SSH when the pod/provider exposes TCP
Volume mount path:    /workspace
Volume size:          100 GB+   # optional for an ephemeral test; useful for persistent caches/models
```

Environment variables:

```text
FIZGIG_WEB_PASSWORD=<choose-a-password>
FIZGIG_WEB_USERNAME=fizgig             # optional; this is the default
SSH_PUBLIC_KEY=<ssh-ed25519 ...>        # optional
PUBLIC_KEY=<ssh-ed25519 ...>            # optional fallback
HF_TOKEN=<hf_...>                       # optional for public Qwen caption testing
```

If the platform has already populated `/root/.ssh/authorized_keys`, Fizgig Web keeps that key and starts `sshd` without requiring either key environment variable. SSH is key-only; password login is disabled.

If `FIZGIG_WEB_PASSWORD` is omitted, the startup script generates one and prints it in the pod log. Supplying one in the template is more convenient across restarts.

Do not override the image entrypoint/start command for the initial test.

## Connect

The Runpod HTTP proxy for internal port 8000 can be opened from the pod's Connect UI. The browser should prompt for Basic Auth. Use `fizgig` and the configured/generated password.

The health endpoint is intentionally unauthenticated:

```bash
curl https://<POD_PROXY>/api/health
```

The runtime probe is authenticated and should be the first GPU check:

```bash
curl -u 'fizgig:<password>' \
  https://<POD_PROXY>/api/runtime
```

Expected fields include:

```json
{
  "torch": "...",
  "torch_cuda": "...",
  "cuda_available": true,
  "cuda_device_count": 1,
  "cuda_device": "NVIDIA ...",
  "fizgig_root": "/opt/Fizgig",
  "sources_root": "/workspace/sources",
  "projects_root": "/workspace/projects"
}
```

You can also verify from the pod terminal/SSH session:

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

## Workspace paths

The Runpod image sets these explicitly:

```text
/workspace/sources/                uploaded or SSH-copied source datasets
/workspace/projects/               Fizgig Web project/revision/run state
/workspace/datasets/               general scratch/test datasets
/workspace/models/captioning/      explicit caption-model downloads
/workspace/.cache/huggingface/     normal Hugging Face model cache
/workspace/.insightface/           InsightFace cache
/workspace/fizgig-web/preferences.json
```

If `/workspace` is persistent, Hugging Face and explicit model downloads are reused across pod restarts. If it is ephemeral, use project archive export before terminating the pod.

## Getting source data into a pod

There are two supported paths.

### Browser archive upload

On **Start → Source Training Assets**:

1. Set the destination, for example `/workspace/sources/5H1VY`.
2. Click **Upload Zip/Tar Archive**.
3. Choose `.zip`, `.tar`, `.tar.gz`, or `.tgz`.
4. Fizgig safely extracts into an empty destination and automatically loads the resulting source dataset.

Archive extraction rejects path traversal, links/device entries, and oversized expansions. If the archive consists of one wrapper directory, that wrapper is stripped so its contents land directly in the requested source directory.

### SSH / SCP / rsync

When the pod exposes TCP port 22 and a Runpod/user key is available, `sshd` starts automatically. Copy source data to `/workspace/sources/...` and then use **Load Source Directory** in the browser.

## Getting project state out of an ephemeral pod

An open project's **Download Project Archive** action streams a gzip tar archive directly to the browser. It does not create a second complete copy on the pod first.

The archive contains the complete project-owned directory: immutable import snapshots, working dataset revisions, canonical captions/history, image-prep state, runs, samples, checkpoints, state and registered artifacts. Model/Hugging Face caches outside the project are intentionally not included.

On another pod, use **Import Project Archive** on the Start page. Internal absolute paths are rebased to the new configured projects root. The recorded external source path remains provenance and is not rewritten.

SSH remains an alternative for copying `/workspace/projects/<project-id>` or individual artifacts directly.

## Caption model download

Preferences can either leave a Hugging Face model ID as the caption model and let Transformers use its normal cache, or explicitly download a model into `/workspace/models/captioning`.

**Download & Select** starts a background server job and the browser polls status. Large Qwen checkpoints therefore do not depend on one multi-minute HTTP request remaining open through the pod proxy. The saved Preferences path is changed only after the snapshot download succeeds.

## Captioning smoke test

1. Upload/copy a small dataset under `/workspace/sources/...`.
2. Open/create the Fizgig Web project from that path.
3. Complete Image Prep and go to Captions.
4. Open **AI Captioning Assistant**.
5. Start with `Qwen3-VL`, the `Training caption` preset, and its default max tokens.
6. Click **Generate Candidate** for one image.
7. Confirm the generated text appears only in **Generated Candidate** and does not change **Working Caption**.
8. Use **Use as Working Caption**, then **Save Caption**, and confirm the saved project caption updates.
9. Navigate away/back and confirm the saved caption persists.
10. Click **Unload AI model** and verify GPU memory falls with `nvidia-smi`.
11. Download the project archive and, for an ephemeral-volume test, verify it can be imported into a clean local/pod workspace.

The standalone caption service now follows upstream Fizgig's Qwen3-VL generation mechanics: Qwen3-VL conditional-generation model, processor chat template plus explicit image input, approximately 1 MP vision cap, and low-temperature sampled decoding.

For the first 8B test, use a 24 GB-or-larger GPU if practical. A 4B model is also useful as a quicker plumbing smoke test.

## What this test does not cover yet

The current image establishes the GPU/web runtime, caption-model downloader, source/project ingress/egress, and captioner path. It does **not** yet implement the broader model-manifest/downloader plumbing for Krea/Klein DiT, text encoder, VAE, trainer assets, or the new per-image training policy hooks.

Automatic off-pod project backup (for example to a configured Hugging Face dataset repo) is also not wired into the web UI yet. Browser project export and SSH are the current durability paths for an ephemeral pod.
