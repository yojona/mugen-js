// SND sound archives: a linked list of WAV files keyed by (group, number).

import { FormatError, Reader } from './binary';

export interface Sound {
  group: number;
  number: number;
  /** Complete RIFF/WAV file bytes. */
  wav: Uint8Array;
}

export interface Snd {
  sounds: Sound[];
  get(group: number, number: number): Sound | undefined;
}

export function parseSnd(bytes: Uint8Array): Snd {
  const r = new Reader(bytes);
  const sig = r.str(12);
  if (sig !== 'ElecbyteSnd') throw new FormatError('SND', `bad signature "${sig}"`);
  r.skip(4); // version
  const count = r.u32();
  let next = r.u32();
  const sounds: Sound[] = [];
  const index = new Map<number, Sound>();
  for (let i = 0; i < count && next > 0 && next < r.length; i++) {
    r.pos = next;
    next = r.u32();
    const len = r.u32();
    const group = r.u32();
    const number = r.u32();
    const wav = r.slice(r.pos, r.pos + len);
    const s = { group, number, wav };
    sounds.push(s);
    const k = group * 65536 + number;
    if (!index.has(k)) index.set(k, s);
  }
  return { sounds, get: (g, n) => index.get(g * 65536 + n) };
}
