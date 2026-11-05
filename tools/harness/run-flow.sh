#!/bin/bash
# Run MUGEN's whole game flow (tools/harness/flow.py). Output: work/out/flow.log
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
"$HERE/build-probes.sh" >/dev/null
GAMESPEED="${GAMESPEED:-60}" "$HERE/prepare.sh" >/dev/null
# SELECTDEF=overlay/data/select-win.def: another roster for this run (gitignored like
# select.def; select-win.def is select.def with kyo-kofa, which has no ending, in
# place of kfm: sed 's/^kfm, /kyo-kofa, /' overlay/data/select.def).
[ -n "${SELECTDEF:-}" ] && cp "$HERE/${SELECTDEF}" "$HERE/work/mugen/data/select.def"
[ -n "${OVERLAY_EXTRA:-}" ] && cp -R "$OVERLAY_EXTRA/." "$HERE/work/mugen/"
docker build -q --platform linux/amd64 -t mugen-harness "$HERE" >/dev/null
docker run --rm --platform linux/amd64 --cap-add=SYS_PTRACE --security-opt seccomp=unconfined \
  -e SEED="${SEED:-1}" -e SECONDS_MAX="${SECONDS_MAX:-60}" -e PEEKALL="${PEEKALL:-}" -e FLOWKEYS="${FLOWKEYS:-}" -e SHOTS="${SHOTS:-}" -e FRAMEKEYS="${FRAMEKEYS:-}" -e FRAMESHOTS="${FRAMESHOTS:-}" -e KEY_DELAY="${KEY_DELAY:-0.02}" -e SHOTEVERY="${SHOTEVERY:-0}" -e CLAMP="${CLAMP:-}" -e MASH="${MASH:-}" -e CLAMP_FLOW="${CLAMP_FLOW:-11}" -e LOCKSTEP="${LOCKSTEP:-}" -e KEY_SETTLE="${KEY_SETTLE:-0.04}" \
  -v "$HERE/flow.py:/flow.py" -v "$HERE/work/mugen:/mugen" -v "$HERE/work/out:/out" --entrypoint python3 mugen-harness /flow.py
