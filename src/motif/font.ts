// Bitmap fonts: FNT v1 (.fnt, PCX strip + character map) and FNT v2 (.def + SFF).
//
// v1 colour banks (old_tools/mtools.txt): bank 0 occupies palette entries
// 255, 254, ... (colors entries, reverse order); bank n starts right after.
// v2 colour banks are SFF palettes 0,<bank> (fonts.html).

import { Reader } from '../formats/binary';
import { decodePcx, parseSff, type Sprite } from '../formats/sff';
import { findSection, getValue, parseIni, splitCsv, splitLines, stripComment } from '../formats/text';
import { dirname, type Vfs } from '../engine/vfs';

export interface Glyph {
  sprite: Sprite;
  width: number;
}

export interface Font {
  height: number;
  /** Width used for spaces and unknown characters. */
  spaceWidth: number;
  spacing: [number, number];
  offset: [number, number];
  glyph(ch: string): Glyph | undefined;
  palette(bank: number): Uint8Array | undefined;
}

export async function loadFont(vfs: Vfs, file: string, ...bases: string[]): Promise<Font> {
  const path = vfs.resolve(file, ...bases, 'font');
  if (!path) throw new Error(`Fuente no encontrada: ${file}`);
  if (/\.def$/i.test(path)) return loadFontV2(vfs, path);
  return parseFntV1(await vfs.read(path));
}

export function parseFntV1(bytes: Uint8Array): Font {
  const r = new Reader(bytes);
  r.str(12);
  r.skip(4);
  const pcxOff = r.u32();
  const pcxLen = r.u32();
  const txtOff = r.u32();
  const txtLen = r.u32();
  const pcx = bytes.subarray(pcxOff, pcxOff + pcxLen);
  const img = decodePcx(pcx);
  // PCX palette: last 768 bytes.
  const rgb = pcx.subarray(pcx.length - 768);
  const basePal = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) basePal.set([rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!, i ? 255 : 0], i * 4);
  const text = new TextDecoder('latin1').decode(bytes.subarray(txtOff, txtOff + txtLen));

  let size: [number, number] = [8, 8];
  let spacing: [number, number] = [1, 1];
  let colors = 256;
  let offset: [number, number] = [0, 0];
  let variable = false;
  const map: { ch: string; x: number; w?: number }[] = [];
  let section = '';
  for (const raw of splitLines(text)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const sec = /^\[(.*)\]$/.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    if (section === 'def') {
      const kv = /^(\w+)\s*=\s*(.*)$/.exec(line);
      if (!kv) continue;
      const k = kv[1]!.toLowerCase();
      const v = splitCsv(kv[2]!).map((x) => parseInt(x, 10));
      if (k === 'size') size = [v[0] ?? 8, v[1] ?? 8];
      else if (k === 'spacing') spacing = [v[0] ?? 0, v[1] ?? 0];
      else if (k === 'colors') colors = v[0] ?? 256;
      else if (k === 'offset') offset = [v[0] ?? 0, v[1] ?? 0];
      else if (k === 'type') variable = /^variable/i.test(kv[2]!.trim());
    } else if (section === 'map') {
      const parts = line.split(/\s+/);
      let ch = parts[0]!;
      if (/^0x[0-9a-f]+$/i.test(ch)) ch = String.fromCharCode(parseInt(ch, 16));
      map.push({ ch, x: parseInt(parts[1] ?? '', 10), w: parts[2] !== undefined ? parseInt(parts[2], 10) : undefined });
    }
  }

  const glyphs = new Map<string, Glyph>();
  map.forEach((m, i) => {
    const x = variable ? m.x : i * size[0];
    const w = variable ? (m.w ?? size[0]) : size[0];
    if (!Number.isFinite(x) || w <= 0) return;
    const indices = new Uint8Array(w * img.height);
    for (let y = 0; y < img.height; y++) indices.set(img.indices.subarray(y * img.width + x, y * img.width + x + w), y * w);
    glyphs.set(m.ch, { width: w, sprite: { group: 0, number: m.ch.charCodeAt(0), width: w, height: img.height, axisX: 0, axisY: 0, palette: 0, indices } });
  });

  const banks = new Map<number, Uint8Array>();
  return {
    height: size[1],
    spaceWidth: size[0],
    spacing,
    offset,
    glyph: (ch) => glyphs.get(ch) ?? glyphs.get(ch.toUpperCase()),
    palette(bank) {
      let p = banks.get(bank);
      if (!p) {
        p = new Uint8Array(1024);
        const shift = bank * colors;
        for (let i = 1; i < 256; i++) {
          const src = i - shift;
          if (src >= 0) p.set(basePal.subarray(src * 4, src * 4 + 4), i * 4);
          p[i * 4 + 3] = 255;
        }
        banks.set(bank, p);
      }
      return p;
    },
  };
}

async function loadFontV2(vfs: Vfs, path: string): Promise<Font> {
  const doc = parseIni(await vfs.text(path));
  const def = findSection(doc, 'Def');
  const n2 = (k: string, d: [number, number]): [number, number] => {
    const v = getValue(def, k);
    if (!v) return d;
    const p = splitCsv(v).map((x) => parseInt(x, 10));
    return [p[0] ?? d[0], p[1] ?? d[1]];
  };
  const size = n2('size', [8, 8]);
  const sffFile = getValue(def, 'file') ?? '';
  const sff = await parseSff(await vfs.read(sffFile, dirname(path), 'font'));
  const palIndex = (bank: number) => sff.paletteIds.findIndex((id) => id?.group === 0 && id.number === bank);
  return {
    height: size[1],
    spaceWidth: size[0],
    spacing: n2('spacing', [0, 0]),
    offset: n2('offset', [0, 0]),
    glyph(ch) {
      const s = sff.get(0, ch.charCodeAt(0));
      return s ? { sprite: s, width: s.width } : undefined;
    },
    palette(bank) {
      const i = palIndex(bank);
      return sff.palettes[i >= 0 ? i : (sff.sprites[0]?.palette ?? 0)];
    },
  };
}

/** Width of a string in pixels (glyph widths + spacing). */
export function textWidth(font: Font, text: string): number {
  let w = 0;
  for (const ch of text) w += (font.glyph(ch)?.width ?? font.spaceWidth) + font.spacing[0];
  return Math.max(0, w - font.spacing[0]);
}
