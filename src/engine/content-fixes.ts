// Fixes applied to bundled content when it is loaded (the files themselves
// stay pristine: the harness compares against the original data).

import type { FileSource } from './vfs';

interface Fix {
  /** Path relative to the MUGEN root, compared case-insensitively. */
  path: string;
  why: string;
  replace: [string | RegExp, string][];
}

export const CONTENT_FIXES: Fix[] = [
  {
    path: 'chars/kfm720/kfm720.cns',
    why:
      "Elecbyte's 720p KFM ships a leftover 'Diagonal' PosSet in [Statedef -2] that forces its y from its x " +
      'whenever it is not airborne: it floats above the floor and gets stuck mid-air in state 5101 when knocked ' +
      'down (the original MUGEN 1.1 does the same). Disabled so the character is playable.',
    replace: [[/(\[state -2, Diagonal\]\s*\n\s*type\s*=\s*)posset/i, '$1null']],
  },
];

/** Wrap a file source so reads of fixed files return the patched text. */
export function withContentFixes(src: FileSource, fixes: Fix[] = CONTENT_FIXES): FileSource {
  const byPath = new Map(fixes.map((f) => [f.path.toLowerCase(), f]));
  return {
    list: () => src.list(),
    async read(path) {
      const bytes = await src.read(path);
      const fix = byPath.get(path.toLowerCase());
      if (!fix) return bytes;
      let text = new TextDecoder('latin1').decode(bytes);
      for (const [from, to] of fix.replace) text = text.replace(from, to);
      return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
    },
  };
}
