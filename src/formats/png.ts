// Minimal PNG decoder for SFF v2 sprite formats 10 (PNG8), 11 (PNG24) and 12 (PNG32).
// We need raw palette indices for PNG8 (the browser's decoder would expand them
// to RGBA and lose the index), so we decode PNG ourselves.

import { FormatError } from './binary';

export interface PngImage {
  width: number;
  height: number;
  /** Palette indices (color type 3) — one byte per pixel. */
  indices?: Uint8Array;
  /** RGBA pixels for truecolor / grayscale images. */
  rgba?: Uint8Array;
  /** PLTE chunk as RGB triples (unused by MUGEN, kept for diagnostics). */
  plte?: Uint8Array;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePng(bytes: Uint8Array): Promise<PngImage> {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) throw new FormatError('PNG', 'bad signature');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let ctype = 0;
  let plte: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = h.getUint32(0);
      height = h.getUint32(4);
      depth = body[8]!;
      ctype = body[9]!;
      if (body[12] !== 0) throw new FormatError('PNG', 'interlaced PNG not supported');
    } else if (type === 'PLTE') plte = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    z.set(c, o);
    o += c.length;
  }
  const raw = await inflateZlib(z);

  const channels = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : 4;
  const bpp = Math.max(1, (channels * depth) >> 3); // bytes per pixel for filtering
  const stride = (width * channels * depth + 7) >> 3;
  const out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let v = line[x]!;
      switch (f) {
        case 0:
          break;
        case 1:
          v += a;
          break;
        case 2:
          v += b;
          break;
        case 3:
          v += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new FormatError('PNG', `bad filter ${f}`);
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }

  if (ctype === 3) {
    const indices = new Uint8Array(width * height);
    if (depth === 8) indices.set(out);
    else {
      const per = 8 / depth;
      const mask = (1 << depth) - 1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const byte = out[y * stride + Math.floor(x / per)]!;
          const shift = 8 - depth * ((x % per) + 1);
          indices[y * width + x] = (byte >> shift) & mask;
        }
      }
    }
    return { width, height, indices, plte };
  }
  if (depth !== 8) throw new FormatError('PNG', `unsupported bit depth ${depth} for color type ${ctype}`);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (ctype === 0) {
      rgba.set([out[s]!, out[s]!, out[s]!, 255], i * 4);
    } else if (ctype === 4) {
      rgba.set([out[s]!, out[s]!, out[s]!, out[s + 1]!], i * 4);
    } else if (ctype === 2) {
      rgba.set([out[s]!, out[s + 1]!, out[s + 2]!, 255], i * 4);
    } else {
      rgba.set([out[s]!, out[s + 1]!, out[s + 2]!, out[s + 3]!], i * 4);
    }
  }
  return { width, height, rgba };
}
