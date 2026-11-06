// What the game loads before the title (Select_Init and friends) and, on
// demand, what a fight needs: characters and stages, cached.

import { loadCharacter, loadCharacterPreview, type CharacterData } from '../engine/character';
import { loadProgram, type CharacterProgram } from '../engine/player';
import type { Vfs } from '../engine/vfs';
import type { FightFx } from '../engine/world';
import { parseAir } from '../formats/air';
import { parseSff } from '../formats/sff';
import { parseSnd, type Snd } from '../formats/snd';
import { findSection, getValue, parseIni, unquote } from '../formats/text';
import { FightHud } from '../motif/fight';
import { loadFont, loadFontSized, type Font } from '../motif/font';
import { charDefPath, loadRoster, type Motif, type Roster } from '../motif/system';
import { loadStage, type Stage } from '../stage/stage';
import { OPTIONS_GAME_SIZE, optionsFontHeight } from './options';
import type { RosterChar } from './select';

/** Loading progress reported to the host; undefined when it is done. */
export type LoadProgress = { phase: 'motif' | 'hud' | 'loading' } | { phase: 'characters'; done?: number; total?: number };

/** mugen.cfg [Arcade] <mode>.AIramp.start / .end: match, level offset (0 when missing). */
export type AiRamp = { startMatch: number; startOffset: number; endMatch: number; endOffset: number };
export type AiRamps = Record<'arcade' | 'team' | 'survival', AiRamp>;

export type GameAssets = Awaited<ReturnType<typeof loadAssets>>;

async function aiRamps(vfs: Vfs): Promise<AiRamps> {
  let sec: ReturnType<typeof findSection> | undefined;
  try {
    sec = findSection(parseIni(await vfs.text('data/mugen.cfg')), 'Arcade');
  } catch {
    sec = undefined;
  }
  const two = (k: string) => (sec ? (getValue(sec, k) ?? '') : '').split(',').map((x) => parseInt(x, 10));
  const ramp = (m: string): AiRamp => {
    const s = two(`${m}.airamp.start`);
    const e = two(`${m}.airamp.end`);
    const n = (v: number | undefined) => (Number.isFinite(v) ? v! : 0);
    return { startMatch: n(s[0]), startOffset: n(s[1]), endMatch: n(e[0]), endOffset: n(e[1]) };
  };
  return { arcade: ramp('arcade'), team: ramp('team'), survival: ramp('survival') };
}

