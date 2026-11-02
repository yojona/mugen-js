// Harness input scripts (tools/harness/inputs/*.txt), shared by both engines.

import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_S, IN_U, IN_X, IN_Y, IN_Z } from '../../src/engine/cmd';

const BITS: Record<string, number> = { u: IN_U, d: IN_D, l: IN_L, r: IN_R, a: IN_A, b: IN_B, c: IN_C, x: IN_X, y: IN_Y, z: IN_Z, s: IN_S };

export interface InputScript {
  /** Input bits for each player at a script clock value. */
  at(clock: number): [number, number];
}

export function parseInputs(text: string): InputScript {
  const spans: { from: number; to: number; player: number; bits: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const [range, player, keys] = line.split(/\s+/);
    const [a, b] = range!.split('-').map((n) => parseInt(n, 10));
    let bits = 0;
    for (const k of keys ?? '') bits |= BITS[k] ?? 0;
    spans.push({ from: a!, to: b ?? a!, player: parseInt(player!, 10), bits });
  }
  return {
    at(clock) {
      const out: [number, number] = [0, 0];
      for (const s of spans) if (clock >= s.from && clock <= s.to) out[s.player - 1]! |= s.bits;
      return out;
    },
  };
}
