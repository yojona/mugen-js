#!/bin/bash
# Inside the container: start MUGEN in quick-VS mode, pause it and record
# STEPS ticks by alternating F9 (Lua state dump) and ScrollLock (framestep).
# /mugen is a writable copy of the MUGEN folder with the harness overlay.
set -u
STEPS=${STEPS:-700}
SEED=${SEED:-1}
cd /mugen
rm -f mugen.log
Xvfb :99 -screen 0 1280x720x24 >/dev/null 2>&1 &
sleep 1
wine mugen.exe -p1 probe -p2 probe -p2.color 2 -s kfm -rounds 1 -nosound -sessionseed "$SEED" >/dev/null 2>&1 &

# Wait for the window and the Lua init line.
for _ in $(seq 1 120); do
  WIN=$(xdotool search --name "M.U.G.E.N" 2>/dev/null | head -1)
  [ -n "$WIN" ] && grep -q "harness: F9 bound" mugen.log 2>/dev/null && break
  sleep 0.5
done
[ -z "${WIN:-}" ] && { echo "MUGEN window not found"; tail -20 mugen.log 2>/dev/null; exit 1; }
xdotool windowactivate --sync "$WIN" 2>/dev/null; xdotool windowfocus "$WIN"

# Pause as early as possible, then step.
xdotool key --window "$WIN" Pause
sleep 0.3
for i in $(seq 1 "$STEPS"); do
  xdotool key --window "$WIN" F9
  sleep 0.02
  xdotool key --window "$WIN" Scroll_Lock
  sleep 0.04
done
xdotool key --window "$WIN" F9
sleep 0.5
grep -c '^H|' mugen.log || true
pkill -f mugen.exe; wineserver -k 2>/dev/null
cp mugen.log /out/mugen.log
echo done
