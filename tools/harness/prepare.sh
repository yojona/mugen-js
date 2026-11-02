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
mkdir -p "$WORK/inputs" && cp "$HERE/inputs/"*.txt "$WORK/inputs/"
CFG="$WORK/data/mugen.cfg"
sed -i '' -E 's/^RenderMode *=.*/RenderMode = System/; s/^FullScreen *=.*/FullScreen = 0/; s/^motif *=.*/motif = data\/system.def/; s/^GameWidth *=.*/GameWidth = 640/; s/^GameHeight *=.*/GameHeight = 480/' "$CFG"
# [Config] GameSpeed (frames per second; MUGEN asks for at least 10).
sed -i '' -E "s/^GameSpeed *= *60\$/GameSpeed = ${GAMESPEED:-60}/" "$CFG"
# [Options] Difficulty = the CPU's AILevel (-pN.ai only turns the AI on).
sed -i '' -E "s/^Difficulty *=.*/Difficulty = ${DIFFICULTY:-4}/" "$CFG"
grep -n -E '^(Difficulty|RenderMode|FullScreen|motif|GameWidth|GameHeight|AllowDebugKeys|AllowDebugMode)' "$CFG"
echo "ready: $WORK"
