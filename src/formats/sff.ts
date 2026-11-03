// SFF sprite archives, versions 1.01 (PCX based) and 2.00/2.01 (MUGEN 1.0+).
//
// Output model (shared by both versions):
//  - `sprites`: one entry per sprite, in file order. Linked sprites are resolved
//    to the same pixel data as their target.
//  - `palettes`: deduplicated palettes as 256 RGBA colors (Uint8Array(1024)).
//    Index 0 is always the transparent color for indexed sprites.
//  - Each indexed sprite references a palette by index into `palettes`.

import { FormatError, Reader } from './binary';
import { decodePng } from './png';

export interface Sprite {
  group: number;
  number: number;
  width: number;
  height: number;
  /** Axis (offset of the sprite's origin from its top-left pixel). */
  axisX: number;
  axisY: number;
  /** Index into Sff.palettes, or -1 for truecolor sprites. */
  palette: number;
  /** One byte per pixel (palette index), row-major, length width*height. */
  indices?: Uint8Array;
  /** RGBA pixels for truecolor sprites (SFF v2 PNG24/PNG32). */
  rgba?: Uint8Array;
}

export interface Sff {
  version: 1 | 2;
  /** Full version string, e.g. "2.01" or "1.01". */
  versionText: string;
  sprites: Sprite[];
  palettes: Uint8Array[];
  /** SFF v2 palette (group, number) for each entry in `palettes`, when known. */
  paletteIds: ({ group: number; number: number } | undefined)[];
  /** v1: the "shared" palette index used by character sprites (first sprite's palette). */
  sharedPalette: number;
  /** Lookup by (group, number). First occurrence wins, as in MUGEN. */
  get(group: number, number: number): Sprite | undefined;
}

const SIGNATURE = 'ElecbyteSpr';

export async function parseSff(bytes: Uint8Array): Promise<Sff> {
  const r = new Reader(bytes);
  const sig = r.str(12);
  if (sig !== SIGNATURE) throw new FormatError('SFF', `bad signature "${sig}"`);
  const v3 = r.u8();
  const v2 = r.u8();
  const v1 = r.u8();
  const v0 = r.u8();
  const versionText = `${v0}.${v1}${v2}${v3 ? v3 : ''}`;
  if (v0 === 1) return finish(parseV1(r), 1, versionText);
  if (v0 === 2) return finish(await parseV2(r), 2, versionText);
  throw new FormatError('SFF', `unsupported version ${versionText}`);
}

type Partial_ = Omit<Sff, 'get' | 'version' | 'versionText'>;

function finish(p: Partial_, version: 1 | 2, versionText: string): Sff {
  const index = new Map<number, Sprite>();
  for (const s of p.sprites) {
    const k = s.group * 65536 + s.number;
    if (!index.has(k)) index.set(k, s);
  }
  return {
    ...p,
    version,
    versionText,
    get: (g, n) => index.get(g * 65536 + n),
  };
}

// ---------------------------------------------------------------------------
// SFF v1

function parseV1(r: Reader): Partial_ {
  r.pos = 16;
  /* groups */ r.u32();
  const count = r.u32();
  let next = r.u32();
  /* subheader size */ r.u32();
  /* palette type */ r.u8();

  const sprites: Sprite[] = [];
  const palettes: Uint8Array[] = [];
  const palKeys = new Map<string, number>();
  let prevPal = -1;

  const addPalette = (rgb: Uint8Array): number => {
    const key = bytesKey(rgb);
    const found = palKeys.get(key);
    if (found !== undefined) return found;
    const pal = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) {
      pal[i * 4] = rgb[i * 3]!;
      pal[i * 4 + 1] = rgb[i * 3 + 1]!;
      pal[i * 4 + 2] = rgb[i * 3 + 2]!;
      pal[i * 4 + 3] = i === 0 ? 0 : 255;
    }
    palettes.push(pal);
    palKeys.set(key, palettes.length - 1);
    return palettes.length - 1;
  };

  for (let i = 0; i < count && next > 0 && next < r.length; i++) {
    r.pos = next;
    const start = next;
    next = r.u32();
    const length = r.u32();
    const axisX = r.s16();
    const axisY = r.s16();
    const group = r.u16();
    const number = r.u16();
    const linked = r.u16();
    const samePalette = r.u8() !== 0 && i > 0;
    const dataStart = start + 32;

    if (length === 0) {
      // Linked sprite: reuse pixels and palette of an earlier sprite.
      const target = sprites[linked];
      if (!target) throw new FormatError('SFF', `sprite ${i} links to missing sprite ${linked}`);
      sprites.push({ ...target, group, number, axisX, axisY });
      prevPal = target.palette;
      continue;
    }

    const data = r.slice(dataStart, dataStart + length);
    let palette: number;
    if (samePalette && prevPal >= 0) palette = prevPal;
    else {
      // Palette is the last 768 bytes of the PCX data (after a 0x0C marker).
      palette = addPalette(data.subarray(data.length - 768));
    }
    const pcx = decodePcx(data);
    sprites.push({ group, number, axisX, axisY, palette, width: pcx.width, height: pcx.height, indices: pcx.indices });
    prevPal = palette;
  }

  return { sprites, palettes, paletteIds: palettes.map(() => undefined), sharedPalette: sprites[0]?.palette ?? 0 };
}

