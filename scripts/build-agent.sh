#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist/agent"
VERSION="0.1.0"
PROTOCOL_VERSION="1"

mkdir -p "${OUT_DIR}"

targets=(
  "linux amd64"
  "linux arm64"
  "darwin amd64"
  "darwin arm64"
)

entries=()
for target in "${targets[@]}"; do
  os="${target%% *}"
  arch="${target##* }"
  name="agent-${VERSION}-${os}-${arch}"
  GOOS="${os}" GOARCH="${arch}" go build -ldflags="-s -w" -o "${OUT_DIR}/${name}" "${ROOT_DIR}/cmd/agent"
  sha="$(shasum -a 256 "${OUT_DIR}/${name}" | cut -d' ' -f1)"
  entries+=("{\"os\":\"${os}\",\"arch\":\"${arch}\",\"path\":\"${name}\",\"sha256\":\"${sha}\"}")
done

(
  printf '{\n  "version": "%s",\n  "protocolVersion": "%s",\n  "binaries": [\n' "${VERSION}" "${PROTOCOL_VERSION}"
  for index in "${!entries[@]}"; do
    suffix=","
    if [[ "${index}" == "$((${#entries[@]} - 1))" ]]; then
      suffix=""
    fi
    printf '    %s%s\n' "${entries[$index]}" "${suffix}"
  done
  printf '  ]\n}\n'
) > "${OUT_DIR}/manifest.json"

printf 'Built agent distribution in %s\n' "${OUT_DIR}"
