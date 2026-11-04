#!/usr/bin/env python3
"""Compare a NOPROBE mugen.exe capture with peek-ours.ts output, by gametime.
Usage: peek-diff.py mugen.log ours.log [scale] [max reports]
scale: mugen.exe internal units per character unit for x/y/vel (GameWidth / char localcoord width)."""
import sys
# P1, P2, then P3 / P4 when both logs have them (simul captures).
NAMES = ['rs', 'rng'] + [f'p{s}.{k}' for s in (1, 2, 3, 4) for k in ('state', 'time', 'life', 'x', 'y', 'vx', 'vy')]
def load(path):
    rows = {}
    for line in open(path):
        if not line.startswith('P|'):
            continue
        v = line.strip().split('|')[2].split(',')
        if 'ERR' in v:
            continue
        gt = int(v[0])
        # Framestep reads can land before mugen.exe bumps its frame counter:
        # a repeated gametime is then the next frame's data.
        if gt in rows:
            gt += 1
        rows[gt] = v[1:]
    return rows
m, o = load(sys.argv[1]), load(sys.argv[2])
scale = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
limit = int(sys.argv[4]) if len(sys.argv) > 4 else 15
reports = 0
compared = 0
for gt in sorted(set(m) & set(o)):
    a, b = m[gt], o[gt]
    if int(a[0]) < 2:
        continue
    compared += 1
    bad = []
    for i, n in enumerate(NAMES[:min(len(a), len(b))]):
        x, y = float(a[i]), float(b[i])
        if n.split('.')[-1] in ('x', 'y', 'vx', 'vy'):
            y *= scale
            if abs(x - y) > 0.01:
                bad.append(f'{n} {x:g}≠{y:g}')
        elif x != y:
            bad.append(f'{n} {a[i]}≠{b[i]}')
    if bad:
        print(f'gt {gt}: ' + ', '.join(bad))
        reports += 1
        if reports >= limit:
            break
print(f'compared {compared} ticks (RoundState >= 2)')