export function decodePcx(data: Uint8Array): { width: number; height: number; indices: Uint8Array } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bitsPerPixel = data[3]!;
  const xmin = dv.getUint16(4, true);
  const ymin = dv.getUint16(6, true);
  const xmax = dv.getUint16(8, true);
  const ymax = dv.getUint16(10, true);
  const planes = data[65]!;
  const bpl = dv.getUint16(66, true);
  const width = xmax - xmin + 1;
  const height = ymax - ymin + 1;
  if (bitsPerPixel !== 8 || planes !== 1) {
    throw new FormatError('PCX', `unsupported ${bitsPerPixel}bpp x ${planes} planes`);
  }
  // Decode the whole RLE stream (runs may cross scanlines), then crop padding.
  const lineLen = bpl * planes;
  const buf = new Uint8Array(lineLen * height);
  let p = 128;
  let o = 0;
  while (o < buf.length && p < data.length) {
    const b = data[p++]!;
    if ((b & 0xc0) === 0xc0) {
      const run = b & 0x3f;
      const v = data[p++]!;
      buf.fill(v, o, Math.min(o + run, buf.length));
      o += run;
    } else buf[o++] = b;
  }
  if (lineLen === width) return { width, height, indices: buf };
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) indices.set(buf.subarray(y * lineLen, y * lineLen + width), y * width);
  return { width, height, indices };
}

// ---------------------------------------------------------------------------
// SFF v2

const FMT_RAW = 0;
const FMT_RLE8 = 2;
const FMT_RLE5 = 3;
const FMT_LZ5 = 4;
const FMT_PNG8 = 10;
const FMT_PNG24 = 11;
const FMT_PNG32 = 12;

async function parseV2(r: Reader): Promise<Partial_> {
  r.pos = 36;
  const spriteOff = r.u32();
  const spriteCount = r.u32();
  const palOff = r.u32();
  const palCount = r.u32();
  const ldataOff = r.u32();
  /* ldata length */ r.u32();
  const tdataOff = r.u32();

  // Palettes
  const palettes: Uint8Array[] = [];
  const paletteIds: { group: number; number: number }[] = [];
  const rawPal: { group: number; number: number; cols: number; linked: number; off: number; len: number }[] = [];
  r.pos = palOff;
  for (let i = 0; i < palCount; i++) {
    rawPal.push({ group: r.u16(), number: r.u16(), cols: r.u16(), linked: r.u16(), off: r.u32(), len: r.u32() });
  }
  for (let i = 0; i < rawPal.length; i++) {
    const p = rawPal[i]!;
    let pal: Uint8Array;
    if (p.len === 0) {
      pal = palettes[p.linked] ?? new Uint8Array(1024);
    } else {
      pal = new Uint8Array(1024);
      const src = r.slice(ldataOff + p.off, ldataOff + p.off + p.len);
      const n = Math.min(256, src.length >> 2);
      for (let c = 0; c < n; c++) {
        pal[c * 4] = src[c * 4]!;
        pal[c * 4 + 1] = src[c * 4 + 1]!;
        pal[c * 4 + 2] = src[c * 4 + 2]!;
        pal[c * 4 + 3] = c === 0 ? 0 : 255;
      }
    }
    palettes.push(pal);
    paletteIds.push({ group: p.group, number: p.number });
  }

  // Sprites
  const sprites: Sprite[] = [];
  const rawSpr: { linked: number; fmt: number; off: number; len: number; flags: number }[] = [];
  r.pos = spriteOff;
  for (let i = 0; i < spriteCount; i++) {
    const group = r.u16();
    const number = r.u16();
    const width = r.u16();
    const height = r.u16();
    const axisX = r.s16();
    const axisY = r.s16();
    const linked = r.u16();
    const fmt = r.u8();
    /* color depth */ r.u8();
    const off = r.u32();
    const len = r.u32();
    const palette = r.u16();
    const flags = r.u16();
    rawSpr.push({ linked, fmt, off, len, flags });
    sprites.push({ group, number, width, height, axisX, axisY, palette });
  }
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i]!;
    const raw = rawSpr[i]!;
    if (raw.len === 0) {
      const t = sprites[raw.linked];
      if (t && raw.linked < i) {
        s.indices = t.indices;
        s.rgba = t.rgba;
        s.width = t.width;
        s.height = t.height;
        if (t.rgba) s.palette = -1;
      }
      continue;
    }
    const base = raw.flags & 1 ? tdataOff : ldataOff;
    const data = r.slice(base + raw.off, base + raw.off + raw.len);
    await decodeV2Sprite(s, raw.fmt, data);
  }

  return { sprites, palettes, paletteIds, sharedPalette: 0 };
}

