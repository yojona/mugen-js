// The game: title -> select -> VS -> fight -> victory, driven by the motif.

import { withContentFixes } from '../engine/content-fixes';
import { Mixer } from '../audio/mixer';
import { loadCharacter } from '../engine/character';
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
import { FightScreen } from './fight-screen';
import { ContinueScreen } from './continue';
import { loadFont } from '../motif/font';
import { Keyboard } from './input';
import { VersusScreen, VictoryScreen } from './interstitial';
import type { AppContext, Screen } from './screen';
import { SelectScreen, type Pick, type RosterChar, type SelectResult } from './select';
import { TitleScreen, type GameMode } from './title';
import { loadStoryboard, StoryboardScreen } from './storyboard';

const params = new URLSearchParams(location.search);
const status = document.getElementById('status')!;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const setStatus = (t: string) => (status.textContent = t);

setStatus('Cargando archivos…');
// ?pristine=1 skips the content fixes (harness comparisons with mugen.exe).
const rawSource = await httpSource('/ref/mugen-1.1b1', '/__ref.json');
const vfs = new Vfs(params.get('pristine') ? rawSource : withContentFixes(rawSource));

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
// mugen.cfg [Options] Difficulty: the CPU's AILevel (default 4, clamped 1..8).
async function aiLevel(): Promise<number> {
  try {
    const cfg = parseIni(await vfs.text('data/mugen.cfg'));
    const v = parseInt(getValue(findSection(cfg, 'Options'), 'difficulty') ?? '', 10);
    return Number.isFinite(v) ? Math.max(1, Math.min(8, v)) : 4;
  } catch {
    return 4;
  }
}
const ctx: AppContext = { renderer, mixer, keys, motif, aiLevel: await aiLevel() };

setStatus('Cargando personajes…');
const roster: Roster = await loadRoster(vfs, motif.selectDef);
const rosterChars: RosterChar[] = [];
for (const entry of roster.chars) {
  if (entry.def === 'randomselect' || !entry.def) {
    rosterChars.push({ entry, data: undefined, defPath: undefined });
    continue;
  }
  const defPath = charDefPath(vfs, entry.def);
  const data = defPath ? await loadCharacter(vfs, defPath).catch(() => undefined) : undefined;
  rosterChars.push({ entry, data, defPath });
}

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
};
const commonSnd: Snd | undefined = await vfs.read(ff('common.snd', 'common.snd'), fightDir, 'data').then(parseSnd).catch(() => undefined);

// mugen.exe's system font for the continue screen (G+0x873c).
const systemFont = await loadFont(vfs, 'font/f-6x9.def').catch(() => undefined);

