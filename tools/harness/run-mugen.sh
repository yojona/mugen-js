#!/bin/bash
# Build (once) and run the MUGEN side of the harness. Output: work/out/mugen.log
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
"$HERE/prepare.sh"
docker image inspect mugen-harness >/dev/null 2>&1 || docker build --platform linux/amd64 -t mugen-harness "$HERE"
docker run --rm --platform linux/amd64 -e STEPS="${STEPS:-700}" -e SEED="${SEED:-1}" \
  -v "$HERE/work/mugen:/mugen" -v "$HERE/work/out:/out" mugen-harness
