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
                out.write(f"P|{step}|" + ",".join(peek(pid, step)) + "\n")
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
