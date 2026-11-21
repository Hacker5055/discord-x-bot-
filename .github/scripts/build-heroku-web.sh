#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || -z "$1" ]]; then
  echo 'Usage: build-heroku-web.sh <image-tag>' >&2
  exit 2
fi
image=$1
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/black-x-web.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT

docker buildx build --platform linux/amd64 --load --provenance=false --sbom=false --tag "$image" . >&2
archive="$scratch/web.tar"
# The local Docker ID and Buildx metadata can describe an index rather than a configuration.
# Save the selected platform and hash the actual config blob found in the Docker archive.
docker image save --platform linux/amd64 --output "$archive" "$image" >&2
if ! config_path=$(tar -xOf "$archive" -- manifest.json | jq -er '
  select(type == "array" and length == 1) | .[0].Config | strings |
  select(test("^(blobs/sha256/[0-9a-f]{64}|[0-9a-f]{64}\\.json)$"))'); then
  echo '::error::The Docker archive does not contain one identifiable web image configuration.' >&2
  exit 1
fi
tar -xOf "$archive" -- "$config_path" > "$scratch/config.json"
if ! jq -e '.os == "linux" and .architecture == "amd64"' "$scratch/config.json" >/dev/null; then
  echo '::error::The exported web image configuration is not Linux AMD64.' >&2
  exit 1
fi
checksum=$(sha256sum "$scratch/config.json")
printf 'sha256:%s\n' "${checksum%% *}"
