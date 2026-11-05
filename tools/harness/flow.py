#!/usr/bin/env python3
"""Drive MUGEN through its whole game flow (title, menus, select, fights...)
without the quick-VS command line. Polls memory (PEEKALL, same syntax as
drive.py) as fast as it can and logs every change with the time it was seen.

Env:
  SECONDS_MAX  run time limit (default 60)
  SEED         -sessionseed
  PEEKALL      addr:fmt;... values to watch (fmt i, f or d)
  FLOWKEYS     time-based key script: "t:key[+key...];..." (t in seconds from
               launch, keys are xdotool names, pressed and released)
  SHOTS        comma list of seconds at which to save /out/shot-<t>.xwd
  GT           address of the frame counter (default [0x5040e8]+0x11e98,
               which runs on every screen)
  FRAMEKEYS    frame-based key script "f:key[+key...][:hold];..." where f is
               the frame counter value: the keys go down right after frame f
               is seen and up after `hold` frames (default 2)
  FRAMESHOTS   comma list of frame counter values to dump /out/f<frame>.xwd
  SHOTEVERY    also dump every N frames (0 = off) and on every gameflow change
  CLAMP        "addr:max;..." after every frame, values above max are set to
               max (e.g. a player's life, p+0x1b8)
  MASH         "flow:key:every:hold": while the gameflow (FLOW_ADDR) equals
               flow and RoundState (RS_ADDR) is 2, press key on frames where
               frame % every == 0
  FLOW_ADDR    default [0x5040c4]
  LOCKSTEP     1 = virtual clock: QueryPerformanceCounter and timeGetTime
               are redirected (IAT) to stubs reading a time the driver
               advances, so mugen.exe runs exactly when allowed and keys go
               in between frames (deterministic, menus included)
Output: /out/flow.log lines "C|ms|v1,v2,..." on change, K|ms|keys, and
/out/mugen.log."""
import os, struct, subprocess, sys, time

T0 = time.time()
SECONDS_MAX = float(os.environ.get('SECONDS_MAX', '60'))
SEED = os.environ.get('SEED', '1')


def ms():
    return int((time.time() - T0) * 1000)


# Lockstep: stubs in the zero padding after .text, the clock after .data.
CAVE = 0x4dda00
VT = 0x505f00          # int64 QPC ticks (10 MHz), then int32 ms at VT + 8
IAT_QPC = 0x4de058
IAT_TGT = 0x4de510


