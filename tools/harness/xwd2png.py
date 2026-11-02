#!/usr/bin/env python3
"""Convert Xvfb root dumps (xwd, 24/32-bit ZPixmap) to PNG, cropped to the
MUGEN window (the top-left WxH, default 640x480).

Usage: xwd2png.py [--crop WxH] [--scale N] file.xwd... (writes file.png)"""
import struct, sys, zlib


def read_xwd(path):
    d = open(path, 'rb').read()
    h = struct.unpack('>25I', d[:100])
    header_size, _, fmt, depth, w, hgt = h[0], h[1], h[2], h[3], h[4], h[5]
    bpl, ncolors = h[12], h[19]
    bpp = h[11]
    off = header_size + ncolors * 12
    px = d[off:off + bpl * hgt]
    return w, hgt, bpl, bpp, px


def write_png(path, w, h, rows):
    raw = b''.join(b'\x00' + r for r in rows)
    def chunk(t, data):
        c = struct.pack('>I', len(data)) + t + data
        return c + struct.pack('>I', zlib.crc32(t + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)


def main():
    args = sys.argv[1:]
    cw, ch, scale = 640, 480, 1
    while args and args[0].startswith('--'):
        if args[0] == '--crop':
            cw, ch = map(int, args[1].split('x'))
        elif args[0] == '--scale':
            scale = int(args[1])
        args = args[2:]
    for path in args:
        w, h, bpl, bpp, px = read_xwd(path)
        step = bpl // w
        rows = []
        for y in range(0, min(ch, h), scale):
            line = px[y * bpl:(y + 1) * bpl]
            out = bytearray()
            for x in range(0, min(cw, w), scale):
                b, g, r = line[x * step], line[x * step + 1], line[x * step + 2]
                out += bytes((r, g, b))
            rows.append(bytes(out))
        write_png(path[:-4] + '.png', len(rows[0]) // 3, len(rows), rows)


main()