async function decodeV2Sprite(s: Sprite, fmt: number, data: Uint8Array): Promise<void> {
  const n = s.width * s.height;
  switch (fmt) {
    case FMT_RAW:
      s.indices = data.slice(0, n);
      return;
    case FMT_RLE8:
      s.indices = rle8(data.subarray(4), n);
      return;
    case FMT_RLE5:
      s.indices = rle5(data.subarray(4), n);
      return;
    case FMT_LZ5:
      s.indices = lz5(data.subarray(4), n);
      return;
    case FMT_PNG8:
    case FMT_PNG24:
    case FMT_PNG32: {
      const png = await decodePng(data.subarray(4));
      if (png.indices) s.indices = png.indices;
      else {
        s.rgba = png.rgba;
        s.palette = -1;
      }
      return;
    }
    default:
      throw new FormatError('SFF', `sprite ${s.group},${s.number}: unknown format ${fmt}`);
  }
}

export function rle8(src: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let i = 0;
  let o = 0;
  while (o < n && i < src.length) {
    const b = src[i++]!;
    if ((b & 0xc0) === 0x40) {
      const run = b & 0x3f;
      const c = src[i++]!;
      out.fill(c, o, Math.min(o + run, n));
      o += run;
    } else out[o++] = b;
  }
  return out;
}

export function rle5(src: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let i = 0;
  let o = 0;
  while (o < n && i < src.length) {
    const runLen = src[i++]!;
    const d = src[i++]!;
    const dataLen = d & 0x7f;
    let color = 0;
    if (d & 0x80) color = src[i++]!;
    for (let k = 0; k <= runLen && o < n; k++) out[o++] = color;
    for (let j = 0; j < dataLen; j++) {
      const b = src[i++]!;
      color = b & 0x1f;
      const run = b >> 5;
      for (let k = 0; k <= run && o < n; k++) out[o++] = color;
    }
  }
  return out;
}

export function lz5(src: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let i = 0;
  let o = 0;
  let ctrl = src[i++] ?? 0;
  let bit = 0;
  let recycled = 0;
  let recycledBits = 0;
  while (o < n && i < src.length) {
    let d = src[i++]!;
    if (ctrl & (1 << bit)) {
      // LZ packet: copy from earlier output.
      let len: number;
      let dist: number;
      if ((d & 0x3f) === 0) {
        dist = (((d & 0xc0) << 2) | src[i++]!) + 1;
        len = src[i++]! + 3;
      } else {
        recycled |= (d & 0xc0) >> recycledBits;
        recycledBits += 2;
        len = (d & 0x3f) + 1;
        if (recycledBits < 8) dist = src[i++]! + 1;
        else {
          dist = recycled + 1;
          recycled = 0;
          recycledBits = 0;
        }
      }
      for (let k = 0; k < len && o < n; k++, o++) out[o] = o - dist >= 0 ? out[o - dist]! : 0;
    } else {
      // RLE packet.
      let run: number;
      if ((d & 0xe0) === 0) run = src[i++]! + 8;
      else {
        run = d >> 5;
        d &= 0x1f;
      }
      out.fill(d, o, Math.min(o + run, n));
      o += run;
    }
    if (++bit === 8) {
      ctrl = src[i++] ?? 0;
      bit = 0;
    }
  }
  return out;
}

