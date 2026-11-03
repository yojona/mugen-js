#!/bin/bash
# Build (once) and run the MUGEN side of the harness. Output: work/out/mugen.log
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
"$HERE/build-probes.sh"
GAMESPEED=$([ -n "${INPUTS:-}" ] && echo "${GAMESPEED:-10}" || echo 60) P1="${P1:-}" P2="${P2:-}" P3="${P3:-}" P4="${P4:-}" "$HERE/prepare.sh"
docker build -q --platform linux/amd64 -t mugen-harness "$HERE"
docker run --rm --platform linux/amd64 --cap-add=SYS_PTRACE --security-opt seccomp=unconfined -e STEPS="${STEPS:-700}" -e SEED="${SEED:-1}" -e P1="${P1:-probe}" -e P2="${P2:-probe}" -e PEEK="${PEEK:-}" -e PEEKALL="${PEEKALL:-}" -e NOPROBE="${NOPROBE:-}" -e STEP_DELAY="${STEP_DELAY:-0.03}" -e RNGLOG="${RNGLOG:-}" -e P1AI="${P1AI:-}" -e P2AI="${P2AI:-}" -e P3="${P3:-}" -e P4="${P4:-}" -e P3AI="${P3AI:-}" -e P4AI="${P4AI:-}" -e DIFFICULTY="${DIFFICULTY:-4}" -e ROUNDS="${ROUNDS-1}" -e INPUTS="${INPUTS:+/mugen/inputs/$(basename "$INPUTS")}" \
  -v "$HERE/work/mugen:/mugen" -v "$HERE/work/out:/out" mugen-harness
