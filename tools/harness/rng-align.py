#!/usr/bin/env python3
"""Find where mugen.exe and mugen-js stop drawing the same random numbers.

Inputs:
  mugen.log  drive.py output with RNGLOG=1 (P| rows, then R| rows: site,s0,s1,s2;...)
  ours.txt   peek-ours.ts output with TRACERAW=1 TRACE=from,to

Every draw is reduced to a kind: 'AI' (the AI's inline draws, floor dust),
a Random trigger token (mugen.exe: the token pointer; ours: controller and
expression), or another site. The two sequences are aligned, a token map is
learnt from the matching part (majority vote), and the first difference is
printed with both sides labelled by our expression names.

Usage: rng-align.py mugen.log ours.txt [context]
"""
import re
import sys
from collections import Counter, defaultdict

mugen_path, ours_path = sys.argv[1], sys.argv[2]
ctx = int(sys.argv[3]) if len(sys.argv) > 3 else 12

def is_ai(addr):
    # The AI's code (0x430000-0x433000: inline draws and Match_Random calls)
    # and the floor dust (0x4415d0), both outside the states on our side.
    a = int(addr, 16)
    return 0x430000 <= a < 0x433000 or 0x4415d0 <= a < 0x441700

ours = []
tick = None
for line in open(ours_path):
    m = re.match(r'TRACE gt (\d+)', line)
    if m:
        tick = int(m.group(1))
        continue
    if tick is None or not line.startswith('  ') or re.match(r'  \d+x ', line):
        continue
    x = line.strip()
    if x.startswith('=>'):
        continue
    ours.append(('AI' if x == '(outside states)' else x, tick))

mug = []
tick = None
for line in open(mugen_path):
    if line.startswith('P|'):
        tick = int(line.split('|')[2].split(',')[0])
    elif line.startswith('R|') and tick is not None:
        body = line.strip().split('|')[2]
        for e in body.split(';') if body else []:
            site, s0, s1, _ = e.split(',')
            if site == '425663' and s1 == '457149':
                kind = s0                      # Random trigger token
            elif is_ai(site) or (site == '425663' and is_ai(s1)):
                kind = 'AI'
            else:
                kind = f'{site}<{s1}'
            mug.append((kind, tick))

# Same window: mugen.exe rows from the tick before our first traced one.
if ours:
    mug = [m for m in mug if m[1] >= ours[0][1] - 1]
oc = [k for k, _ in ours]
mc = [k for k, _ in mug]


def run(start):
    k = 0
    while start + k < len(mc) and k < len(oc):
        if (mc[start + k] == 'AI') != (oc[k] == 'AI'):
            return k
        k += 1
    return k


k, start = max((run(s), s) for s in range(0, 80))
votes = defaultdict(Counter)
for i in range(max(0, k - ctx * 2)):
    a, b = mc[start + i], oc[i]
    if a != 'AI':
        votes[a][b] += 1
name = {p: c.most_common(1)[0][0] for p, c in votes.items()}

# First token whose learnt name differs from ours.
first = k
for i in range(k):
    a, b = mc[start + i], oc[i]
    # Only Random trigger tokens identify a controller; other draws (Explod,
    # dust...) share a call site and are compared by kind only.
    if a != 'AI' and '<' not in a and name.get(a, '?') != b:
        first = i
        break
print(f'aligned {first} draws; ours tick {ours[first][1] if first < len(ours) else "-"}, '
      f'mugen tick {mug[start + first][1] if start + first < len(mug) else "-"}')
lab = lambda x: x if x == 'AI' else name.get(x, '??' + x)
short = lambda s: re.sub(r'^\S+ (-?\d+) ', r'\1 ', s.replace('.cns:', ':'))
print('mugen:')
for x, t in mug[start + first - ctx:start + first + ctx]:
    print(f'  {t} {short(lab(x))}')
print('ours:')
for x, t in ours[first - ctx:first + ctx]:
    print(f'  {t} {short(x)}')