function bytesKey(b: Uint8Array): string {
  return String.fromCharCode(...b);
}

// ---------------------------------------------------------------------------
// Partial read: only some sprites (select screen portraits)

/** Reads bytes [start, end) of the file; fewer at its end. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

/**
 * An SFF holding only the `wanted` sprites (first occurrence of each), read
 * through ranges instead of the whole file: what mugen.exe loads of each
 * character for the select screen. Palettes keep the full parse's rules
 * (v1: the first sprite's palette is the shared one; v2: all palettes).
 */
export async function parseSffSprites(read: RangeReader, wanted: readonly (readonly [number, number])[]): Promise<Sff> {
  const head = new Reader(await read(0, 512));
  const sig = head.str(12);
  if (sig !== SIGNATURE) throw new FormatError('SFF', `bad signature "${sig}"`);
  const v3 = head.u8();
  const v2 = head.u8();
  const v1 = head.u8();
  const v0 = head.u8();
  const versionText = `${v0}.${v1}${v2}${v3 ? v3 : ''}`;
  const want = new Set(wanted.map(([g, n]) => g * 65536 + n));
  if (v0 === 1) return finish(await partialV1(head, read, want), 1, versionText);
  if (v0 === 2) return finish(await partialV2(head, read, want), 2, versionText);
  throw new FormatError('SFF', `unsupported version ${versionText}`);
}

/** A growing prefix of the file, fetched in doubling chunks. */
class Prefix {
  bytes = new Uint8Array(0);
  private eof = false;
  private chunk = 1 << 18;
  constructor(private read: RangeReader) {}
  async ensure(end: number): Promise<boolean> {
    while (this.bytes.length < end && !this.eof) {
      const want = Math.max(end, this.bytes.length + this.chunk);
      const more = await this.read(this.bytes.length, want);
      if (more.length < want - this.bytes.length) this.eof = true;
      const b = new Uint8Array(this.bytes.length + more.length);
      b.set(this.bytes);
      b.set(more, this.bytes.length);
      this.bytes = b;
      this.chunk = Math.min(this.chunk * 2, 1 << 22);
    }
    return this.bytes.length >= end;
  }
}

async function partialV1(head: Reader, read: RangeReader, want: Set<number>): Promise<Partial_> {
  head.pos = 20;
  const count = head.u32();
  let next = head.u32();
  const f = new Prefix(read);
  const sprites: Sprite[] = [];
  const palettes: Uint8Array[] = [];
  const palKeys = new Map<string, number>();
  const addPalette = (rgb: Uint8Array): number => {
    const key = bytesKey(rgb);
    const found = palKeys.get(key);
    if (found !== undefined) return found;
    const pal = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) {
      pal[i * 4] = rgb[i * 3]!;
      pal[i * 4 + 1] = rgb[i * 3 + 1]!;
      pal[i * 4 + 2] = rgb[i * 3 + 2]!;
      pal[i * 4 + 3] = i === 0 ? 0 : 255;
    }
    palettes.push(pal);
    palKeys.set(key, palettes.length - 1);
    return palettes.length - 1;
  };
  // Per sprite: where its PCX data is and where its palette comes from.
  const info: { data: number; len: number; pal: number }[] = [];
  let lastPal = -1;
  const found = new Set<number>();
  let shared = 0;
  for (let i = 0; i < count && next > 0 && found.size < want.size; i++) {
    if (!(await f.ensure(next + 32))) break;
    const r = new Reader(f.bytes, next);
    const start = next;
    next = r.u32();
    const length = r.u32();
    const axisX = r.s16();
    const axisY = r.s16();
    const group = r.u16();
    const number = r.u16();
    const linked = r.u16();
    const samePalette = r.u8() !== 0 && i > 0;
    const k = group * 65536 + number;
    const src = length === 0 ? info[linked] : { data: start + 32, len: length, pal: samePalette && lastPal >= 0 ? lastPal : start + 32 + length - 768 };
    if (!src) break;
    info.push(src);
    lastPal = src.pal;
    // The first sprite's palette is the character's shared palette.
    const take = want.has(k) && !found.has(k);
    if (i > 0 && !take) continue;
    if (!(await f.ensure(src.data + src.len))) break;
    const palette = addPalette(f.bytes.subarray(src.pal, src.pal + 768));
    if (i === 0) shared = palette;
    if (!take) continue;
    found.add(k);
    const pcx = decodePcx(f.bytes.subarray(src.data, src.data + src.len));
    sprites.push({ group, number, axisX, axisY, palette, width: pcx.width, height: pcx.height, indices: pcx.indices });
  }
  return { sprites, palettes, paletteIds: palettes.map(() => undefined), sharedPalette: shared };
}

