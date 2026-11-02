#!/bin/bash
# Inside the container: start MUGEN in quick-VS mode, pause it and record
# STEPS ticks by alternating F3 (Lua state dump) and ScrollLock (framestep).
# /mugen is a writable copy of the MUGEN folder with the harness overlay.
set -u
STEPS=${STEPS:-700}
SEED=${SEED:-1}
cd /mugen
rm -f mugen.log /out/mugen-states.log
Xvfb :99 -screen 0 1280x720x24 >/dev/null 2>&1 &
sleep 1
wine mugen.exe -p1 probe -p2 probe -p2.color 2 -s kfm -rounds 1 -nosound -sessionseed "$SEED" >/dev/null 2>&1 &

# Wait for the window and the Lua init line.
for _ in $(seq 1 120); do
  WIN=$(xdotool search --name "M.U.G.E.N" 2>/dev/null | head -1)
  [ -n "$WIN" ] && grep -q "Match loop init" mugen.log 2>/dev/null && break
  sleep 0.5
done
[ -z "${WIN:-}" ] && { echo "MUGEN window not found"; tail -20 mugen.log 2>/dev/null; exit 1; }
xdotool windowactivate --sync "$WIN" 2>/dev/null; xdotool windowfocus "$WIN"

# Pause as early as possible, then step: read memory, framestep, repeat.
PID=$(pgrep -f 'mugen.exe' | while read p; do grep -q 'mugen.exe' /proc/$p/maps 2>/dev/null && echo $p; done | head -1)
echo "pid=$PID"
xdotool key Pause
sleep 0.3
rm -f /tmp/loc.json
for i in $(seq 1 "$STEPS"); do
  python3 /memread.py "$PID" "$i" /tmp/loc.json >> /out/mugen-states.log 2>/dev/null || rm -f /tmp/loc.json
  xdotool key Scroll_Lock
  sleep "${STEP_DELAY:-0.05}"
done
wc -l < /out/mugen-states.log
pkill -f mugen.exe; wineserver -k 2>/dev/null
cp mugen.log /out/mugen.log
echo done
