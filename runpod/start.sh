#!/usr/bin/env bash
set -euo pipefail

mkdir -p \
  /workspace/projects \
  /workspace/sources \
  /workspace/datasets \
  /workspace/models/captioning \
  /workspace/fizgig-web \
  /workspace/.cache/huggingface \
  /workspace/.insightface

export FIZGIG_WEB_USERNAME="${FIZGIG_WEB_USERNAME:-fizgig}"

if [[ -z "${FIZGIG_WEB_PASSWORD:-}" ]]; then
  FIZGIG_WEB_PASSWORD="$(python - <<'PY'
import secrets
print(secrets.token_urlsafe(14))
PY
)"
  export FIZGIG_WEB_PASSWORD
  GENERATED_PASSWORD=1
else
  GENERATED_PASSWORD=0
fi

# Runpod may supply a key as SSH_PUBLIC_KEY/PUBLIC_KEY or provision an
# authorized_keys file directly. The helper supports all three paths and keeps
# SSH key-only.
source /usr/local/lib/fizgig-web/setup_ssh.sh

echo "============================================================"
echo " Fizgig Web GPU runtime"
echo " image:   ${FIZGIG_WEB_IMAGE_VERSION:-unknown}"
echo " vcs:     ${FIZGIG_WEB_VCS_REF:-unknown}"
echo " Fizgig:  $(cat /opt/Fizgig/.fizgig-web-built-ref 2>/dev/null || git -C /opt/Fizgig rev-parse HEAD 2>/dev/null || echo unknown)"
echo " web:     port ${FIZGIG_WEB_PORT:-8000}"
echo " volume:  /workspace"
echo " sources: /workspace/sources"
echo " projects:/workspace/projects"
echo " user:    ${FIZGIG_WEB_USERNAME}"
if [[ "$GENERATED_PASSWORD" == "1" ]]; then
  echo " password: ${FIZGIG_WEB_PASSWORD}  (generated for this pod process)"
else
  echo " password: supplied by FIZGIG_WEB_PASSWORD"
fi
echo "============================================================"

python - <<'PY'
try:
    import torch
    print(f"[fizgig-web] torch={torch.__version__} cuda={torch.version.cuda} available={torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"[fizgig-web] gpu={torch.cuda.get_device_name(0)} count={torch.cuda.device_count()}")
except Exception as exc:
    print(f"[fizgig-web] torch probe failed: {type(exc).__name__}: {exc}")
PY

exec uvicorn app.main:app \
  --app-dir /opt/fizgig-web/backend \
  --host 0.0.0.0 \
  --port "${FIZGIG_WEB_PORT:-8000}"
