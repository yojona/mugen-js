// The game: title -> select -> VS -> fight -> victory, driven by the motif.

import { withContentFixes } from '../engine/content-fixes';
import { Mixer } from '../audio/mixer';
import { loadCharacter, loadCharacterPreview, type CharacterData } from '../engine/character';
import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_S, IN_U, IN_X, IN_Y, IN_Z } from '../engine/cmd';
import { loadProgram, type CharacterProgram } from '../engine/player';
import { httpSource, Vfs } from '../engine/vfs';
import { SessionRng } from '../engine/session-rng';
import { World, type FightFx } from '../engine/world';
import { parseAir } from '../formats/air';
import { parseSff } from '../formats/sff';
import { parseSnd, type Snd } from '../formats/snd';
import { findSection, getValue, parseIni, unquote } from '../formats/text';
import { FightHud } from '../motif/fight';
import { charDefPath, loadMotif, loadRoster, type Roster } from '../motif/system';
import { Renderer } from '../render/renderer';
import { loadStage, type Stage } from '../stage/stage';
import { FightScreen, type FightResult, type FightTeam } from './fight-screen';
import type { TeamMode } from '../engine/match';
import { ContinueScreen } from './continue';
import { loadFont, loadFontSized, type Font } from '../motif/font';
import { Keyboard } from './input';
import { VersusScreen, VictoryScreen } from './interstitial';
import type { AppContext, Screen } from './screen';
import { SelectScreen, type Pick, type RosterChar, type SelectResult, type TeamPick } from './select';
import { TitleScreen, TITLE_ITEMS, type GameMode, type TitleChoice } from './title';
import { GameOptions } from './game-options';
import { OptionsScreen, OPTIONS_GAME_SIZE, optionsFontHeight } from './options';
import { loadStoryboard, StoryboardScreen } from './storyboard';
import { SurvivalResultsScreen } from './results';

const params = new URLSearchParams(location.search);
const status = document.getElementById('status')!;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const setStatus = (t: string) => (status.textContent = t);

setStatus('Cargando archivos…');
// ?pristine=1 skips the content fixes (harness comparisons with mugen.exe).
const rawSource = await httpSource('/ref/mugen-1.1b1', '/__ref.json');
// ?selectb64=: a select.def (base64) in place of data/select.def, e.g. the
// flow harness's roster (tools/harness/overlay/data/select.def).
const selectB64 = params.get('selectb64');
const source: typeof rawSource = selectB64
  ? {
      ...rawSource,
      list: () => rawSource.list(),
      readRange: rawSource.readRange?.bind(rawSource),
      read: async (path) => (path.toLowerCase() === 'data/select.def' ? Uint8Array.from(atob(selectB64), (c) => c.charCodeAt(0)) : rawSource.read(path)),
    }
  : rawSource;
const vfs = new Vfs(params.get('pristine') ? source : withContentFixes(source));

// Motif: ?motif=, else mugen.cfg's "motif =", else data/system.def.
async function motifPath(): Promise<string> {
  const q = params.get('motif');
  if (q && vfs.resolve(q)) return vfs.resolve(q)!;
  try {
    const cfg = parseIni(await vfs.text('data/mugen.cfg'));
    const m = getValue(findSection(cfg, 'Options'), 'motif') ?? cfg.sections.flatMap((s) => s.entries).find((e) => e.key === 'motif')?.value;
    if (m && vfs.resolve(m)) return vfs.resolve(m)!;
  } catch {
    /* fall through */
  }
  return 'data/system.def';
}

setStatus('Cargando motif…');
const motif = await loadMotif(vfs, await motifPath());
const [mw, mh] = motif.localCoord;
const renderer = new Renderer(canvas);
const zoom = Math.max(1, Math.floor(960 / mw));
renderer.resize(mw, mh, zoom);
const mixer = new Mixer();
const keys = new Keyboard();
keys.onFirstInput = () => mixer.unlock();
// System_Init: Config_Load, Options_SetDefaults, Options_Load. The options
// screen's saves live in localStorage (not under the flow harness, which
// compares against a fresh mugen.cfg).
const gameOptions = await (async () => {
  const cfg = await vfs
    .text('data/mugen.cfg')
    .then(parseIni)
    .catch(() => undefined);
  let storage: Storage | undefined;
  try {
    storage = params.get('flowlog') ? undefined : window.localStorage;
  } catch {
    storage = undefined;
  }
  return new GameOptions(cfg, storage, { keysFromCfg: params.has('cfgkeys'), onRemap: (k, j, active) => keys.setMaps(k, j, active), padCount: () => keys.padCount() }).init();
})();
keys.onPadsChanged = () => gameOptions.initPads();
// The sounds play at MasterVolume * WavVolume (Sound_SetVolume).
mixer.volume = gameOptions.wavGain;

