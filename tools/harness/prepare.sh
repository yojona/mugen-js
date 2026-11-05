#!/bin/bash
# Assemble tools/harness/work/mugen: the reference MUGEN tree + harness overlay,
# with a mugen.cfg tuned for headless runs (software renderer, windowed, debug keys).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REF="$HERE/../../ref/mugen-1.1b1"
WORK="$HERE/work/mugen"
rm -rf "$HERE/work" && mkdir -p "$WORK" "$HERE/work/out"
# Everything but chars/, then only the characters this run uses (the pack is big).
for f in "$REF"/* "$REF"/.[!.]*; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" = chars ] && continue
  cp -R "$f" "$WORK/"
done
mkdir -p "$WORK/chars"
for c in kfm kfm720 ${P1:-} ${P2:-} ${P3:-} ${P4:-}; do
  [ -d "$REF/chars/$c" ] && [ ! -d "$WORK/chars/$c" ] && cp -R "$REF/chars/$c" "$WORK/chars/"
done
cp -R "$HERE/overlay/." "$WORK/"
mkdir -p "$WORK/inputs" && cp "$HERE/inputs/"*.txt "$WORK/inputs/"
CFG="$WORK/data/mugen.cfg"
sed -i '' -E 's/^RenderMode *=.*/RenderMode = System/; s/^FullScreen *=.*/FullScreen = 0/; s/^motif *=.*/motif = data\/system.def/; s/^GameWidth *=.*/GameWidth = 640/; s/^GameHeight *=.*/GameHeight = 480/' "$CFG"
# MOTIF=data/mugen1/system.def GAMEW=1280 GAMEH=720: another motif / window size (the screenshots need it).
[ -n "${MOTIF:-}" ] && sed -i '' -E "s#^motif *=.*#motif = ${MOTIF}#" "$CFG"
[ -n "${GAMEW:-}" ] && sed -i '' -E "s/^GameWidth *=.*/GameWidth = ${GAMEW}/; s/^GameHeight *=.*/GameHeight = ${GAMEH}/" "$CFG"
# [Config] GameSpeed (frames per second; MUGEN asks for at least 10).
sed -i '' -E "s/^GameSpeed *= *60\$/GameSpeed = ${GAMESPEED:-60}/" "$CFG"
# [Options] Difficulty = the CPU's AILevel (-pN.ai only turns the AI on).
sed -i '' -E "s/^Difficulty *=.*/Difficulty = ${DIFFICULTY:-4}/" "$CFG"
grep -n -E '^(Difficulty|RenderMode|FullScreen|motif|GameWidth|GameHeight|AllowDebugKeys|AllowDebugMode)' "$CFG"
echo "ready: $WORK"
