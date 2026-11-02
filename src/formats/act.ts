// ACT palette files: 256 RGB triples stored in reverse order (entry 0 = color 255).
// Returns 256 RGBA colors with index 0 transparent, same layout as Sff.palettes.

import { FormatError } from './binary';

export function parseAct(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 768) throw new FormatError('ACT', `too short (${bytes.length} bytes)`);
  const pal = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    const src = (255 - i) * 3;
    pal[i * 4] = bytes[src]!;
    pal[i * 4 + 1] = bytes[src + 1]!;
    pal[i * 4 + 2] = bytes[src + 2]!;
    pal[i * 4 + 3] = i === 0 ? 0 : 255;
  }
  return pal;
}
