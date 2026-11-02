#!/usr/bin/env python3
"""Read the probe characters' var/fvar arrays out of MUGEN's memory.

The probe CNS writes markers: var(56) = 1297434964, var(57) = marker + TeamSide,
fvar(39) = 4242.5. We scan the Wine process for them once, then on every call
print one line per player:  S|<step>|<side>|v0,...,v59|f0,...,f39
Usage: memread.py <pid> <step> [cache-file]
"""
import json, os, re, struct, sys

MARK = 1297434964
FMARK = struct.pack('<f', 4242.5)

def regions(pid):
    for line in open(f'/proc/{pid}/maps'):
        m = re.match(r'([0-9a-f]+)-([0-9a-f]+) (\S+)', line)
        if not m or 'r' not in m.group(3) or 'w' not in m.group(3):
            continue
        a, b = int(m.group(1), 16), int(m.group(2), 16)
        if b - a > 512 * 1024 * 1024:
            continue
        yield a, b

def find(pid):
    found = {}
    pat = struct.pack('<i', MARK)
    with open(f'/proc/{pid}/mem', 'rb', 0) as mem:
        for a, b in regions(pid):
            try:
                mem.seek(a)
                data = mem.read(b - a)
            except OSError:
                continue
            i = data.find(pat)
            while i >= 0:
                if i + 8 <= len(data):
                    side = struct.unpack_from('<i', data, i + 4)[0] - MARK
                    if side in (1, 2):
                        base = a + i - 56 * 4  # address of var(0)
                        # fvar array: right after the 60 vars, or search nearby.
                        fbase = None
                        for cand in (base + 60 * 4, base + 64 * 4):
                            off = cand + 39 * 4 - a
                            if 0 <= off and off + 4 <= len(data) and data[off:off + 4] == FMARK:
                                fbase = cand
                        found.setdefault(side, []).append([base, fbase])
                i = data.find(pat, i + 4)
    return found

def read(pid, loc):
    """[(side, vars, fvars)] for each located player with valid markers."""
    rows = []
    with open(f'/proc/{pid}/mem', 'rb', 0) as mem:
        for side in sorted(loc):
            for base, fbase in loc[side]:
                mem.seek(base)
                v = struct.unpack('<60i', mem.read(240))
                if v[56] != MARK:
                    continue
                f = ()
                if fbase:
                    mem.seek(fbase)
                    f = struct.unpack('<40f', mem.read(160))
                rows.append((side, v, f))
                break
    return rows

def main():
    pid, step = int(sys.argv[1]), sys.argv[2]
    cache = sys.argv[3] if len(sys.argv) > 3 else None
    loc = None
    if cache and os.path.exists(cache):
        loc = {int(k): v for k, v in json.load(open(cache)).items()}
    if not loc:
        loc = find(pid)
        if cache:
            json.dump(loc, open(cache, 'w'))
    with open(f'/proc/{pid}/mem', 'rb', 0) as mem:
        for side in sorted(loc):
            for base, fbase in loc[side]:
                mem.seek(base)
                v = struct.unpack('<60i', mem.read(240))
                if v[56] != MARK:
                    continue  # stale copy
                f = ()
                if fbase:
                    mem.seek(fbase)
                    f = struct.unpack('<40f', mem.read(160))
                print(f"S|{step}|{side}|" + ",".join(map(str, v)) + "|" + ",".join(f"{x:.4f}" for x in f))
                break

if __name__ == '__main__':
    main()
