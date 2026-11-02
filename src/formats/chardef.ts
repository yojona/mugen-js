// Character definition (.def) files.

import { findSection, getValue, parseIni, unquote, splitCsv } from './text';

export interface CharDef {
  name: string;
  displayName: string;
  author: string;
  mugenVersion: string;
  localCoord: [number, number];
  palDefaults: number[];
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
  const name = unquote(getValue(info, 'name') ?? '');
  return {
    name,
    displayName: unquote(getValue(info, 'displayname') ?? name),
    author: unquote(getValue(info, 'author') ?? ''),
    mugenVersion: getValue(info, 'mugenversion') ?? '',
    localCoord: [lc[0] || 320, lc[1] || 240],
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
  };
}
