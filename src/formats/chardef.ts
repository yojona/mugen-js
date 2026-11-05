// Character definition (.def) files.

import { findSection, getValue, parseIni, unquote, splitCsv } from './text';

export interface CharDef {
  name: string;
  displayName: string;
  author: string;
  mugenVersion: string;
  localCoord: [number, number];
  palDefaults: number[];
  /** [Palette Keymap] per button a b c x y z a2 .. z2 (1-based palettes). */
  palKeymap: number[];
  /** The palettes a character can reserve: the keymap's, else the pal1..pal12 it names (bit n = palette n, 0-based). */
  palMask: number;
  files: {
    cmd?: string;
    cns?: string;
    /** st, st0..st9 in order. */
    st: string[];
    stcommon?: string;
    sprite?: string;
    anim?: string;
    sound?: string;
    ai?: string;
    /** pal1..pal12 (index 0 = pal1); undefined where not given. */
    pal: (string | undefined)[];
  };
  /** [Arcade] storyboards. */
  arcade: { intro?: string; ending?: string };
}

export function parseCharDef(text: string): CharDef {
  const doc = parseIni(text);
  const info = findSection(doc, 'Info');
  const files = findSection(doc, 'Files');
  const lc = splitCsv(getValue(info, 'localcoord') ?? '320,240').map((v) => parseInt(v, 10));
  const st: string[] = [];
  const stMain = getValue(files, 'st');
  if (stMain) st.push(stMain);
  for (let i = 0; i <= 9; i++) {
    const v = getValue(files, `st${i}`);
    if (v) st.push(v);
  }
  const pal: (string | undefined)[] = [];
  for (let i = 1; i <= 12; i++) pal.push(getValue(files, `pal${i}`) || undefined);
  // Select_LoadCharInfo: with a [Palette Keymap] missing keys mean palette 1
  // and only the keys given count as available; without one a = 1, b = 2 ...
  const keymapSec = findSection(doc, 'Palette Keymap');
  let palMask = 0;
  const palKeymap = PAL_KEYMAP_KEYS.map((k, i) => {
    if (!keymapSec) return i + 1;
    const v = getValue(keymapSec, k);
    if (v === undefined) return 1;
    const n = Math.max(1, Math.min(12, parseInt(v, 10) || 0));
    palMask |= 1 << (n - 1);
    return n;
  });
  if (!palMask) pal.forEach((f, i) => {
    if (f) palMask |= 1 << i;
  });
  const name = unquote(getValue(info, 'name') ?? '');
  const arcade = findSection(doc, 'Arcade');
  return {
    name,
    displayName: unquote(getValue(info, 'displayname') ?? name),
    author: unquote(getValue(info, 'author') ?? ''),
    mugenVersion: getValue(info, 'mugenversion') ?? '',
    localCoord: [lc[0] || 320, lc[1] || 240],
    palKeymap,
    palMask,
    palDefaults: splitCsv(getValue(info, 'pal.defaults') ?? '1')
      .map((v) => parseInt(v, 10))
      .filter((v) => v > 0),
    files: {
      cmd: getValue(files, 'cmd') || undefined,
      cns: getValue(files, 'cns') || undefined,
      st,
      stcommon: getValue(files, 'stcommon') || undefined,
      sprite: getValue(files, 'sprite') || undefined,
      anim: getValue(files, 'anim') || undefined,
      sound: getValue(files, 'sound') || undefined,
      ai: getValue(files, 'ai') || undefined,
      pal,
    },
    arcade: { intro: getValue(arcade, 'intro.storyboard') || undefined, ending: getValue(arcade, 'ending.storyboard') || undefined },
  };
}

/** g_palKeymapKeys: the [Palette Keymap] keys, in button order. */
const PAL_KEYMAP_KEYS = ['a', 'b', 'c', 'x', 'y', 'z', 'a2', 'b2', 'c2', 'x2', 'y2', 'z2'];