const programs = new Map<string, CharacterProgram>();
async function program(c: RosterChar): Promise<CharacterProgram> {
  const key = c.defPath!;
  let p = programs.get(key);
  if (!p) {
    p = await loadProgram(vfs, c.data!);
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
let busy = false;

function randomOpponent(exclude?: RosterChar): Pick {
  const pool = rosterChars.filter((c) => c.data && c !== exclude);
  const all = pool.length ? pool : rosterChars.filter((c) => c.data);
  const c = all[Math.floor(Math.random() * all.length)]!;
  return { char: c, pal: 1 + Math.floor(Math.random() * 2) };
}

async function fight(mode: GameMode, p1: Pick, p2: Pick, stagePath: string | undefined): Promise<FightScreen> {
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
    if (mode === 'arcade') {
      const chosen = sel.p1.char;
      await storyboard(chosen.data?.def.arcade.intro, chosen.data?.dir ?? '');
      // 0x40a370: shuffled roster by order, the player's character included.
      const pool = rosterChars.filter((c) => c.data).map((c) => ({ c, order: c.entry.order }));
      const opponents = session.arcadeOrder(pool, roster.arcadeMaxMatches).map((x) => x.c);
      for (let n = 1; n <= opponents.length; n++) {
        const oc = opponents[n - 1]!;
        const opp: Pick = { char: oc, pal: session.opponentPalette((i) => !!oc.data?.palettes?.[i]) };
        await until(new VersusScreen(ctx, sel.p1, opp, n));
        const res = await until<{ winner: number | undefined }>(await loading(() => fight(mode, sel.p1, opp, undefined)));
        if (res.winner !== 0) {
          if (res.winner === undefined || (motif.value('Continue Screen', 'enabled') ?? '1') === '0') return;
          // Continue? Yes: pick a character again and replay this match. The
          // player shows in its first default palette (measured: KFM picked
          // with a, palette 4, continues in palette 1).
          const sp = vfs.resolve(opp.char.entry.stage ?? '') ?? stages[0]!.path;
          const again = await until<boolean>(
            await loading(async () => new ContinueScreen(ctx, { prog: await program(sel.p1.char), pal: sel.p1.char.data?.def.palDefaults[0] ?? 1, stage: await stage(sp), fightFx, font: systemFont, seed: session.matchSeed() })),
          );
          if (!again) return;
          const re = await until<SelectResult>(new SelectScreen(ctx, mode, rosterChars, stages));
          if (re.cancelled) return;
          sel.p1 = re.p1;
          n--;
          continue;
        }
        const quotes = programs.get(sel.p1.char.defPath!)?.quotes ?? [];
        // Not after the last match (system.def [Victory Screen] notes).
        if (n < opponents.length && (motif.value('Victory Screen', 'enabled') ?? '1') !== '0') {
          await until(new VictoryScreen(ctx, sel.p1, quotes.length ? quotes[Math.floor(Math.random() * quotes.length)]! : (motif.value('Victory Screen', 'winquote.text') ?? 'Winner!').replace(/^"|"$/g, '')));
        }
      }
      await storyboard(chosen.data?.def.arcade.ending, chosen.data?.dir ?? '');
      return;
    }
    const p2 = sel.p2 ?? randomOpponent();
    if (mode === 'versus') await until(new VersusScreen(ctx, sel.p1, p2, 1));
    await until(await loading(() => fight(mode, sel.p1, p2, sel.stage)));
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
  for (;;) {
    const mode = await until<GameMode>(new TitleScreen(ctx, menuPos));
    menuPos = ['arcade', 'versus', 'training', 'watch'].indexOf(mode);
    await runMode(mode);
  }
}

// ---------------------------------------------------------------------------
// Fixed 60 Hz loop

function stepOnce(): void {
  if (busy) return;
  keys.poll();
  if (script) feedScript();
  if (flowHarness) flowHarness.before(screen);
  screen.tick();
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
      const [f, k, hold] = p.split(':');
      return { from: parseInt(f!, 10), bits: parseKeys(k!), hold: parseInt(hold ?? '2', 10) };
    });
  const mash = params.get('mash')?.split(':');
  const clamp = params
    .get('clamp')
    ?.split(';')
    .filter(Boolean)
    .map((c) => c.split(':').map(Number) as [number, number]);
  const shotEvery = parseInt(params.get('shotevery') ?? '0', 10);
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
      for (const k of fkeys) if (kf >= k.from && kf < k.from + k.hold) bits |= k.bits;
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
      if (s instanceof FightScreen && seedFrom >= 0 && frame >= seedFrom && frame <= seedTo) console.log(`SEED|${frame}|${s.world.seed}|${s.world.players.map((p) => `${p.stateNo}/${p.time} y${p.pos.y.toFixed(2)} vy${p.vel.y.toFixed(3)}`).join(' ')}`);
      if (s instanceof FightScreen) {
        const key = `${s.world.roundState}`;
        if (key !== lastRs) console.log(`DBG|${frame}|rs ${s.world.roundState} seed ${s.world.seed} life ${s.world.players.map((p) => p.life).join(',')}`);
        lastRs = key;
      } else lastRs = '';
      if (name !== lastName) {
        console.log(`FLOW|${frame}|${name}`);
        lastName = name;
        if (shotEvery) shot();
      } else if (shotEvery && frame % shotEvery === 0) shot();
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
  const TICK = 1000 / 60;
  let acc = 0;
  let last = performance.now();
  const frame = (now: number) => {
    acc += Math.min(now - last, 250);
    last = now;
    while (acc >= TICK) {
      stepOnce();
      acc -= TICK;
    }
    if (!busy) screen.draw();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
