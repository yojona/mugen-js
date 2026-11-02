#!/usr/bin/env python3
"""Drive MUGEN under Wine: launch quick VS, pause, then for every tick read the
probes' state from memory, press the keys the input script wants for the next
tick, and framestep. Writes /out/mugen-states.log.

Env: STEPS, SEED, P1, P2 (character names), STAGE, INPUTS (path or empty)."""
import os, re, subprocess, sys, time

sys.path.insert(0, '/')
import memread  # noqa: E402

STEPS = int(os.environ.get('STEPS', '700'))
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

def main():
    os.chdir('/mugen')
    for f in ('mugen.log', '/out/mugen-states.log'):
        if os.path.exists(f):
            os.remove(f)
    subprocess.Popen(['Xvfb', ':99', '-screen', '0', '1280x720x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    subprocess.Popen(['wine', 'mugen.exe', '-p1', P1, '-p2', P2, '-p2.color', '2', '-s', STAGE, '-rounds', '1', '-nosound', '-sessionseed', SEED],
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
    xdo('key', 'Pause')
    time.sleep(0.3)
    spans = parse_inputs(INPUTS)
    held = [set(), set()]
    loc = None
    out = open('/out/mugen-states.log', 'w')
    for step in range(1, STEPS + 1):
        if not loc:
            loc = memread.find(pid)
        rows = memread.read(pid, loc)
        clock = 0
        for side, v, f in rows:
            out.write(f"S|{step}|{side}|" + ",".join(map(str, v)) + "|" + ",".join(f"{x:.4f}" for x in f) + "\n")
            if side == 1:
                clock = v[58]
        # Keys for the next tick (clock + 1), applied as key state changes.
        want = wanted(spans, clock + 1) if clock > 0 else [set(), set()]
        for i in (0, 1):
            for k in held[i] - want[i]:
                xdo('keyup', KEYS[i][k])
            for k in want[i] - held[i]:
                xdo('keydown', KEYS[i][k])
            held[i] = set(want[i])
        xdo('key', 'Scroll_Lock')
        time.sleep(float(os.environ.get('STEP_DELAY', '0.03')))
    out.close()
    subprocess.run(['pkill', '-f', 'mugen.exe']); subprocess.run(['wineserver', '-k'])
    subprocess.run(['cp', 'mugen.log', '/out/mugen.log'])
    print('done', STEPS)

main()
