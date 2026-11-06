// Debug tool: render the first N sprites of an SFF into a contact-sheet PNG.
// Usage: npx tsx tools/sprite-sheet.ts <file.sff> <out.png> [count] [act]
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { parseSff } from '../src/formats/sff';
import { parseAct } from '../src/formats/act';

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

export function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const [file, out, countArg, actFile] = process.argv.slice(2);
const sff = await parseSff(new Uint8Array(readFileSync(file!)));
const act = actFile ? parseAct(new Uint8Array(readFileSync(actFile))) : undefined;
const sprites = sff.sprites.slice(0, countArg ? +countArg : 40);
const cols = 8;
const cell = Math.max(...sprites.map((s) => Math.max(s.width, s.height))) + 4;
const W = cols * cell;
const H = Math.ceil(sprites.length / cols) * cell;
const img = new Uint8Array(W * H * 4);
for (let i = 0; i < img.length; i += 4) img.set([40, 40, 48, 255], i);
sprites.forEach((s, i) => {
  const ox = (i % cols) * cell + 2;
  const oy = Math.floor(i / cols) * cell + 2;
  const pal = act ?? sff.palettes[s.palette];
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) {
      const d = ((oy + y) * W + ox + x) * 4;
      if (s.rgba) {
        const p = (y * s.width + x) * 4;
        if (s.rgba[p + 3]) img.set(s.rgba.subarray(p, p + 4), d);
      } else {
        const idx = s.indices![y * s.width + x]!;
        if (idx && pal) img.set([pal[idx * 4]!, pal[idx * 4 + 1]!, pal[idx * 4 + 2]!, 255], d);
      }
    }
});
writeFileSync(out!, encodePng(W, H, img));
console.log(`${sff.versionText}: ${sff.sprites.length} sprites, ${sff.palettes.length} palettes -> ${out}`);
