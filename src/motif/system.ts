// Motif (system.def) and roster (select.def) loading.

import { parseAir, type AnimationMap } from '../formats/air';
import { parseSff, type Sff } from '../formats/sff';
import { parseSnd, type Snd } from '../formats/snd';
import { findSection, getValue, parseIni, splitCsv, splitLines, stripComment, type IniDoc, type Section } from '../formats/text';
import { dirname, type Vfs } from '../engine/vfs';
import { parseBackground, type Background } from '../stage/stage';
import type { ElementAssets } from './element';
import { loadFont, type Font } from './font';

export interface Motif {
  defPath: string;
  dir: string;
  doc: IniDoc;
  localCoord: [number, number];
  sff: Sff;
  snd: Snd | undefined;
  anims: AnimationMap;
  fonts: (Font | undefined)[];
  assets: ElementAssets;
  /** Backgrounds by screen: title, select, versus, victory, ... */
  backgrounds: Map<string, Background & { clearColor: [number, number, number] }>;
  fightDef: string;
  selectDef: string;
  logoStoryboard?: string;
  introStoryboard?: string;
  section(name: string): Section | undefined;
  value(section: string, key: string): string | undefined;
}

export async function loadMotif(vfs: Vfs, defPath: string): Promise<Motif> {
  const text = await vfs.text(defPath);
  const doc = parseIni(text);
  const dir = dirname(defPath);
  const files = findSection(doc, 'Files');
  const info = findSection(doc, 'Info');
  const f = (k: string) => getValue(files, k)?.trim() || undefined;
  const lc = splitCsv(getValue(info, 'localcoord') ?? '320,240').map((x) => parseInt(x, 10));
  const sff = await parseSff(await vfs.read(f('spr') ?? 'system.sff', dir, 'data'));
  const sndFile = f('snd');
  const snd = sndFile ? await vfs.read(sndFile, dir, 'data').then(parseSnd).catch(() => undefined) : undefined;
  const fonts: (Font | undefined)[] = [];
  for (let i = 0; i <= 9; i++) {
    const ff = f(`font${i}`);
    if (ff) fonts[i] = await loadFont(vfs, ff, dir, '', 'data').catch(() => undefined);
  }
  const anims = parseAir(text);
  const backgrounds = new Map<string, Background & { clearColor: [number, number, number] }>();
  for (const name of ['title', 'select', 'versus', 'victory', 'continue', 'gameover', 'option']) {
    const bgdef = findSection(doc, `${name}BGdef`);
    if (!bgdef) continue;
    const { elements, ctrlDefs } = parseBackground(doc, bgdef, `${name}bg`);
    const cc = splitCsv(getValue(bgdef, 'bgclearcolor') ?? '0,0,0').map((x) => parseInt(x, 10) || 0);
    backgrounds.set(name, { sff, anims, elements, ctrlDefs, clearColor: [cc[0] ?? 0, cc[1] ?? 0, cc[2] ?? 0] });
  }
  const resolveIn = (file: string | undefined) => (file ? vfs.resolve(file, dir, 'data') : undefined);
  return {
    defPath,
    dir,
    doc,
    localCoord: [lc[0] || 320, lc[1] || 240],
    sff,
    snd,
    anims,
    fonts,
    assets: { sff, anims, fonts },
    backgrounds,
    fightDef: resolveIn(f('fight') ?? 'fight.def') ?? 'data/fight.def',
    selectDef: resolveIn(f('select') ?? 'select.def') ?? 'data/select.def',
    logoStoryboard: resolveIn(f('logo.storyboard')),
    introStoryboard: resolveIn(f('intro.storyboard')),
    section: (name) => findSection(doc, name),
    value: (sec, key) => getValue(findSection(doc, sec), key),
  };
}

// ---------------------------------------------------------------------------
// select.def

export interface RosterEntry {
  /** Path to the character .def, or 'randomselect' / '' (empty slot). */
  def: string;
  stage?: string;
  music?: string;
  /** includestage=0 hides the stage from the stage select list. */
  includeStage: boolean;
  order: number;
}

export interface Roster {
  chars: RosterEntry[];
  extraStages: string[];
  arcadeMaxMatches: number[];
}

/** Character names in select.def map to chars/<name>/<name>.def unless a .def path is given. */
export function charDefPath(vfs: Vfs, name: string): string | undefined {
  const n = name.trim();
  if (/\.def$/i.test(n)) return vfs.resolve(n, 'chars');
  return vfs.resolve(`${n}/${n}.def`, 'chars');
}

export async function loadRoster(vfs: Vfs, path: string): Promise<Roster> {
  const text = await vfs.text(path);
  const chars: RosterEntry[] = [];
  const extraStages: string[] = [];
  let section = '';
  for (const raw of splitLines(text)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const sec = /^\[(.*)\]$/.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    if (section === 'characters') {
      const parts = splitCsv(line);
      const name = parts[0] ?? '';
      const entry: RosterEntry = { def: name.toLowerCase() === 'randomselect' ? 'randomselect' : name, includeStage: true, order: 1 };
      for (const p of parts.slice(1)) {
        const kv = /^(\w+)\s*=\s*(.*)$/.exec(p);
        if (kv) {
          const k = kv[1]!.toLowerCase();
          if (k === 'music') entry.music = kv[2];
          else if (k === 'includestage') entry.includeStage = kv[2] !== '0';
          else if (k === 'order') entry.order = parseInt(kv[2]!, 10) || 1;
        } else if (p && !entry.stage) entry.stage = p;
      }
      chars.push(entry);
    } else if (section === 'extrastages') extraStages.push(line);
  }
  const opts = parseIni(text);
  const mm = getValue(findSection(opts, 'Options'), 'arcade.maxmatches') ?? '6';
  return { chars, extraStages, arcadeMaxMatches: splitCsv(mm).map((x) => parseInt(x, 10) || 0) };
}
