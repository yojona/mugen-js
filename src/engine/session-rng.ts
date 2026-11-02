// MUGEN's session RNG (mugen.exe G+0x11ed0..0x11edc): the same Park-Miller
// generator as the match RNG, seeded once per session (-sessionseed), drawn
// for arcade opponent order, random palettes and stages, and each match seed.

const M = 2147483647;

export class SessionRng {
  constructor(public seed: number) {
    if (this.seed <= 0 || this.seed >= M) this.seed = 1;
  }

  next(): number {
    this.seed = (this.seed * 16807) % M;
    return this.seed;
  }

  /** 0x425540: one draw; the match RNG starts at (draw + 1) mod 2^31-1, or 1. */
  matchSeed(): number {
    const v = (this.next() + 1) % M;
    return v === 0 || v >= 0x7fffffff ? 1 : v;
  }

  /**
   * 0x40a370: arcade opponents. The roster indices are shuffled with five
   * passes of swaps (i with rand % n), stably sorted by order, then each
   * order o (1-based, as in select.def) gives up to maxMatches[o - 1]
   * characters (the player's own character included).
   */
  arcadeOrder<T extends { order: number }>(chars: readonly T[], maxMatches: readonly number[]): T[] {
    const n = chars.length;
    const idx = chars.map((_, i) => i);
    for (let pass = 0; pass < 5; pass++) {
      for (let i = 0; i < n; i++) {
        const j = this.next() % n;
        [idx[i], idx[j]] = [idx[j]!, idx[i]!];
      }
    }
    // Bubble sort by order (stable: swaps only when strictly greater).
    for (let end = n - 1; end >= 1; end--) {
      let sorted = true;
      for (let i = 0; i < end; i++) {
        if (chars[idx[i]!]!.order > chars[idx[i + 1]!]!.order) {
          [idx[i], idx[i + 1]] = [idx[i + 1]!, idx[i]!];
          sorted = false;
        }
      }
      if (sorted) break;
    }
    const out: T[] = [];
    let k = 0;
    for (let o = 0; o < 30 && k < n; o++) {
      while (k < n && chars[idx[k]!]!.order - 1 < o) k++;
      let taken = 0;
      while (k < n && chars[idx[k]!]!.order - 1 === o && taken < (maxMatches[o] ?? 0)) {
        out.push(chars[idx[k]!]!);
        taken++;
        k++;
      }
    }
    return out;
  }

  /**
   * 0x40a620 / 0x40aea0: an arcade opponent's palette: a draw % 12, moved to
   * an existing palette (from 7-12 down to 1-6, else the next one of 1-6,
   * then of 7-12). `has(i)` tells whether palette i + 1 exists. 1-based.
   */
  opponentPalette(has: (i: number) => boolean): number {
    let i = this.next() % 12;
    if (!has(i) && i >= 6) i -= 6;
    if (has(i)) return i + 1;
    for (let tries = 1; tries <= 6; tries++) {
      i = (i + 1) % 6;
      if (has(i)) return i + 1;
    }
    for (let tries = 1; tries <= 6; tries++) {
      i = i + 1 >= 12 ? 6 : i + 1;
      if (has(i)) return i + 1;
    }
    return 1;
  }
}
