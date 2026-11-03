#!/usr/bin/env python3
"""Drive MUGEN under Wine: launch quick VS, pause, then for every tick read the
probes' state from memory, press the keys the input script wants for the next
tick, and framestep. Writes /out/mugen-states.log.

Env: STEPS, SEED, P1, P2 (character names), STAGE, INPUTS (path or empty)."""
import struct, os, re, subprocess, sys, time

sys.path.insert(0, '/')
import memread  # noqa: E402

STEPS = int(os.environ.get('STEPS', '700'))
# -rounds for MUGEN; empty = mugen.cfg's match rules (full matches).
ROUNDS = os.environ.get('ROUNDS', '1')
SEED = os.environ.get('SEED', '1')
P1 = os.environ.get('P1', 'probe')
P2 = os.environ.get('P2', 'probe')
STAGE = os.environ.get('STAGE', 'kfm')
INPUTS = os.environ.get('INPUTS', '')

KEYS = [
    dict(u='w', d='s', l='a', r='d', a='j', b='k', c='l', x='u', y='i', z='o', s='n'),
    dict(u='Up', d='Down', l='Left', r='Right', a='KP_4', b='KP_5', c='KP_6', x='KP_7', y='KP_8', z='KP_9', s='KP_Decimal'),
]

def parse_inputs(path):
    spans = []
    if not path:
        return spans
    for raw in open(path):
        line = re.sub(r'[#;].*$', '', raw).strip()
        if not line:
            continue
        rng, player, keys = (line.split() + [''])[:3]
        a, _, b = rng.partition('-')
        spans.append((int(a), int(b or a), int(player), keys))
    return spans

def wanted(spans, clock):
    out = [set(), set()]
    for a, b, p, keys in spans:
        if a <= clock <= b:
            out[p - 1].update(keys)
    return out

def xdo(*args):
    subprocess.run(['xdotool', *args], check=False)


# RNGLOG: every write of the match RNG (G+0x12840) is logged by a stub in
# the code cave after .text: site, then three dwords from the stack (caller
# return addresses), in a ring in the free tail of the .data page.
RNG_SITES = [0x410c3e, 0x410ce0, 0x4255ea, 0x425663, 0x42e838, 0x431c0b, 0x431c61, 0x431d39, 0x431fe2,
             0x432110, 0x432284, 0x432305, 0x4323a7, 0x432417, 0x432501, 0x441664, 0x4416ce]
RNG_CAVE = 0x4dda60
RNG_IDX = 0x505700
RNG_RING = 0x505710
RNG_MAX = 96


def install_rnglog(pid):
    with open(f'/proc/{pid}/mem', 'r+b', 0) as mem:
        def rd(a, n):
            mem.seek(a)
            return mem.read(n)
        def w(a, b):
            mem.seek(a)
            mem.write(b)
        cave = RNG_CAVE
        for site in RNG_SITES:
            orig = rd(site, 6)
            assert orig[0] == 0x89 and orig[2:] == b'\x40\x28\x01\x00', (hex(site), orig.hex())
            c = bytearray(orig)
            c += b'\x9c\x50\x51'                                   # pushfd; push eax; push ecx
            c += b'\x8b\x0d' + struct.pack('<I', RNG_IDX)          # mov ecx, [idx]
            c += b'\x83\xf9' + bytes([RNG_MAX - 1])                 # cmp ecx, MAX-1
            c += b'\x76\x02\x31\xc9'                               # jbe +2; xor ecx, ecx
            c += b'\x89\xc8\xc1\xe0\x04'                           # mov eax, ecx; shl eax, 4
            c += b'\xc7\x80' + struct.pack('<II', RNG_RING, site)  # mov [eax+ring], site
            c += b'\x8b\x4c\x24\x0c\x89\x88' + struct.pack('<I', RNG_RING + 4)   # [esp+12]
            c += b'\x8b\x4c\x24\x10\x89\x88' + struct.pack('<I', RNG_RING + 8)   # [esp+16]
            c += b'\x8b\x4c\x24\x14\x89\x88' + struct.pack('<I', RNG_RING + 12)  # [esp+20]
            c += b'\xff\x05' + struct.pack('<I', RNG_IDX)          # inc dword [idx]
            c += b'\x59\x58\x9d'                                   # pop ecx; pop eax; popfd
            back = site + 6 - (cave + len(c) + 5)
            c += b'\xe9' + struct.pack('<i', back)
            w(cave, bytes(c))
            w(site, b'\xe9' + struct.pack('<i', cave - (site + 5)) + b'\x90')
            cave += len(c)
        assert cave <= 0x4de000, hex(cave)


