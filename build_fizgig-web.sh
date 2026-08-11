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
  --load               Load into local Docker instead of pushing
  --no-push            Build/cache only; do not push or load
  --no-cache           Disable Docker build cache
  --prune-hard         Prune all cache from the selected Buildx builder first

Fizgig runtime:
  --fizgig-ref <ref>   Upstream Fizgig branch/tag/commit (default: master)
  --fizgig-repo <url>  Fizgig source repo URL

Examples:
  ./build_fizgig-web.sh
  ./build_fizgig-web.sh --tag test2
  ./build_fizgig-web.sh --load --tag local-test
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
NO_CACHE=false
PRUNE_HARD=false
FIZGIG_REF="master"
FIZGIG_REPO="https://github.com/shootthesound/Fizgig.git"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --builder) BUILDER="${2:?}"; shift 2 ;;
    --image) IMAGE="${2:?}"; shift 2 ;;
    --tag) TAG="${2:?}"; shift 2 ;;
    --platform) PLATFORM="${2:?}"; shift 2 ;;
    --load) LOAD=true; PUSH=false; shift ;;
    --no-push) PUSH=false; LOAD=false; shift ;;
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

if $LOAD && [[ "$PLATFORM" == *,* ]]; then
  die "--load supports only one platform"
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
Image      : $IMAGE:$TAG
Builder    : $BUILDER
Platform   : $PLATFORM
Push       : $PUSH
Load       : $LOAD
Fizgig repo: $FIZGIG_REPO
Fizgig ref : $FIZGIG_REF
VCS ref    : $VCS_REF
Build date : $BUILD_DATE
EOF

docker buildx build "${args[@]}" .