/** mugen.cfg [Arcade] <mode>.AIramp.start / .end: match, level offset (0 when missing). */
type AiRamp = { startMatch: number; startOffset: number; endMatch: number; endOffset: number };
async function aiRamps(): Promise<Record<'arcade' | 'team' | 'survival', AiRamp>> {
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
const ramps = await aiRamps();

/**
 * Player_GetAiLevel: the difficulty (4 in survival) moved along the mode's
 * AI ramp by the match index (arcade: matches before this one; survival:
 * the round), clamped to 1..8.
 */
function rampedAiLevel(kind: 'arcade' | 'team' | 'survival', match: number): number {
  const r = ramps[kind];
  let level = kind === 'survival' ? 4 : ctx.aiLevel;
  if (match <= r.startMatch) level += r.startOffset;
  else if (match >= r.endMatch) level += r.endOffset;
  else if (r.startMatch < r.endMatch) level += Math.trunc(((r.endOffset - r.startOffset) * (match - r.startMatch)) / (r.endMatch - r.startMatch)) + r.startOffset;
  return Math.max(1, Math.min(8, level));
}
// [Options] Difficulty: the CPU's AILevel (clamped 1..8).
const ctx: AppContext = { renderer, mixer, keys, motif, aiLevel: Math.max(1, Math.min(8, gameOptions.difficulty)), frames: 0, options: gameOptions };

setStatus('Cargando personajes…');
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
let busy = false;
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
      setStatus(`Cargando personajes… ${++done}/${work.length}`);
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

setStatus('Cargando HUD…');
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
  // ?nottf: as if the truetype file were missing (the harness's Wine has no
  // arial.ttf, so mugen.exe falls back to the medium font there).
  optionsFont ??= params.get('nottf') ? systemFont : await loadFontSized(vfs, 'font/options.def', optionsFontHeight(OPTIONS_GAME_SIZE[1])).catch(() => systemFont);
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
setStatus('');

// ---------------------------------------------------------------------------
// Flow

let screen: Screen = new TitleScreen(ctx);
// MUGEN's session RNG: -sessionseed, else seeded from the clock.
const session = new SessionRng(parseInt(params.get('sessionseed') ?? '', 10) || (Date.now() % 2147483646) + 1);

function randomOpponent(exclude?: RosterChar): Pick {
  const pool = rosterChars.filter((c) => c.data && c !== exclude);
  const all = pool.length ? pool : rosterChars.filter((c) => c.data);
  const c = all[Math.floor(Math.random() * all.length)]!;
  return { char: c, pal: 1 + Math.floor(Math.random() * 2) };
}

/** A side of a team fight: its mode, characters and who plays each (pad, or CPU). */
interface TeamSide {
  mode: TeamMode;
  picks: Pick[];
  pads: (number | undefined)[];
}

/** [Options] Life, Team.1VS2Life, Team.LoseOnKO (as the options screen left them). */
const teamOptions = () => ({ life: gameOptions.life, team1vs2Life: gameOptions.team1vs2Life, loseOnKo: gameOptions.teamLoseOnKo });

/** Charsel_End: the select screen's "random" stage is a session draw over the stage list. */
function pickStage(s: string | undefined): string | undefined {
  return s === 'random' ? stages[session.next() % stages.length]!.path : s;
}

/** survival: the reseed of each new round (the next opponent's draws, then the match seed). */
async function teamFight(sides: [TeamSide, TeamSide], stagePath: string | undefined, survival?: () => number, aiLevel?: (member: number) => number): Promise<FightScreen> {
  const lead = sides[1].picks[0] ?? sides[0].picks[0]!;
  const sp = stagePath ?? vfs.resolve(lead.char.entry.stage ?? '') ?? stages[0]!.path;
  const teams = (await Promise.all(
    sides.map(async (t) => ({ mode: t.mode, picks: t.picks, pads: t.pads, progs: await Promise.all(t.picks.map((pk) => program(pk.char))) })),
  )) as [FightTeam, FightTeam];
  return new FightScreen(ctx, {
    seed: session.matchSeed(),
    p1: sides[0].picks[0]!,
    p2: sides[1].picks[0]!,
    progs: [teams[0].progs[0]!, teams[1].progs[0]!],
    stage: await stage(sp),
    hud,
    fightFx,
    commonSnd,
    human: [sides[0].pads.some((x) => x !== undefined), sides[1].pads.some((x) => x !== undefined)],
    training: false,
    teams,
    options: teamOptions(),
    survival: survival ? { side: 0, reseed: survival } : undefined,
    aiLevel,
  });
}

/** The computer's team of a team match: `count` characters from the arcade order (its palettes as an arcade opponent's). */
function cpuPicks(chars: RosterChar[]): Pick[] {
  return chars.map((c) => ({ char: c, pal: session.opponentPalette((i) => !!c.data?.palettes?.[i]) }));
}

/** Team arcade, team co-op and team versus / watch with teams. */
async function runTeamMode(mode: GameMode, sel: SelectResult): Promise<void> {
  const [mine, theirs] = sel.teams!;
  // Pads: a human pick uses pad 0, the co-op partner pad 1 (TeamPick.ai false); P2's side in versus uses pad 1.
  const padsOf = (t: TeamPick, side: number) => t.ai.slice(0, t.mode === 'single' ? 1 : t.count).map((ai, k) => (ai || mode === 'watch' ? undefined : side === 1 ? 1 : k));
  if (mode === 'teamversus' || mode === 'watch') {
    const sides: [TeamSide, TeamSide] = [
      { mode: mine.mode, picks: mine.picks, pads: padsOf(mine, 0) },
      { mode: theirs.mode, picks: theirs.picks, pads: padsOf(theirs, 1) },
    ];
    // Gameflow state 10: every mode but quick VS and the demo has a versus screen.
    await until(new VersusScreen(ctx, sides[0].picks[0]!, sides[1].picks[0]!, 1));
    await until(await loading(() => teamFight(sides, pickStage(sel.stage))));
    return;
  }
  if (mode === 'survival' || mode === 'survivalcoop') {
    // Charsel_End / Match_NextRound: a random computer team for every round
    // (Team_Randomize); its characters are loaded ahead, a list of them.
    // The session draws, as mugen.exe makes them: Team_Randomize at the end
    // of the select screen draws members 0 and 1 (each slot a character
    // and, with AI.RandomColor, a palette), Gameflow_PickStage a random
    // stage, then the match seed; every later round one more member, then
    // the match seed again. The later members are worked out ahead on a
    // copy of the RNG (their characters have to be loaded).
    const size = theirs.mode === 'simul' ? 2 : 1;
    const all = rosterChars.filter((c) => c.data);
    const slot = (rng: SessionRng): Pick => {
      const c = all[rng.next() % all.length]!;
      return { char: c, pal: rng.opponentPalette((i) => !!c.data?.palettes?.[i]) };
    };
    const picks = Array.from({ length: 2 * size }, () => slot(session));
    const sp = pickStage(sel.stage) ?? vfs.resolve(picks[0]!.char.entry.stage ?? '') ?? stages[0]!.path;
    const ahead = new SessionRng(session.seed);
    ahead.matchSeed();
    while (picks.length < 60 * size) {
      for (let k = 0; k < size; k++) picks.push(slot(ahead));
      ahead.matchSeed();
    }
    const opp: TeamSide = { mode: theirs.mode === 'simul' ? 'simul' : 'single', picks, pads: picks.map(() => undefined) };
    const human: TeamSide = { mode: mine.mode, picks: mine.picks, pads: padsOf(mine, 0) };
    // Gameflow 10: the versus screen with the first opponent.
    await until(new VersusScreen(ctx, human.picks[0]!, opp.picks[0]!, 1));
    const reseed = () => {
      for (let k = 0; k < size; k++) slot(session);
      return session.matchSeed();
    };
    // Player_GetAiLevel: each opponent by the round it starts in.
    const res = await until<FightResult>(await loading(() => teamFight([human, opp], sp, reseed, (member) => rampedAiLevel('survival', member + 1))));
    if (res.winner === undefined) return;
    // Gameflow 15: the survival results ([Survival Results Screen] enabled).
    if ((motif.value('Survival Results Screen', 'enabled') ?? '1') !== '0') {
      const pks = human.picks.slice(0, human.mode === 'simul' ? 2 : 1);
      await until(
        await loading(async () => {
          const players = await Promise.all(pks.map(async (pk) => ({ prog: await program(pk.char), pal: pk.char.data?.def.palDefaults[0] ?? 1 })));
          return new SurvivalResultsScreen(ctx, { players, stage: await stage(sp), fightFx, wins: res.wins?.[0] ?? 0, seed: session.matchSeed() });
        }),
      );
    }
    return;
  }
  // Team arcade / co-op: the computer team takes its characters from the
  // arcade order, team_size at a time (Arcade_BuildOrder / Arcade_NextTeam).
  const size = theirs.mode === 'single' ? 1 : theirs.count;
  const pool = rosterChars.filter((c) => c.data).map((c) => ({ c, order: c.entry.order }));
  const maxMatches = size > 1 || theirs.mode !== 'single' ? roster.teamMaxMatches : roster.arcadeMaxMatches;
  const order = session.arcadeOrder(pool, maxMatches, size).map((x) => x.c);
  let human: TeamSide = { mode: mine.mode, picks: mine.picks, pads: padsOf(mine, 0) };
  for (let n = 0, match = 1; n + size <= order.length; n += size, match++) {
    const opp: TeamSide = { mode: theirs.mode, picks: cpuPicks(order.slice(n, n + size)), pads: new Array(size).fill(undefined) };
    // Gameflow state 9: before match 1 (again after continuing it), the
    // intro storyboard of the arcade side's first character.
    const lead = human.picks[0]?.char;
    if (match === 1) await storyboard(lead?.data?.def.arcade.intro, lead?.data?.dir ?? '');
    await until(new VersusScreen(ctx, human.picks[0]!, opp.picks[0]!, match));
    // Player_GetAiLevel: the team ramp against a simul / turns team, else the arcade one, by the matches before.
    const ramp = theirs.mode !== 'single' || size > 1 ? 'team' : 'arcade';
    const res = await until<{ winner: number | undefined; quote?: string }>(await loading(() => teamFight([human, opp], undefined, undefined, () => rampedAiLevel(ramp, match - 1))));
    if (res.winner !== 0) {
      // Match_Run: an arcade loss goes to the continue screen (state 13), as
      // in arcade, with the team's first character; Yes picks the team again
      // and replays this match.
      if (res.winner === undefined) return;
      if ((motif.value('Continue Screen', 'enabled') ?? '1') === '0') {
        arcadeEnd = 'gameover';
        return;
      }
      const first = human.picks[0]!.char;
      const sp = vfs.resolve(opp.picks[0]!.char.entry.stage ?? '') ?? stages[0]!.path;
      const again = await until<boolean>(
        await loading(async () => new ContinueScreen(ctx, { prog: await program(first), pal: first.data?.def.palDefaults[0] ?? 1, stage: await stage(sp), fightFx, font: systemFont, seed: session.matchSeed() })),
      );
      if (!again) {
        arcadeEnd = 'gameover';
        return;
      }
      const re = await until<SelectResult>(new SelectScreen(ctx, mode, rosterChars, stages));
      if (re.cancelled || !re.teams) return;
      human = { mode: re.teams[0].mode, picks: re.teams[0].picks, pads: padsOf(re.teams[0], 0) };
      n -= size;
      match--;
      continue;
    }
    if (n + size < order.length && (motif.value('Victory Screen', 'enabled') ?? '1') !== '0') {
      await until(new VictoryScreen(ctx, human.picks[0]!, res.quote ?? (motif.value('Victory Screen', 'winquote.text') ?? 'Winner!').replace(/^"|"$/g, '')));
    }
  }
  // After the last match: the ending of the arcade side's first character.
  const lastOpp = order[Math.floor((order.length - size) / size) * size];
  await arcadeEnding(human.picks.slice(0, human.mode === 'simul' ? 2 : 1), lastOpp ? vfs.resolve(lastOpp.entry.stage ?? '') : undefined);
}

/**
 * Match_Run after the last arcade match: the first character's ending
 * storyboard (state 18), else the win screen (16, [Win Screen]) and the
 * default ending (17, [Default Ending]); either way the end credits and the
 * intro follow (arcadeEnd).
 */
async function arcadeEnding(picks: Pick[], stagePath: string | undefined): Promise<void> {
  const first = picks[0]?.char;
  arcadeEnd = 'ending';
  if (first?.data?.def.arcade.ending && vfs.resolve(first.data.def.arcade.ending, first.data.dir)) {
    await storyboard(first.data.def.arcade.ending, first.data.dir);
    return;
  }
  if ((motif.value('Win Screen', 'enabled') ?? '1') !== '0') {
    const sp = stagePath ?? stages[0]!.path;
    await until(
      await loading(async () => {
        const players = await Promise.all(picks.map(async (pk) => ({ prog: await program(pk.char), pal: pk.char.data?.def.palDefaults[0] ?? 1 })));
        return new SurvivalResultsScreen(ctx, { players, stage: await stage(sp), fightFx, wins: 0, seed: session.matchSeed(), kind: 'win' });
      }),
    );
  }
  if ((motif.value('Default Ending', 'enabled') ?? '0') !== '0') await storyboard(motif.value('Default Ending', 'storyboard')?.trim() || undefined, 'data');
}

async function fight(mode: GameMode, p1: Pick, p2: Pick, stagePath: string | undefined, aiLevel?: () => number, demo?: { endTime: number; bars: boolean }): Promise<FightScreen> {
  const sp = stagePath ?? vfs.resolve(p2.char.entry.stage ?? '') ?? stages[0]!.path;
  const progs: [CharacterProgram, CharacterProgram] = [await program(p1.char), await program(p2.char)];
  // Same character and palette on both sides: P2 takes the next palette.
  if (p1.char === p2.char && p1.pal === p2.pal) p2 = { ...p2, pal: (p2.pal % 6) + 1 };
  const matchSeed = session.matchSeed();
  return new FightScreen(ctx, {
    seed: matchSeed,
    p1,
    p2,
    progs,
    stage: await stage(sp),
    hud,
    fightFx,
    commonSnd,
    human: mode === 'versus' ? [true, true] : mode === 'watch' ? [false, false] : [true, false],
    training: mode === 'training',
    options: { life: gameOptions.life },
    aiLevel,
    demo,
  });
}

/** Play a storyboard file if it exists (errors are skipped). */
async function storyboard(path: string | undefined, ...bases: string[]): Promise<void> {
  if (!path) return;
  const p = vfs.resolve(path, ...bases);
  if (!p) return;
  const sb = await loading(() => loadStoryboard(vfs, p)).catch(() => undefined);
  if (sb) await until(new StoryboardScreen(ctx, sb));
}

/** Run one mode to completion, returning to the title. */
async function runMode(mode: GameMode): Promise<void> {
  for (;;) {
    const sel = await until<SelectResult>(new SelectScreen(ctx, mode, rosterChars, stages));
    if (sel.cancelled) return;
    // Charsel_End: a "random" stage is drawn first of all the session draws.
    sel.stage = pickStage(sel.stage);
    const team = sel.teams && (mode !== 'watch' || sel.teams.some((t) => t.mode !== 'single'));
    if (team && mode !== 'arcade' && mode !== 'versus' && mode !== 'training') {
      await runTeamMode(mode, sel);
      // State 6 after a team versus, watch or survival match: back to the select screen.
      if (mode !== 'teamversus' && mode !== 'watch' && mode !== 'survival' && mode !== 'survivalcoop') return;
      continue;
    }
    if (mode === 'arcade') {
      const chosen = sel.p1.char;
      // 0x40a370: shuffled roster by order, the player's character included.
      const pool = rosterChars.filter((c) => c.data).map((c) => ({ c, order: c.entry.order }));
      const opponents = session.arcadeOrder(pool, roster.arcadeMaxMatches).map((x) => x.c);
      for (let n = 1; n <= opponents.length; n++) {
        const oc = opponents[n - 1]!;
        const opp: Pick = { char: oc, pal: session.opponentPalette((i) => !!oc.data?.palettes?.[i]) };
        // Gameflow state 9: the intro storyboard before match 1, again after
        // continuing it (arcade_match stays 1).
        if (n === 1) await storyboard(sel.p1.char.data?.def.arcade.intro, sel.p1.char.data?.dir ?? '');
        await until(new VersusScreen(ctx, sel.p1, opp, n));
        const res = await until<{ winner: number | undefined; quote?: string }>(await loading(() => fight(mode, sel.p1, opp, undefined, () => rampedAiLevel('arcade', n - 1))));
        if (res.winner !== 0) {
          if (res.winner === undefined) return;
          if ((motif.value('Continue Screen', 'enabled') ?? '1') === '0') {
            arcadeEnd = 'gameover';
            return;
          }
          // Continue? Yes: pick a character again and replay this match. The
          // player shows in its first default palette (measured: KFM picked
          // with a, palette 4, continues in palette 1).
          const sp = vfs.resolve(opp.char.entry.stage ?? '') ?? stages[0]!.path;
          const again = await until<boolean>(
            await loading(async () => new ContinueScreen(ctx, { prog: await program(sel.p1.char), pal: sel.p1.char.data?.def.palDefaults[0] ?? 1, stage: await stage(sp), fightFx, font: systemFont, seed: session.matchSeed() })),
          );
          if (!again) {
            arcadeEnd = 'gameover';
            return;
          }
          const re = await until<SelectResult>(new SelectScreen(ctx, mode, rosterChars, stages));
          if (re.cancelled) return;
          sel.p1 = re.p1;
          n--;
          continue;
        }
        // Not after the last match (system.def [Victory Screen] notes).
        if (n < opponents.length && (motif.value('Victory Screen', 'enabled') ?? '1') !== '0') {
          await until(new VictoryScreen(ctx, sel.p1, res.quote ?? (motif.value('Victory Screen', 'winquote.text') ?? 'Winner!').replace(/^"|"$/g, '')));
        }
      }
      const last = opponents[opponents.length - 1];
      await arcadeEnding([sel.p1], last ? vfs.resolve(last.entry.stage ?? '') : undefined);
      void chosen;
      return;
    }
    const p2 = sel.p2 ?? randomOpponent();
    // Gameflow state 10: versus, training and watch alike.
    await until(new VersusScreen(ctx, sel.p1, p2, 1));
    await until(await loading(() => fight(mode, sel.p1, p2, pickStage(sel.stage))));
  }
}

let resolver: ((v: unknown) => void) | undefined;
function until<T>(s: Screen): Promise<T> {
  screen = s;
  return new Promise<T>((res) => (resolver = res as (v: unknown) => void));
}
async function loading<T>(f: () => Promise<T>): Promise<T> {
  busy = true;
  setStatus('Cargando…');
  try {
    return await f();
  } finally {
    busy = false;
    setStatus('');
  }
}

async function mainLoop(): Promise<void> {
  let menuPos = 0;
  // Motif logo and intro storyboards play once at start-up.
  await storyboard(motif.logoStoryboard);
  await storyboard(motif.introStoryboard);
  let demoCycles = 0;
  for (;;) {
    const mode = await until<TitleChoice | 'demo'>(new TitleScreen(ctx, menuPos));
    if (mode === 'demo') {
      await runDemo();
      // Title_Init: back on Arcade after a demo; Demo_TickFight: after
      // intro.waitcycles demos the intro storyboard plays again.
      menuPos = 0;
      const n = demoCycles++;
      if (n >= (parseInt(motif.value('Demo Mode', 'intro.waitcycles') ?? '1', 10) || 0)) {
        demoCycles = 0;
        await storyboard(motif.introStoryboard);
      }
      continue;
    }
    // Title_End: the chosen item stays the cursor's (GameVars.game_mode).
    menuPos = TITLE_ITEMS.findIndex((i) => i.key === mode);
    if (mode === 'exit') {
      // Title_Run: GAMEFLOW_EXIT quits mugen.exe; the page starts afresh.
      location.reload();
      return;
    }
    if (mode === 'options') {
      // Gameflow state 5: Options_Run, then the title again.
      const font = await loading(getOptionsFont);
      if (font) await until(new OptionsScreen(ctx, font, gameOptions));
      continue;
    }
    arcadeEnd = undefined;
    await runMode(mode);
    // Gameflow 14 (game over: [Game Over Screen] storyboard) or 19 (after
    // the ending: [End Credits] storyboard), then state 3: the intro
    // storyboard plays again (intro_played = 0) before the title.
    if (arcadeEnd) {
      const sec = arcadeEnd === 'gameover' ? 'Game Over Screen' : 'End Credits';
      if ((motif.value(sec, 'enabled') ?? '0') !== '0') await storyboard(motif.value(sec, 'storyboard')?.trim() || undefined, 'data');
      await storyboard(motif.introStoryboard);
    }
  }
}

/** How the last arcade run ended: a game over (gameflow 14) or its ending (18 / 16). */
let arcadeEnd: 'gameover' | 'ending' | undefined;

/**
 * A demo fight (Demo_SetupTeams, Gameflow_PickStage): a random character
 * with a random palette (of 12) on each side and a random stage, all from
 * the session RNG, computer against computer.
 */
async function runDemo(): Promise<void> {
  const all = rosterChars.filter((c) => c.data);
  if (!all.length) return;
  const pick = (): Pick => {
    const c = all[session.next() % all.length]!;
    return { char: c, pal: (session.next() % 12) + 1 };
  };
  const p1 = pick();
  const p2 = pick();
  const sp = stages[session.next() % stages.length]!.path;
  const v = (k: string, d: number) => {
    const n = parseInt(motif.value('Demo Mode', k) ?? '', 10);
    return Number.isFinite(n) ? n : d;
  };
  await until(await loading(() => fight('watch', p1, p2, sp, undefined, { endTime: v('fight.endtime', 1500), bars: v('fight.bars.display', 0) !== 0 })));
}

// ---------------------------------------------------------------------------
// Fixed 60 Hz loop

function stepOnce(): void {
  if (busy) return;
  keys.poll();
  if (script) feedScript();
  if (flowHarness) flowHarness.before(screen);
  screen.tick();
  ctx.frames = (ctx.frames ?? 0) + 1;
  if (flowHarness) flowHarness.after(screen);
  if (screen.result !== undefined && resolver) {
    const r = resolver;
    resolver = undefined;
    const v = screen.result;
    screen.result = undefined;
    r(v);
  }
}

// ?keys=w60,x,w30,r,x : scripted P1 input for headless checks (w = wait ticks).
const KEYMAP: Record<string, number> = { u: IN_U, d: IN_D, l: IN_L, r: IN_R, x: IN_X, y: IN_Y, z: IN_Z, a: IN_A, b: IN_B, c: IN_C, s: IN_S };
const script = params.get('keys')?.split(',').filter(Boolean);
let scriptPos = 0;
let scriptWait = 0;
function feedScript(): void {
  if (!script) return;
  if (scriptWait > 0) {
    scriptWait--;
    return;
  }
  const tok = script[scriptPos];
  if (!tok) return;
  if (tok.startsWith('w')) {
    scriptWait = parseInt(tok.slice(1), 10) || 0;
    scriptPos++;
    return;
  }
  keys.pads[0]!.bits = [...tok].reduce((b, ch) => b | (KEYMAP[ch] ?? 0), 0);
  scriptPos++;
}

// Flow harness (tools/harness/flow-ours.ts), compared with mugen.exe's whole
// game flow: ?flowlog=1 logs every screen change with the frame number,
// ?fkeys=f:keys[:hold];... presses P1 keys from frame f (frame = ticks run +
// ?frame0), ?mash=Screen:keys:every:hold presses keys on frames where
// frame % every == 0 while that screen runs, ?clamp=side:max caps a fighter's
// life after every tick, ?shotevery=N logs the canvas every N frames and on
// every screen change.
const flowHarness = params.get('flowlog') ? makeFlowHarness() : undefined;

function makeFlowHarness() {
  let frame = parseInt(params.get('frame0') ?? '0', 10);
  const parseKeys = (k: string) => [...k].reduce((b, ch) => b | (KEYMAP[ch] ?? 0), 0);
  const fkeys = (params.get('fkeys') ?? '')
    .split(';')
    .filter(Boolean)
    .map((p) => {
      const [f, k = '', hold] = p.split(':');
      // Upper case keys go to P2's pad.
      const p2 = k !== k.toLowerCase();
      return { from: parseInt(f!, 10), bits: parseKeys(k.toLowerCase()), hold: parseInt(hold ?? '2', 10), pad: p2 ? 1 : 0 };
    });
  const mash = params.get('mash')?.split(':');
  const clamp = params
    .get('clamp')
    ?.split(';')
    .filter(Boolean)
    .map((c) => c.split(':').map(Number) as [number, number]);
  const shotEvery = parseInt(params.get('shotevery') ?? '0', 10);
  // ?shots=f,f,...: also a shot on these frames.
  const shotAt = new Set((params.get('shots') ?? '').split(',').filter(Boolean).map(Number));
  const keyDelay = parseInt(params.get('keydelay') ?? '0', 10);
  // ?mashdelay: the same for the in-fight button presses (default keydelay).
  const mashDelay = parseInt(params.get('mashdelay') ?? params.get('keydelay') ?? '0', 10);
  const [seedFrom, seedTo] = (params.get('seeds') ?? '-1:-1').split(':').map(Number) as [number, number];
  let lastName = '';
  let lastRs = '';
  const shot = () => {
    screen.draw();
    console.log(`SHOT|${frame}|${canvas.toDataURL('image/png')}`);
  };
  // ?dumpexplods=from:to logs the fight's explods (action, element, position, owner).
  const [exFrom, exTo] = (params.get('dumpexplods') ?? '-1:-1').split(':').map(Number) as [number, number];
  const [cmFrom, cmTo] = (params.get('dumpcmds') ?? '-1:-1').split(':').map(Number) as [number, number];
  const commandLabel = (n: string) => (/^[\x20-\x7e]+$/.test(n) ? n : [...n].map((c) => c.charCodeAt(0).toString(16)).join(''));
  const [rtFrom, rtTo] = (params.get('randtrace') ?? '-1:-1').split(':').map(Number) as [number, number];
  if (rtFrom >= 0) {
    const orig = World.prototype.random;
    World.prototype.random = function (this: World, n: number) {
      const v = orig.call(this, n);
      if (frame >= rtFrom && frame <= rtTo) {
        const st = (new Error().stack ?? '').split('\n').slice(2, 6).map((l) => l.trim().replace(/\(.*\/src\//, '(').replace(/\?[^:)]*/, '')).join(' < ');
        console.log(`DBG|${frame}|rand ${n}=${v} ${this.players.map((p) => `${p.stateNo}/${p.time}/${p.ai?.state ?? '-'}`).join(' ')} ${st}`);
      }
      return v;
    };
  }
  return {
    before(s: Screen) {
      let bits = 0;
      // ?keydelay / ?mashdelay: frames the mugen.exe driver's keys take to
      // reach the game (menus run at 60 fps, fights at the GameSpeed).
      const kf = frame - keyDelay;
      for (const k of fkeys) {
        if (kf < k.from || kf >= k.from + k.hold) continue;
        if (k.pad === 0) bits |= k.bits;
        else keys.pads[k.pad]!.bits |= k.bits;
      }
      const fighting = !(s instanceof FightScreen) || s.world.roundState === 2;
      if (mash && fighting && s.constructor.name === mash[0] && (((kf - mashDelay + keyDelay) % parseInt(mash[2]!, 10)) + parseInt(mash[2]!, 10)) % parseInt(mash[2]!, 10) < parseInt(mash[3]!, 10)) bits |= parseKeys(mash[1]!);
      if (bits) keys.pads[0]!.bits |= bits;
    },
    after(s: Screen) {
      const name = s.constructor.name;
      if (clamp && s instanceof FightScreen) {
        for (const [side, max] of clamp) {
          const p = s.world.players[side];
          if (p && p.life > max) p.life = max;
        }
      }
      if (s instanceof FightScreen && seedFrom >= 0 && frame >= seedFrom && frame <= seedTo) console.log(`SEED|${frame}|${s.world.seed}|${s.world.players.map((p) => `${p.stateNo}/${p.time} y${p.pos.y.toFixed(2)} vy${p.vel.y.toFixed(3)} pal${p.palNo}${p.ctrl ? ' c' : ''}`).join(' ')}`);
      // ?dumpsuper logs the frames a darkening SuperPause runs.
      if (s instanceof FightScreen && params.get('dumpsuper') && s.world.darkened) console.log(`DBG|${frame}|superpause owner=${s.world.superPause!.owner.slotNo}`);
      // ?dumpcmds=from:to logs each player's active commands and the AI's injected indices.
      if (s instanceof FightScreen && frame >= cmFrom && frame <= cmTo) {
        console.log(`DBG|${frame}|flags ${[...s.world.assertFlags].join(',')} helpers ${s.world.helpers.map((h) => `${h.root.slotNo}:${h.helperId}:${h.stateNo}/${h.time}`).join(' ')}`);
        for (const p of s.world.players) console.log(`DBG|${frame}|cmds P${p.slotNo} state=${p.stateNo} ai=${p.ai?.cmds.join(',') ?? ''} active=${[...(p.cmdInput?.active() ?? [])].map((n) => commandLabel(n)).join(' ')} write=${p.cmdInput?.debugWrite} queue=${(p.cmdInput?.debugQueue(14) ?? []).map(([k, t, h]) => `${k.toString(16)}@${t}/${h}`).join(' ')}`);
      }
      if (s instanceof FightScreen && frame >= exFrom && frame <= exTo) {
        for (const e of s.world.explods) console.log(`DBG|${frame}|explod ${e.anim.current?.group},${e.anim.current?.number} common=${e.common} x=${e.x.toFixed(1)} y=${e.y.toFixed(1)} age=${e.age} scale=${e.drawScale} owner=${e.owner?.slotNo}`);
      }
      if (s instanceof FightScreen) {
        const key = `${s.world.roundState}`;
        if (key !== lastRs) console.log(`DBG|${frame}|rs ${s.world.roundState} seed ${s.world.seed} life ${s.world.players.map((p) => p.life).join(',')}`);
        lastRs = key;
      } else lastRs = '';
      if (name !== lastName) {
        console.log(`FLOW|${frame}|${name}`);
        lastName = name;
        if (shotEvery) shot();
      } else if ((shotEvery && frame % shotEvery === 0) || shotAt.has(frame)) shot();
      frame++;
    },
  };
}

void mainLoop();

const ticksParam = params.get('ticks');
if (ticksParam) {
  // Headless: advance a fixed number of ticks, yielding between ticks so screen
  // transitions (promises) settle exactly as they do in real time; then draw.
  const target = parseInt(ticksParam, 10);
  void (async () => {
    for (let done = 0; done < target; ) {
      if (busy) {
        await new Promise((r) => setTimeout(r, 0));
        continue;
      }
      stepOnce();
      done++;
      await Promise.resolve();
      await Promise.resolve();
    }
    screen.draw();
    document.title = 'listo';
  })();
} else {
  let acc = 0;
  let last = performance.now();
  const frame = (now: number) => {
    acc += Math.min(now - last, 250);
    last = now;
    // Match_Setup: a match runs at the game speed's frame rate, the other screens at 60.
    for (;;) {
      const tick = 1000 / (screen instanceof FightScreen ? gameOptions.matchFps : 60);
      if (acc < tick) break;
      stepOnce();
      acc -= tick;
    }
    if (!busy) screen.draw();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