def read_rnglog(pid):
    with open(f'/proc/{pid}/mem', 'r+b', 0) as mem:
        mem.seek(RNG_IDX)
        n = min(struct.unpack('<I', mem.read(4))[0], RNG_MAX)
        mem.seek(RNG_RING)
        raw = mem.read(16 * n)
        mem.seek(RNG_IDX)
        mem.write(struct.pack('<I', 0))
    return [struct.unpack('<IIII', raw[16 * i:16 * i + 16]) for i in range(n)]


def peek(pid, step):
    """PEEKALL=addr:fmt;... (fmt i, f or d) read every step: P|step|v1,v2,..."""
    vals = []
    with open(f'/proc/{pid}/mem', 'rb', 0) as mem:
        def rd(a, n):
            mem.seek(a)
            return mem.read(n)
        def ev(e):
            e = e.strip()
            if e.startswith('['):
                depth = 0
                for j, ch in enumerate(e):
                    depth += ch == '['
                    depth -= ch == ']'
                    if depth == 0:
                        break
                base = struct.unpack('<I', rd(ev(e[1:j]), 4))[0]
                rest = e[j + 1:]
                return base + (int(rest.lstrip('+'), 16) if rest else 0)
            return int(e, 16)
        for item in os.environ['PEEKALL'].split(';'):
            addr, fmt = item.rsplit(':', 1)
            try:
                raw = rd(ev(addr), 8)
                code = {'d': '<d', 'f': '<f'}.get(fmt, '<i')
                vals.append(str(struct.unpack(code, raw[:struct.calcsize(code)])[0]))
            except OSError:
                vals.append('ERR')
    return vals

