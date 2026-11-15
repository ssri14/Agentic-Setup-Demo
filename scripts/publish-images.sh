#!/usr/bin/env bash
# Build the three application images for amd64 and arm64 and push them to Docker Hub.
#
#   docker login                          # as ssri14 (or the account in IMAGE_NAMESPACE)
#   ./scripts/publish-images.sh           # tag from IMAGE_TAG or 1.0.4, plus "latest"
#   ./scripts/publish-images.sh 1.0.1     # another tag
#
# Environment: IMAGE_NAMESPACE (default ssri14), PLATFORMS (default linux/amd64,linux/arm64),
#              NO_LATEST=1 to skip the "latest" tag.
set -euo pipefail
cd "$(dirname "$0")/.."

NS="${IMAGE_NAMESPACE:-ssri14}"
TAG="${1:-${IMAGE_TAG:-1.0.4}}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER=mission-analysis-builder

docker buildx inspect "$BUILDER" >/dev/null 2>&1 || docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
docker buildx inspect "$BUILDER" --bootstrap >/dev/null

build() {   # name, context
  local tags=(-t "$NS/$1:$TAG")
  [ -n "${NO_LATEST:-}" ] || tags+=(-t "$NS/$1:latest")
  echo "==> $NS/$1:$TAG  ($PLATFORMS)  from $2"
  docker buildx build --builder "$BUILDER" --platform "$PLATFORMS" "${tags[@]}" \
    --label "org.opencontainers.image.source=https://github.com/ssri14/Agentic-Setup-Demo" \
    --label "org.opencontainers.image.version=$TAG" --push "$2"
}

build mission-analysis-ingestion data-ingestion
build mission-analysis-agent     mission-analysis-agent
build mission-analysis-sandbox   mission-analysis-agent/sandbox

echo
echo "Pushed $NS/mission-analysis-{ingestion,agent,sandbox}:$TAG for $PLATFORMS."
echo "Elsewhere: clone the repository, then in data-ingestion/: python3 scripts/setup.py && docker compose pull"
