#!/bin/bash
# Assemble tools/harness/work/mugen: the reference MUGEN tree + harness overlay,
# with a mugen.cfg tuned for headless runs (software renderer, windowed, debug keys).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REF="$HERE/../../ref/mugen-1.1b1"
WORK="$HERE/work/mugen"
rm -rf "$HERE/work" && mkdir -p "$WORK" "$HERE/work/out"
cp -R "$REF/." "$WORK/"
cp -R "$HERE/overlay/." "$WORK/"
CFG="$WORK/data/mugen.cfg"
sed -i '' -E 's/^RenderMode *=.*/RenderMode = System/; s/^FullScreen *=.*/FullScreen = 0/; s/^motif *=.*/motif = data\/system.def/; s/^GameWidth *=.*/GameWidth = 640/; s/^GameHeight *=.*/GameHeight = 480/' "$CFG"
grep -n -E '^(RenderMode|FullScreen|motif|GameWidth|GameHeight|AllowDebugKeys|AllowDebugMode)' "$CFG"
echo "ready: $WORK"