def main():
    os.chdir('/mugen')
    for f in ('mugen.log', '/out/mugen-states.log'):
        if os.path.exists(f):
            os.remove(f)
    subprocess.Popen(['Xvfb', ':99', '-screen', '0', '1280x720x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    ai = []
    for n in (1, 2):
        if os.environ.get(f'P{n}AI'):
            ai += [f'-p{n}.ai', os.environ[f'P{n}AI']]
    subprocess.Popen(['wine', 'mugen.exe', '-p1', P1, '-p2', P2, '-p2.color', '2', '-s', STAGE, *(['-rounds', ROUNDS] if ROUNDS else []), '-nosound', '-sessionseed', SEED, *ai],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.environ.get('RNGLOG'):
        # Patch before the code first runs: under emulation, code that already
        # ran is cached and a later patch is ignored.
        t0 = time.time()
        early = None
        while early is None and time.time() - t0 < 60:
            for p in os.listdir('/proc'):
                if not p.isdigit():
                    continue
                try:
                    if open(f'/proc/{p}/comm').read().strip() == 'mugen.exe' and 'mugen.exe' in open(f'/proc/{p}/maps').read():
                        early = int(p)
                        break
                except OSError:
                    pass
            time.sleep(0.0005)
        if early:
            for _ in range(2000):
                try:
                    install_rnglog(early)
                    break
                except (OSError, AssertionError):
                    time.sleep(0.001)
            print('rnglog installed', early)
    win = ''
    for _ in range(240):
        r = subprocess.run(['xdotool', 'search', '--name', 'M.U.G.E.N'], capture_output=True, text=True)
        win = r.stdout.split('\n')[0].strip()
        if win and os.path.exists('mugen.log') and 'Match loop init' in open('mugen.log', errors='ignore').read():
            break
        time.sleep(0.5)
    if not win:
        print('MUGEN window not found'); sys.exit(1)
    xdo('windowfocus', win)
    pid = None
    for p in os.listdir('/proc'):
        if p.isdigit():
            try:
                if 'mugen.exe' in open(f'/proc/{p}/maps').read():
                    pid = int(p); break
            except OSError:
                pass
    print('pid', pid)
    spans = parse_inputs(INPUTS)
    held = [set(), set()]
    out = open('/out/mugen-states.log', 'w')

    def apply_keys(clock):
        # Keys for the next tick (clock + 1), applied as key state changes.
        want = wanted(spans, clock + 1) if clock > 0 else [set(), set()]
        batch = []
        for i in (0, 1):
            # Sorted, so simultaneous key changes reach MUGEN in a fixed order
            # (it consumes one key event per tick); mugen-web replays the same.
            for k in sorted(held[i] - want[i]):
                batch += ['keyup', KEYS[i][k]]
            for k in sorted(want[i] - held[i]):
                batch += ['keydown', KEYS[i][k]]
            held[i] = set(want[i])
        # One xdotool call per tick: separate calls are slow enough under
        # emulation for a key to miss the frame.
        if batch:
            xdo(*batch)

    def dump(step, rows):
        clock = 0
        for side, v, f in rows:
            out.write(f"S|{step}|{side}|" + ",".join(map(str, v)) + "|" + ",".join(f"{x:.4f}" for x in f) + "\n")
            if side == 1:
                clock = v[58]
        return clock

    loc = None
    if not spans:
        # No input: pause and framestep (exact, independent of speed).
        xdo('key', 'Pause')
        time.sleep(0.3)
        for step in range(1, STEPS + 1):
            if os.environ.get('NOPROBE'):
                # Any characters: no probe vars to scan for, only PEEKALL reads.
                if os.environ.get('RNGLOG') and step == 1:
                    read_rnglog(pid)
                out.write(f"P|{step}|" + ",".join(peek(pid, step)) + "\n")
                if os.environ.get('RNGLOG') and step > 1:
                    out.write(f"R|{step}|" + ";".join(f"{a:x},{b:x},{c:x},{d:x}" for a, b, c, d in read_rnglog(pid)) + "\n")
                xdo('key', 'Scroll_Lock')
                time.sleep(float(os.environ.get('STEP_DELAY', '0.03')))
                continue
            if not loc:
                loc = memread.find(pid)
                if os.environ.get('PEEK'):
                    # One-off reads of MUGEN globals: PEEK=0x5040a0:d,0x5040e8:i
                    # Addresses may dereference: [[0x5040e8]+0x12278]+0x94:i
                    with open(f'/proc/{pid}/mem', 'rb', 0) as mem:
                        def rd(a, n):
                            mem.seek(a)
                            return mem.read(n)
                        def ev(e):
                            e = e.strip()
                            if e.startswith('['):
                                depth = 0
                                for j, ch in enumerate(e):
                                    depth += ch == '['
                                    depth -= ch == ']'
                                    if depth == 0:
                                        break
                                base = struct.unpack('<I', rd(ev(e[1:j]), 4))[0]
                                rest = e[j + 1:]
                                return base + (int(rest.lstrip('+'), 16) if rest else 0)
                            return int(e, 16)
                        for item in os.environ['PEEK'].split(';'):
                            addr, fmt = item.rsplit(':', 1)
                            try:
                                raw = rd(ev(addr), 8)
                            except OSError:
                                out.write(f"PEEK|{addr}|ERR\n")
                                continue
                            val = struct.unpack('<d' if fmt == 'd' else '<i', raw[:8 if fmt == 'd' else 4])[0]
                            out.write(f"PEEK|{addr}|{val}\n")
            dump(step, memread.read(pid, loc))
            if os.environ.get('PEEKALL'):
                out.write(f"P|{step}|" + ",".join(peek(pid, step)) + "\n")
            xdo('key', 'Scroll_Lock')
            time.sleep(float(os.environ.get('STEP_DELAY', '0.03')))
    else:
        # MUGEN ignores the keyboard while paused, so with input the game runs
        # slowly (GameSpeed in mugen.cfg) and we follow gametime in memory.
        last_gt = None
        missed = 0
        torn_count = 0
        step = 0
        deadline = time.time() + 1200
        while step < STEPS and time.time() < deadline:
            if not loc:
                loc = memread.find(pid)
                if not loc:
                    time.sleep(0.01)
                    continue
            rows = memread.read(pid, loc)
            p1 = next((v for side, v, f in rows if side == 1), None)
            if p1 is None:
                time.sleep(0.002)
                continue
            gt = p1[55]
            if gt == last_gt:
                time.sleep(0.002)
                continue
            # The frame may still be in progress (P1 updated, P2 not yet):
            # wait until every player reports the same gametime.
            settle = time.time() + 0.05
            # var(38) is the probe's last capture write.
            while time.time() < settle and any(v[55] != gt or v[38] != gt for side, v, f in rows):
                time.sleep(0.001)
                rows = memread.read(pid, loc)
            torn = any(v[55] != gt or v[38] != gt for side, v, f in rows)
            if torn:
                torn_count += 1
            if last_gt is not None and gt != last_gt + 1:
                missed += gt - last_gt - 1
            last_gt = gt
            step += 1
            clock = dump(step, rows)
            if os.environ.get('PEEKALL'):
                out.write(f"P|{step}|" + ",".join(peek(pid, step)) + "\n")
            # Change keys only once this frame has fully finished (so no part
            # of frame N sees tick N+1's keys) and well before the next one.
            time.sleep(float(os.environ.get('KEY_DELAY', '0.03')))
            apply_keys(clock)
        print('missed ticks', missed, 'torn reads', torn_count)
    out.close()
    subprocess.run(['pkill', '-f', 'mugen.exe']); subprocess.run(['wineserver', '-k'])
    subprocess.run(['cp', 'mugen.log', '/out/mugen.log'])
    print('done', STEPS)

main()