async function partialV2(head: Reader, read: RangeReader, want: Set<number>): Promise<Partial_> {
  head.pos = 36;
  const spriteOff = head.u32();
  const spriteCount = head.u32();
  const palOff = head.u32();
  const palCount = head.u32();
  const ldataOff = head.u32();
  /* ldata length */ head.u32();
  const tdataOff = head.u32();
  const [palTab, sprTab] = await Promise.all([read(palOff, palOff + palCount * 16), read(spriteOff, spriteOff + spriteCount * 28)]);
  const pr = new Reader(palTab);
  const rawPal: { group: number; number: number; linked: number; off: number; len: number }[] = [];
  for (let i = 0; i < palCount; i++) {
    const group = pr.u16();
    const number = pr.u16();
    /* cols */ pr.u16();
    const linked = pr.u16();
    rawPal.push({ group, number, linked, off: pr.u32(), len: pr.u32() });
  }
  // All palettes (they are small and pick the selectable slots 1,n).
  const real = rawPal.filter((p) => p.len > 0);
  const lo = Math.min(...real.map((p) => p.off));
  const hi = Math.max(...real.map((p) => p.off + p.len));
  const palData = real.length ? await read(ldataOff + lo, ldataOff + hi) : new Uint8Array(0);
  const palettes: Uint8Array[] = [];
  for (const p of rawPal) {
    let pal: Uint8Array;
    if (p.len === 0) pal = palettes[p.linked] ?? new Uint8Array(1024);
    else {
      pal = new Uint8Array(1024);
      const src = palData.subarray(p.off - lo, p.off - lo + p.len);
      const n = Math.min(256, src.length >> 2);
      for (let c = 0; c < n; c++) {
        pal[c * 4] = src[c * 4]!;
        pal[c * 4 + 1] = src[c * 4 + 1]!;
        pal[c * 4 + 2] = src[c * 4 + 2]!;
        pal[c * 4 + 3] = c === 0 ? 0 : 255;
      }
    }
    palettes.push(pal);
  }
  const sr = new Reader(sprTab);
  const raw: { s: Sprite; linked: number; fmt: number; off: number; len: number; flags: number }[] = [];
  for (let i = 0; i < spriteCount; i++) {
    const group = sr.u16();
    const number = sr.u16();
    const width = sr.u16();
    const height = sr.u16();
    const axisX = sr.s16();
    const axisY = sr.s16();
    const linked = sr.u16();
    const fmt = sr.u8();
    /* color depth */ sr.u8();
    const off = sr.u32();
    const len = sr.u32();
    const palette = sr.u16();
    const flags = sr.u16();
    raw.push({ s: { group, number, width, height, axisX, axisY, palette }, linked, fmt, off, len, flags });
  }
  const sprites: Sprite[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i]!;
    const k = e.s.group * 65536 + e.s.number;
    if (!want.has(k) || seen.has(k)) continue;
    seen.add(k);
    // A linked sprite takes its target's pixels.
    const d = e.len === 0 && e.linked < i ? raw[e.linked]! : e;
    if (d.len === 0) continue;
    const base = d.flags & 1 ? tdataOff : ldataOff;
    const s = e.s;
    if (d !== e) {
      s.width = d.s.width;
      s.height = d.s.height;
    }
    await decodeV2Sprite(s, d.fmt, await read(base + d.off, base + d.off + d.len));
    sprites.push(s);
  }
  return { sprites, palettes, paletteIds: rawPal.map((p) => ({ group: p.group, number: p.number })), sharedPalette: 0 };
}