export async function loadAssets(vfs: Vfs, motif: Motif, options: { noTtf?: boolean; onProgress?: (p: LoadProgress | undefined) => void }) {
  const ramps = await aiRamps(vfs);
  options.onProgress?.({ phase: 'characters' });
  const roster: Roster = await loadRoster(vfs, motif.selectDef);
  // Like mugen.exe, the select screen only needs each character's def and the
  // sprites the motif shows (portraits); the rest loads once it is picked.
  const motifSprites = (() => {
    const keys: [string, string, string][] = [
      ['Select Info', 'portrait.spr', '9000,0'],
      ['Select Info', 'p1.face.spr', '9000,1'],
      ['Select Info', 'p2.face.spr', '9000,1'],
      ['VS Screen', 'p1.spr', '9000,1'],
      ['VS Screen', 'p2.spr', '9000,1'],
      ['Victory Screen', 'p1.spr', '9000,1'],
      ['Victory Screen', 'p2.spr', '9000,1'],
    ];
    const out = new Map<string, [number, number]>();
    for (const [sec, k, d] of keys) {
      const [g, n] = (motif.value(sec, k) ?? d).split(',').map((x) => parseInt(x, 10));
      if (Number.isFinite(g) && Number.isFinite(n)) out.set(`${g},${n}`, [g!, n!]);
    }
    return [...out.values()];
  })();
  const rosterChars: RosterChar[] = roster.chars.map((entry) => ({
    entry,
    data: undefined,
    defPath: entry.def === 'randomselect' || !entry.def ? undefined : charDefPath(vfs, entry.def),
  }));
  // mugen.exe loads every character's def and portraits before the title
  // (gameflow state 2, Select_Init, after the logo storyboard).
  await (() => {
    let next = 0;
    let done = 0;
    const work = rosterChars.filter((c) => c.defPath);
    const worker = async () => {
      while (next < work.length) {
        const c = work[next++]!;
        c.data = await loadCharacterPreview(vfs, c.defPath!, motifSprites).catch((e) => {
          console.warn(`${c.defPath}: ${e}`);
          return undefined;
        });
        options.onProgress?.({ phase: 'characters', done: ++done, total: work.length });
      }
    };
    return Promise.all(Array.from({ length: 8 }, worker));
  })();

  async function stageName(path: string): Promise<string> {
    try {
      const doc = parseIni(await vfs.text(path));
      const info = findSection(doc, 'Info');
      return unquote(getValue(info, 'displayname') ?? getValue(info, 'name') ?? path);
    } catch {
      return path;
    }
  }
  const stagePaths = [...new Set([...roster.chars.filter((c) => c.stage && c.includeStage).map((c) => c.stage!), ...roster.extraStages])].filter((p) => vfs.resolve(p));
  const stages = await Promise.all(stagePaths.map(async (p) => ({ path: vfs.resolve(p)!, name: await stageName(vfs.resolve(p)!) })));

  options.onProgress?.({ phase: 'hud' });
  const hud = await FightHud.load(vfs, motif.fightDef, motif.localCoord[0]);
  const fightDoc = parseIni(await vfs.text(motif.fightDef));
  const ff = (k: string, d: string) => getValue(findSection(fightDoc, 'Files'), k) ?? d;
  const fightDir = motif.fightDef.replace(/\/[^/]*$/, '');
  const fightFx: FightFx = {
    anims: parseAir(await vfs.text(ff('fightfx.air', 'fightfx.air'), fightDir, 'data')),
    sff: await parseSff(await vfs.read(ff('fightfx.sff', 'fightfx.sff'), fightDir, 'data')),
    scale: parseFloat(getValue(findSection(fightDoc, 'FightFx'), 'scale') ?? '1') || 1,
    motifWidth: motif.localCoord[0],
  };
  const commonSnd: Snd | undefined = await vfs.read(ff('common.snd', 'common.snd'), fightDir, 'data').then(parseSnd).catch(() => undefined);

  // mugen.exe's system font for the continue screen (G+0x873c).
  const systemFont = await loadFont(vfs, 'font/f-6x9.def').catch(() => undefined);
  // Options_GetFont: font/options.def at a height that fits the game, else the medium font (f-6x9).
  let optionsFont: Font | undefined;
  async function getOptionsFont(): Promise<Font | undefined> {
    // noTtf: as if the truetype file were missing (the harness's Wine has no
    // arial.ttf, so mugen.exe falls back to the medium font there).
    optionsFont ??= options.noTtf ? systemFont : await loadFontSized(vfs, 'font/options.def', optionsFontHeight(OPTIONS_GAME_SIZE[1])).catch(() => systemFont);
    return optionsFont;
  }

  // The whole character (sprites, animations, sounds), loaded when picked.
  const fullChars = new Map<string, Promise<CharacterData>>();
  function fullData(c: RosterChar): Promise<CharacterData> {
    const key = c.defPath!;
    let d = fullChars.get(key);
    if (!d) {
      d = loadCharacter(vfs, key);
      fullChars.set(key, d);
    }
    return d;
  }
  const programs = new Map<string, CharacterProgram>();
  async function program(c: RosterChar): Promise<CharacterProgram> {
    const key = c.defPath!;
    let p = programs.get(key);
    if (!p) {
      p = await loadProgram(vfs, await fullData(c));
      programs.set(key, p);
    }
    return p;
  }
  const stageCache = new Map<string, Stage>();
  async function stage(path: string): Promise<Stage> {
    let s = stageCache.get(path);
    if (!s) {
      s = await loadStage(vfs, path);
      stageCache.set(path, s);
    }
    return s;
  }
  return { ramps, roster, rosterChars, stages, hud, fightFx, commonSnd, systemFont, getOptionsFont, program, stage };
}
