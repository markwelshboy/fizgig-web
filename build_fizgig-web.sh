#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./build_fizgig-web.sh [options]

Build/output:
  --builder <name>      Buildx builder (default: buildkit-scratch)
  --image <repo/name>  Image repository (default: markwelshboy/fizgig-web)
  --tag <tag>           Image tag (default: caption-test)
  --platform <plats>   Default: linux/amd64
  --load               Load into the normal local Docker daemon instead of pushing
  --load-test          Stream the image directly into the disposable docker-test daemon
  --no-push            Build/cache only; do not push or load
  --no-cache           Disable Docker build cache
  --prune-hard         Prune all cache from the selected Buildx builder first

Fizgig runtime:
  --fizgig-ref <ref>   Upstream Fizgig branch/tag/commit (default: master)
  --fizgig-repo <url>  Fizgig source repo URL

Environment:
  DOCKER_TEST_HOST     docker-test daemon endpoint
                       (default: unix:///run/docker-test/docker.sock)

Examples:
  ./build_fizgig-web.sh
  ./build_fizgig-web.sh --tag test2
  ./build_fizgig-web.sh --load-test --tag local-test
  ./build_fizgig-web.sh --load --tag local-production-test
  ./build_fizgig-web.sh --fizgig-ref master --no-push
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }

BUILDER="${BUILDX_BUILDER:-buildkit-scratch}"
IMAGE="markwelshboy/fizgig-web"
TAG="caption-test"
PLATFORM="linux/amd64"
PUSH=true
LOAD=false
LOAD_TEST=false
NO_CACHE=false
PRUNE_HARD=false
FIZGIG_REF="master"
FIZGIG_REPO="https://github.com/shootthesound/Fizgig.git"
TEST_DOCKER_HOST="${DOCKER_TEST_HOST:-unix:///run/docker-test/docker.sock}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --builder) BUILDER="${2:?}"; shift 2 ;;
    --image) IMAGE="${2:?}"; shift 2 ;;
    --tag) TAG="${2:?}"; shift 2 ;;
    --platform) PLATFORM="${2:?}"; shift 2 ;;
    --load) LOAD=true; LOAD_TEST=false; PUSH=false; shift ;;
    --load-test) LOAD_TEST=true; LOAD=false; PUSH=false; shift ;;
    --no-push) PUSH=false; LOAD=false; LOAD_TEST=false; shift ;;
    --no-cache) NO_CACHE=true; shift ;;
    --prune-hard) PRUNE_HARD=true; shift ;;
    --fizgig-ref) FIZGIG_REF="${2:?}"; shift 2 ;;
    --fizgig-repo) FIZGIG_REPO="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "Docker is not accessible"
docker buildx inspect "$BUILDER" >/dev/null 2>&1 || die "Buildx builder '$BUILDER' not found"
[[ -f Dockerfile.runpod ]] || die "Run from the fizgig-web repository root"

if [[ "$PLATFORM" == *,* ]] && { $LOAD || $LOAD_TEST; }; then
  die "--load and --load-test support only one platform"
fi

if $LOAD_TEST; then
  docker --host "$TEST_DOCKER_HOST" info >/dev/null 2>&1 \
    || die "docker-test daemon is not accessible at '$TEST_DOCKER_HOST'"
fi

BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
VCS_REF="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
IMAGE_VERSION="$TAG"

if $PRUNE_HARD; then
  docker buildx prune --builder "$BUILDER" --all --force
fi

args=(
  --builder "$BUILDER"
  --file Dockerfile.runpod
  --platform "$PLATFORM"
  --tag "$IMAGE:$TAG"
  --build-arg "FIZGIG_REPO=$FIZGIG_REPO"
  --build-arg "FIZGIG_REF=$FIZGIG_REF"
  --build-arg "IMAGE_VERSION=$IMAGE_VERSION"
  --build-arg "VCS_REF=$VCS_REF"
  --build-arg "BUILD_DATE=$BUILD_DATE"
)

$NO_CACHE && args+=(--no-cache)
if $PUSH; then
  args+=(--push)
elif $LOAD; then
  args+=(--load)
fi

cat <<EOF
== Fizgig Web Runpod build ==
Image           : $IMAGE:$TAG
Builder         : $BUILDER
Platform        : $PLATFORM
Push            : $PUSH
Load normal     : $LOAD
Load docker-test: $LOAD_TEST
Test Docker host: $TEST_DOCKER_HOST
Fizgig repo     : $FIZGIG_REPO
Fizgig ref      : $FIZGIG_REF
VCS ref         : $VCS_REF
Build date      : $BUILD_DATE
EOF

if $LOAD_TEST; then
  # The Docker exporter writes the image tar to stdout. Stream it straight into
  # the isolated test daemon so no image layers are imported into /var/lib/docker.
  # Capture docker-load stderr separately: if BuildKit fails before producing a
  # tar stream, docker load otherwise adds a misleading "invalid archive" error.
  load_err="$(mktemp)"
  trap 'rm -f "$load_err"' EXIT

  set +e
  docker buildx build "${args[@]}" --output type=docker,dest=- . \
    | docker --host "$TEST_DOCKER_HOST" load 2>"$load_err"
  pipe_status=("${PIPESTATUS[@]}")
  set -e

  build_status="${pipe_status[0]:-1}"
  load_status="${pipe_status[1]:-1}"
  if (( build_status != 0 )); then
    exit "$build_status"
  fi
  if (( load_status != 0 )); then
    cat "$load_err" >&2
    die "docker-test failed to load the completed image stream"
  fi

  rm -f "$load_err"
  trap - EXIT
  docker --host "$TEST_DOCKER_HOST" image inspect "$IMAGE:$TAG" >/dev/null
  echo "Loaded $IMAGE:$TAG into docker-test ($TEST_DOCKER_HOST)"
else
  docker buildx build "${args[@]}" .
fi