def install_lockstep(mem, vt0):
    def w(addr, data):
        mem.seek(addr)
        mem.write(data)
    w(VT, struct.pack('<qI', vt0, vt0 // 10000))
    inc = b'\xff\x05' + struct.pack('<I', VT + 12)   # count clock reads
    qpc = inc + (b'\x8b\x44\x24\x04' + b'\x8b\x0d' + struct.pack('<I', VT) + b'\x89\x08' +
           b'\x8b\x0d' + struct.pack('<I', VT + 4) + b'\x89\x48\x04' + b'\xb8\x01\x00\x00\x00' + b'\xc2\x04\x00')
    tgt = inc + b'\xa1' + struct.pack('<I', VT + 8) + b'\xc3'
    w(CAVE, qpc)
    w(CAVE + 0x40, tgt)
    w(IAT_QPC, struct.pack('<I', CAVE))
    w(IAT_TGT, struct.pack('<I', CAVE + 0x40))


def clock_reads(mem):
    mem.seek(VT + 12)
    return struct.unpack('<I', mem.read(4))[0]


def wait_idle(mem, n=3, timeout=1.0):
    """Wait until the game has read the frozen clock n more times: it is
    then spinning in its frame wait, between frames."""
    c0 = clock_reads(mem)
    end = time.time() + timeout
    while time.time() < end and (clock_reads(mem) - c0) & 0xffffffff < n:
        time.sleep(0.0005)


def set_vt(mem, vt):
    mem.seek(VT)
    mem.write(struct.pack('<qI', vt, (vt // 10000) & 0xffffffff))


def main():
    os.chdir('/mugen')
    for f in ('mugen.log', '/out/flow.log'):
        if os.path.exists(f):
            os.remove(f)
    subprocess.Popen(['Xvfb', ':99', '-screen', '0', '1280x720x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    subprocess.Popen(['wine', 'mugen.exe', '-nosound', '-sessionseed', SEED], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    lock = os.environ.get('LOCKSTEP') == '1'
    pid = None
    while pid is None and time.time() - T0 < 60:
        for p in os.listdir('/proc'):
            if p.isdigit():
                try:
                    # The game process itself (not the wine launcher).
                    if open(f'/proc/{p}/comm').read().strip() == 'mugen.exe' and 'mugen.exe' in open(f'/proc/{p}/maps').read():
                        pid = int(p); break
                except OSError:
                    pass
        time.sleep(0.005)
    early_vt = None
    if lock:
        # Take over the clock as soon as the image is mapped, before the
        # game reads it: every run then starts from the same frame.
        with open(f'/proc/{pid}/mem', 'r+b', 0) as m0:
            # Wait for the loader to bind the imports: unbound, a slot holds
            # a small hint/name RVA; bound, a DLL address outside the image.
            while time.time() - T0 < 60:
                try:
                    m0.seek(IAT_QPC)
                    q = struct.unpack('<I', m0.read(4))[0]
                    m0.seek(IAT_TGT)
                    t = struct.unpack('<I', m0.read(4))[0]
                    bound = lambda v: v >= 0x200000 and not 0x400000 <= v < 0x520000
                    if bound(q) and bound(t):
                        break
                except OSError as e:
                    q = t = repr(e)
                time.sleep(0.0002)
            early_vt = time.monotonic_ns() // 100
            install_lockstep(m0, early_vt)
    win = ''
    with open(f'/proc/{pid}/mem', 'r+b', 0) as m0:
        vt_boot = early_vt
        for _ in range(1200):
            r = subprocess.run(['xdotool', 'search', '--name', 'M.U.G.E.N'], capture_output=True, text=True)
            win = r.stdout.split('\n')[0].strip()
            if win:
                break
            if lock:
                # Real time while the game starts up (before the title).
                vt_boot = early_vt + (time.monotonic_ns() // 100 - early_vt)
                set_vt(m0, vt_boot)
            time.sleep(0.05 if lock else 0.25)
    if not win:
        print('MUGEN window not found'); sys.exit(1)
    subprocess.run(['xdotool', 'windowfocus', win])
    print('pid', pid)
    all_items = [i for i in os.environ.get('PEEKALL', '').split(';') if i]
    # PEEK_FROM=frame:n: only the first n values before that frame (a long
    # list read every step shifts the keys sent before the fight).
    peek_from, peek_light = (int(x) for x in (os.environ.get('PEEK_FROM') or '0:0').split(':'))
    items = all_items[:peek_light] if peek_from else all_items
    keys = []
    for part in os.environ.get('FLOWKEYS', '').split(';'):
        if part.strip():
            t, k = part.split(':', 1)
            keys.append((float(t), k.split('+')))
    keys.sort()
    shots = sorted(float(s) for s in os.environ.get('SHOTS', '').split(',') if s.strip())
    gt_addr = os.environ.get('GT', '[0x5040e8]+0x11e98')
    fkeys = []
    for part in os.environ.get('FRAMEKEYS', '').split(';'):
        if part.strip():
            bits = part.split(':')
            fkeys.append((int(bits[0]), bits[1].split('+'), int(bits[2]) if len(bits) > 2 else 2))
    fkeys.sort()
    fshots = sorted(int(s) for s in os.environ.get('FRAMESHOTS', '').split(',') if s.strip())
    releases = []
    last_gt = None
    out = open('/out/flow.log', 'w')
    last = None
    clamps = [c.rsplit(':', 1) for c in os.environ.get('CLAMP', '').split(';') if c.strip()]
    mash = os.environ.get('MASH', '').split(':') if os.environ.get('MASH') else None
    flow_addr = os.environ.get('FLOW_ADDR', '[0x5040c4]')
    every = int(os.environ.get('SHOTEVERY', '0'))
    last_flow = None
    with open(f'/proc/{pid}/mem', 'r+b', 0) as mem:
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

        vt = None
        if lock:
            mem.seek(VT)
            vt = struct.unpack('<q', mem.read(8))[0]
            out.write(f"LOCK|{ms()}|{vt}\n")
        frame_done = False
        keys_sent = False
        last_bump = 0.0
        while time.time() - T0 < SECONDS_MAX:
            if lock:
                # One frame period per frame, only once the last frame is
                # done (no catch-up frames); again if nothing happens (loading).
                if frame_done or time.time() - last_bump > 0.5:
                    if frame_done and keys_sent:
                        # Let the keys reach the game while it waits.
                        time.sleep(float(os.environ.get('KEY_SETTLE', '0.04')))
                        wait_idle(mem)
                    frame_done = False
                    keys_sent = False
                    vt += int(os.environ.get('VT_PERIOD', '166667'))
                    set_vt(mem, vt)
                    last_bump = time.time()
                time.sleep(0.0005)
            vals = []
            for item in items:
                addr, fmt = item.rsplit(':', 1)
                try:
                    code = {'d': '<d', 'f': '<f'}.get(fmt, '<i')
                    raw = rd(ev(addr), 8)
                    vals.append(str(struct.unpack(code, raw[:struct.calcsize(code)])[0]))
                except (OSError, struct.error, ValueError):
                    vals.append('ERR')
            if vals != last:
                out.write(f"C|{ms()}|" + ",".join(vals) + "\n")
                last = vals
            try:
                gt = struct.unpack('<i', rd(ev(gt_addr), 4))[0]
            except (OSError, struct.error):
                gt = None
            if gt is not None and gt != last_gt:
                last_gt = gt
                if peek_from and gt >= peek_from:
                    items = all_items
                if lock:
                    # The clock stopped: let the frame finish, then read it.
                    wait_idle(mem)
                    vals = []
                    for item in items:
                        addr, fmt = item.rsplit(':', 1)
                        try:
                            code = {'d': '<d', 'f': '<f'}.get(fmt, '<i')
                            raw = rd(ev(addr), 8)
                            vals.append(str(struct.unpack(code, raw[:struct.calcsize(code)])[0]))
                        except (OSError, struct.error, ValueError):
                            vals.append('ERR')
                    if vals != last:
                        out.write(f"C|{ms()}|" + ",".join(vals) + "\n")
                        last = vals
                out.write(f"F|{ms()}|{gt}\n")
                frame_done = True
                # Let the frame finish before touching the keyboard.
                time.sleep(float(os.environ.get('KEY_DELAY', '0.02')))
                try:
                    flow = struct.unpack('<i', rd(ev(flow_addr), 4))[0]
                except (OSError, struct.error):
                    flow = None
                for addr, mx in (clamps if flow == int(os.environ.get('CLAMP_FLOW', '11')) else []):
                    try:
                        a = ev(addr)
                        v = struct.unpack('<i', rd(a, 4))[0]
                        if v > int(mx):
                            mem.seek(a)
                            mem.write(struct.pack('<i', int(mx)))
                            out.write(f"CL|{gt}|{addr}|{v}\n")
                    except (OSError, struct.error):
                        pass
                if flow != last_flow or (every and gt % every == 0):
                    subprocess.run(['sh', '-c', f'xwd -root -silent > /out/f{gt:06d}.xwd'])
                    if flow != last_flow:
                        out.write(f"FL|{gt}|{flow}\n")
                    last_flow = flow
                try:
                    rs = struct.unpack('<i', rd(ev(os.environ.get('RS_ADDR', '[0x5040e8]+0x12754')), 4))[0]
                except (OSError, struct.error):
                    rs = None
                # Only while fighting (RoundState 2): a button skips the VS screen.
                if mash and flow == int(mash[0]) and rs == 2 and gt % int(mash[2]) == 0:
                    fkeys.insert(0, (gt, mash[1].split('+'), int(mash[3])))
                while fshots and fshots[0] <= gt:
                    f = fshots.pop(0)
                    subprocess.run(['sh', '-c', f'xwd -root -silent > /out/f{f:06d}.xwd'])
                ups = [r for r in releases if r[0] <= gt]
                releases = [r for r in releases if r[0] > gt]
                for _, ks in ups:
                    subprocess.run(['xdotool', 'keyup', *ks])
                    out.write(f"KU|{gt}|{'+'.join(ks)}\n")
                    keys_sent = True
                while fkeys and fkeys[0][0] <= gt:
                    _, ks, hold = fkeys.pop(0)
                    subprocess.run(['xdotool', 'keydown', *ks])
                    out.write(f"KD|{gt}|{'+'.join(ks)}\n")
                    keys_sent = True
                    releases.append((gt + hold, ks))
            now = time.time() - T0
            while keys and keys[0][0] <= now:
                _, ks = keys.pop(0)
                out.write(f"K|{ms()}|{'+'.join(ks)}\n")
                subprocess.run(['xdotool', 'keydown', *ks])
                time.sleep(0.12)
                subprocess.run(['xdotool', 'keyup', *ks])
            while shots and shots[0] <= now:
                t = shots.pop(0)
                subprocess.run(['sh', '-c', f'xwd -root -silent > /out/shot-{int(t * 1000):07d}.xwd'])
                out.write(f"S|{ms()}|{t}\n")
            time.sleep(0.0005)
    out.close()
    subprocess.run(['pkill', '-f', 'mugen.exe']); subprocess.run(['wineserver', '-k'])
    subprocess.run(['cp', 'mugen.log', '/out/mugen.log'])
    print('done')


main()
