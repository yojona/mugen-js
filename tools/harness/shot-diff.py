#!/usr/bin/env python3
"""Side-by-side and difference of a mugen.exe screenshot (xwd from SHOTS) and
ours (PNG from frame.html), both 640x480.

Usage: shot-diff.py mugen.xwd ours.png out.png
Prints the mean absolute difference per channel and the share of pixels that
differ by more than 48 in any channel; out.png = mugen | ours | difference."""
import struct, sys, zlib


def read_xwd(path):
    """The 640x480 MUGEN window inside the root dump (24 bpp, packed)."""
    d = open(path, 'rb').read()
    h = struct.unpack('>25I', d[:100])
    bpl, bpp, ncolors = h[12], h[11], h[19]
    step = bpp // 8
    px = d[h[0] + ncolors * 12:]
    def nonblack(x, y):
        i = y * bpl + x * step
        return px[i:i + 3] != b'\0\0\0'
    ox = next(x for x in range(h[4]) if any(nonblack(x, y) for y in range(0, h[5], 4)))
    oy = next(y for y in range(h[5]) if any(nonblack(x, y) for x in range(0, h[4], 4)))
    rows = []
    for y in range(oy, oy + 480):
        r = px[y * bpl:(y + 1) * bpl]
        rows.append(bytes(c for x in range(ox, ox + 640) for c in (r[x * step + 2], r[x * step + 1], r[x * step])))
    return rows


def read_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat, w, h, ctype = 8, b'', 0, 0, 0
    while pos < len(d):
        n, t = struct.unpack('>I4s', d[pos:pos + 8])
        c = d[pos + 8:pos + 8 + n]
        if t == b'IHDR':
            w, h, depth, ctype = struct.unpack('>IIBB', c[:10])
        elif t == b'IDAT':
            idat += c
        pos += 12 + n
    raw = zlib.decompress(idat)
    bpp = 4 if ctype == 6 else 3
    stride = w * bpp
    rows, prev = [], bytearray(stride)
    i = 0
    for y in range(h):
        f = raw[i]; line = bytearray(raw[i + 1:i + 1 + stride]); i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        rows.append(bytes(line[k] for px in range(min(w, 640)) for k in range(px * bpp, px * bpp + 3)))
    return rows[:480]


def write_png(path, rows, w):
    raw = b''.join(b'\x00' + r for r in rows)
    def chunk(t, c):
        return struct.pack('>I', len(c)) + t + c + struct.pack('>I', zlib.crc32(t + c) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, len(rows), 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


m, o = read_xwd(sys.argv[1]), read_png(sys.argv[2])
tot, big, out = 0, 0, []
for rm, ro in zip(m, o):
    diff = bytearray(len(rm))
    for x in range(0, len(rm), 3):
        d = [abs(rm[x + k] - ro[x + k]) for k in range(3)]
        tot += sum(d)
        if max(d) > 48:
            big += 1
            diff[x:x + 3] = b'\xff\x30\x30'
        else:
            diff[x:x + 3] = bytes(v // 3 for v in ro[x:x + 3])
    out.append(rm + ro + bytes(diff))
write_png(sys.argv[3], out, 1920)
print(f'mean abs diff {tot / (640 * 480 * 3):.2f}, pixels off {100 * big / (640 * 480):.2f}%')
