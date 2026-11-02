#!/usr/bin/env python3
"""Contact sheet of xwd dumps: crop X,Y,W,H, downscale by N, grid of C columns.
Usage: montage.py out.png X,Y,W,H N C files..."""
import struct, sys, zlib
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from importlib import import_module


def read_xwd(path):
    d = open(path, 'rb').read()
    h = struct.unpack('>25I', d[:100])
    w, hgt, bpl, ncolors = h[4], h[5], h[12], h[19]
    off = h[0] + ncolors * 12
    return w, hgt, bpl, d[off:off + bpl * hgt]


out, box, n, cols, *files = sys.argv[1:]
X, Y, W, H = map(int, box.split(','))
n, cols = int(n), int(cols)
tw, th = W // n, H // n
rows_n = (len(files) + cols - 1) // cols
canvas = [bytearray(tw * cols * 3) for _ in range(th * rows_n)]
for i, f in enumerate(files):
    w, h, bpl, px = read_xwd(f)
    step = bpl // w
    gx, gy = (i % cols) * tw, (i // cols) * th
    for y in range(th):
        line = px[(Y + y * n) * bpl:(Y + y * n + 1) * bpl]
        row = canvas[gy + y]
        for x in range(tw):
            o = (X + x * n) * step
            row[(gx + x) * 3:(gx + x) * 3 + 3] = bytes((line[o + 2], line[o + 1], line[o]))
raw = b''.join(b'\x00' + bytes(r) for r in canvas)
def chunk(t, data):
    c = struct.pack('>I', len(data)) + t + data
    return c + struct.pack('>I', zlib.crc32(t + data) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', tw * cols, th * rows_n, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')
open(out, 'wb').write(png)
