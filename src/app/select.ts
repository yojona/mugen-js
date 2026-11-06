// Character and stage select ([Select Info]). The flow is a port of
// Charsel_SetupMode / Charsel_Update (select.c 0x408b20 / 0x406020): every
// side runs a script of steps (team menu, characters, computer team, stage,
// done) and both scripts advance in the same tick.

import type { BgmInfo } from '../audio/music';
import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_S, IN_U, IN_X, IN_Y, IN_Z } from '../engine/cmd';
import type { CharacterData } from '../engine/character';
import { drawText, ElementInstance, parseElement, type ElementDef } from '../motif/element';
import type { RosterEntry } from '../motif/system';
import { BUTTONS, type Pad } from './input';
import { fader, MotifBackground, motifSound, type AppContext, type Screen, motifBgm } from './screen';
import type { GameMode } from './title';

export interface RosterChar {
  entry: RosterEntry;
  /** undefined for randomselect / empty slots. */
  data: CharacterData | undefined;
  defPath: string | undefined;
}

export interface Pick {
  char: RosterChar;
  pal: number;
}

export type TeamMode = 'single' | 'simul' | 'turns';

/** What one side fights with, as chosen on the select screen. */
export interface TeamPick {
  mode: TeamMode;
  /** Characters picked for this side, in order (empty for a computer team chosen only by mode/count). */
  picks: Pick[];
  /** How many characters the side has (simul 2, turns = the menu value, single 1). */
  count: number;
  /**
   * Per pick: picked by a human pad (false) or to be played by the CPU (true).
   * Simul in team arcade: P1 human, partner CPU; team co-op: both human.
   * A computer team without picks has `count` entries, all true.
   */
  ai: boolean[];
}

export interface SelectResult {
  /** First pick of side 1. */
  p1: Pick;
  /** First pick of side 2, when that side was picked by a pad (not in arcade / survival). */
  p2?: Pick;
  stage?: string;
  cancelled?: boolean;
  /** Both teams; filled for every mode that finished. */
  teams?: [TeamPick, TeamPick];
}

/** Charsel_MoveCursor: the buttons in [Palette Keymap] order (the last one pressed in this order wins). */
const PAL_BUTTONS = [IN_A, IN_B, IN_C, IN_X, IN_Y, IN_Z];

// ---- select scripts (Charsel_SetupMode, select.c 0x408b20) ----

type StepType = 'menu' | 'chars' | 'auto' | 'stage' | 'done';
type MenuMode = TeamMode | 'tag';

interface Step {
  type: StepType;
  /** Team filled by the step. */
  team: number;
  mode: TeamMode;
  /** Characters to select. */
  count: number;
  /** Simul with 2: 0 = one player picks both (partner CPU), 1 = the other pad picks the second, 2 = computer. */
  simul: 0 | 1 | 2;
  /** Team menu: 1 single, 2 simul, 4 tag, 8 turns. */
  flags: number;
  /** Team menu: initial item. */
  item: number;
  /** Team menu: side whose layout it uses. */
  player: number;
  /** Team menu: step that receives the choice. */
  target?: Step;
}

interface Script {
  steps: Step[];
  current: number;
  /** The current step was just entered. */
  entered: boolean;
  ticks: number;
}

const MENU_ALL = 0x0b; // single, simul, turns
const MENU_NO_TURNS = 0x03; // single, simul

const step = (type: StepType, o: Partial<Step> = {}): Step => ({
  type,
  team: 0,
  mode: 'single',
  count: 1,
  simul: 0,
  flags: 0,
  item: 0,
  player: 0,
  ...o,
});
const chars = (team: number, mode: TeamMode, count: number, simul: 0 | 1 | 2 = 0) => step('chars', { team, mode, count, simul });
const autoTeam = (team: number, mode: TeamMode, count: number, simul: 0 | 1 | 2 = 0) => step('auto', { team, mode, count, simul });
/** A team menu for `player`; it fills the step that follows it. */
const menu = (player: number, flags: number, item: number): Step => step('menu', { player, flags, item });

/** Builds the scripts of both sides; the game mode is chosen by side 0. */
function buildScripts(mode: GameMode): [Script, Script] {
  const side = 0;
  const other = 1 - side;
  let s0: Step[] = [];
  let s1: Step[] = [];
  const done = () => step('done');
  const stage = () => step('stage');
  switch (mode) {
    case 'arcade':
      s0 = [chars(side, 'single', 1), autoTeam(other, 'single', 1), done()];
      break;
    case 'versus':
      s0 = [chars(0, 'single', 1), stage(), done()];
      s1 = [chars(1, 'single', 1), stage(), done()];
      break;
    case 'teamarcade':
      s0 = [menu(side, MENU_ALL, 1), chars(side, 'simul', 2, 0), menu(other, MENU_ALL, 1), autoTeam(other, 'simul', 2, 2), done()];
      break;
    case 'teamversus':
      s0 = [menu(0, MENU_ALL, 1), chars(0, 'simul', 2, 0), stage(), done()];
      s1 = [menu(1, MENU_ALL, 1), chars(1, 'simul', 2, 0), stage(), done()];
      break;
    case 'teamcoop':
      s0 = [chars(side, 'simul', 2, 1), menu(other, MENU_ALL, 1), autoTeam(other, 'simul', 2, 2), done()];
      break;
    case 'survival':
      s0 = [
        menu(side, MENU_ALL, 0),
        chars(side, 'simul', 2, 0),
        menu(other, MENU_NO_TURNS, 0),
        autoTeam(other, 'simul', 2, 2),
        stage(),
        done(),
      ];
      break;
    case 'survivalcoop':
      s0 = [chars(side, 'simul', 2, 1), menu(other, MENU_NO_TURNS, 0), autoTeam(other, 'simul', 2, 2), stage(), done()];
      break;
    case 'training':
      s0 = [chars(side, 'single', 1), chars(other, 'single', 1), stage(), done()];
      break;
    case 'watch':
      s0 = [menu(side, MENU_ALL, 0), chars(side, 'single', 1), menu(other, MENU_ALL, 0), chars(other, 'single', 1), stage(), done()];
      break;
  }
  for (const steps of [s0, s1]) {
    steps.forEach((st, i) => {
      if (st.type === 'menu') st.target = steps[i + 1];
    });
  }
  const make = (steps: Step[]): Script => ({ steps, current: 0, entered: true, ticks: 0 });
  return [make(s0), make(s1)];
}

// ---- state kept between select screens (g_selectInfo in the decompile) ----

/** Cursor of each team member when last selected, [team][slot] (-1 = none). */
const lastCell: { col: number; row: number }[][] = [[], []];
/** Team menu choice per layout side (teammenu[].saved_item / saved_value). */
const savedMenu: ({ item: number; value: number } | undefined)[] = [undefined, undefined];

/** Forgets the remembered cursors and team menu choices (a new game). */
export function resetSelectMemory(): void {
  lastCell[0] = [];
  lastCell[1] = [];
  savedMenu[0] = savedMenu[1] = undefined;
}

// ---- runtime state ----

interface MenuItem {
  mode: MenuMode;
  name: string;
  value: number;
  min: number;
  max: number;
}

interface TeamMenu {
  active: boolean;
  player: number;
  item: number;
  items: MenuItem[];
}

interface CursorMember {
  side: number;
  ai: boolean;
  startCol: number;
  startRow: number;
}

/** Character cursor of one side's script (CharselCursor). */
interface SideCursor {
  team: number;
  col: number;
  row: number;
  slot: number;
  count: number;
  members: CursorMember[];
}

/** Cursor box drawn on the grid for one slot of one team (CharselBox). */
interface Box {
  col: number;
  row: number;
  /** Drawn position; undefined until first drawn. */
  x?: number;
  y?: number;
  state: 'none' | 'active' | 'done';
  side: number;
  pal: number;
}

interface TeamMenuLayout {
  pos: [number, number];
  bg?: ElementInstance;
  self?: ElementInstance;
  enemy?: ElementInstance;
  cursor?: ElementInstance;
  icon?: ElementInstance;
  emptyIcon?: ElementInstance;
  item?: ElementDef;
  active: (ElementDef | undefined)[];
  offset: [number, number];
  spacing: [number, number];
  valueSpacing: [number, number];
}

const MODE_TITLES: Record<GameMode, string> = {
  arcade: 'Arcade',
  versus: 'Versus Mode',
  teamarcade: 'Team Arcade',
  teamversus: 'Team Versus',
  teamcoop: 'Team Cooperative',
  survival: 'Survival',
  survivalcoop: 'Survival Cooperative',
  training: 'Training Mode',
  watch: 'Watch Mode',
};

const NAV_BITS = [IN_U, IN_D, IN_L, IN_R];
const PRESS_BITS = [...NAV_BITS, IN_X, IN_Y, IN_Z, IN_A, IN_B, IN_C, IN_S];

/** The buttons that went down this tick (one frame of ScreenLoop.input). */
function pressedBits(pad: Pad): number {
  let b = 0;
  for (const bit of PRESS_BITS) if (pad.pressed(bit)) b |= bit;
  return b;
}

export class SelectScreen implements Screen {
  result: SelectResult | undefined;
  bgm: BgmInfo | null;
  private bg: MotifBackground;
  private fade;
  private rows: number;
  private cols: number;
  private scripts: [Script, Script];
  private sideDone = [false, false];
  private cursors: SideCursor[];
  private boxes: Box[][];
  private teams: (TeamPick | undefined)[] = [undefined, undefined];
  private menus: TeamMenu[] = [
    { active: false, player: 0, item: 0, items: [] },
    { active: false, player: 1, item: 0, items: [] },
  ];
  private stageList: string[];
  private stageIndex = 0;
  private stageDone = false;
  private stageShown = false;
  private time = 0;
  private startCells: [number, number][];
  private palFree = new Map<RosterChar, number>();
  private menuLayouts: TeamMenuLayout[] = [];

  constructor(
    private ctx: AppContext,
    private mode: GameMode,
    private roster: RosterChar[],
    stages: { path: string; name: string }[],
  ) {
    this.bgm = motifBgm(ctx, 'select.bgm');
    this.bg = new MotifBackground(ctx, 'select');
    this.fade = fader(ctx, 'Select Info');
    this.rows = this.int('rows', 2);
    this.cols = this.int('columns', 5);
    const start = (k: string) => (this.v(k) ?? '0,0').split(',').map((x) => parseInt(x, 10) || 0);
    const p1s = start('p1.cursor.startcell');
    const p2s = start('p2.cursor.startcell');
    this.startCells = [
      [p1s[0]!, p1s[1]!],
      [p2s[0]!, p2s[1]!],
    ];
    this.scripts = buildScripts(mode);
    this.cursors = [0, 1].map((t) => ({ team: t, col: -1, row: -1, slot: 0, count: 0, members: [] }));
    this.boxes = [0, 1].map(() => Array.from({ length: 4 }, (): Box => ({ col: -1, row: -1, state: 'none', side: 0, pal: 1 })));
    this.stageList = ['random', ...stages.map((s) => s.path)];
    this.stageNames = new Map(stages.map((s) => [s.path, s.name]));
    const sec = ctx.motif.section('Select Info');
    for (const pl of ['p1', 'p2']) {
      for (const st of ['active', 'done']) {
        const d = parseElement(sec, `${pl}.cursor.${st}`);
        if (d) this.cursorEls.set(`${pl}.${st}`, new ElementInstance(d, ctx.motif.assets));
      }
    }
    for (const p of [1, 2]) {
      const el = (prefix: string) => {
        const d = parseElement(sec, `p${p}.teammenu.${prefix}`);
        return d ? new ElementInstance(d, ctx.motif.assets) : undefined;
      };
      this.menuLayouts.push({
        pos: this.pair(`p${p}.teammenu.pos`),
        bg: el('bg'),
        self: el('selftitle'),
        enemy: el('enemytitle'),
        cursor: el('item.cursor'),
        icon: el('value.icon'),
        emptyIcon: el('value.empty.icon'),
        item: parseElement(sec, `p${p}.teammenu.item`),
        active: [parseElement(sec, `p${p}.teammenu.item.active`), parseElement(sec, `p${p}.teammenu.item.active2`)],
        offset: this.pair(`p${p}.teammenu.item.offset`),
        spacing: this.pair(`p${p}.teammenu.item.spacing`),
        valueSpacing: this.pair(`p${p}.teammenu.value.spacing`),
      });
    }
  }
  private cursorEls = new Map<string, ElementInstance>();

  /** Character sprites are authored in the character's coordinate space. */
  private charScale(d: CharacterData): number {
    return this.ctx.motif.localCoord[0] / (d.def.localCoord[0] || 320);
  }
  private stageNames: Map<string, string>;

  private v(k: string): string | undefined {
    return this.ctx.motif.value('Select Info', k);
  }
  private int(k: string, d: number): number {
    const n = parseInt(this.v(k) ?? '', 10);
    return Number.isFinite(n) ? n : d;
  }
  private pair(k: string, d: [number, number] = [0, 0]): [number, number] {
    const p = (this.v(k) ?? '').split(',').map((x) => parseFloat(x));
    return [Number.isFinite(p[0]) ? p[0]! : d[0], Number.isFinite(p[1]) ? p[1]! : d[1]];
  }

  private cellAtPos(row: number, col: number): RosterChar | undefined {
    return this.roster[row * this.cols + col];
  }

  tick(): void {
    this.time++;
    for (const e of this.cursorEls.values()) e.tick();
    for (const l of this.menuLayouts) for (const e of [l.bg, l.self, l.enemy, l.cursor, l.icon, l.emptyIcon]) e?.tick();
    this.bg.tick();
    this.fade.tick();
    if (this.fade.done && this.result === undefined) this.result = this.pending;
    if (this.fade.fadingOut) return;
    if (this.ctx.keys.escape) {
      motifSound(this.ctx, this.v('cancel.snd'));
      this.pending = { p1: this.teams[0]?.picks[0]!, cancelled: true };
      this.fade.fadeOut();
      return;
    }
    this.runScripts();
    this.updateBoxes();
    // Charsel_Update / Charsel_Tick: with both sides done, phase 1; phase
    // 2 once the cell flashes are over (Tick, the same frame); the fade out
    // starts on the next Update in phase 2.
    let fade = false;
    if (this.sideDone[0] && this.sideDone[1] && this.phase !== 1) {
      if (this.phase === 2) fade = true;
      else this.phase = 1;
    }
    for (const k of [0, 1]) if (this.flashTicks[k]! > 0) this.flashTicks[k]!--;
    if (this.phase === 1 && this.flashTicks[0]! <= 0 && this.flashTicks[1]! <= 0) this.phase = 2;
    if (!fade) return;
    let stage = this.stageShown ? this.stageList[this.stageIndex] : undefined;
    // "random" is drawn later from the session RNG (Gameflow_PickStage).
    const t0 = this.teams[0]!;
    const t1 = this.teams[1]!;
    this.pending = { p1: t0.picks[0]!, p2: t1.picks[0], stage, teams: [t0, t1] };
    this.fade.fadeOut();
  }
  private pending: SelectResult | undefined;
  /** Charsel phase: 0 picking, 1 both sides done, 2 flashes over. */
  private phase = 0;
  /** Charsel_FlashCell: the two cell flashes' ticks left (length 4 + 1). */
  private flashTicks = [0, 0];

  // ---- script runner (Charsel_Update) ----

  private runScripts(): void {
    const pads = this.ctx.keys.pads;
    // One frame of input per pad; a step that advances consumes it so the
    // button does not also act in the next step.
    const input = [pressedBits(pads[0]!), pressedBits(pads[1]!)];
    for (let side = 0; side < 2; side++) {
      const sc = this.scripts[side]!;
      for (;;) {
        if (sc.current >= sc.steps.length) {
          this.sideDone[side] = true;
          break;
        }
        const entered = sc.entered;
        const st = sc.steps[sc.current]!;
        sc.entered = false;
        let consumed = side;
        let advanced = false;
        switch (st.type) {
          case 'done':
            advanced = true;
            break;
          case 'menu':
            advanced = this.runMenu(side, st, entered, input[side]!);
            break;
          case 'chars': {
            const r = this.runChars(side, st, entered, input);
            advanced = r.advanced;
            consumed = r.pad;
            break;
          }
          case 'auto': {
            this.teams[st.team] = { mode: st.mode, picks: [], count: st.count, ai: Array<boolean>(st.count).fill(true) };
            advanced = true;
            break;
          }
          case 'stage':
            advanced = this.runStage(st, entered, input[side]!);
            break;
        }
        if (!advanced) break;
        sc.current++;
        sc.entered = true;
        sc.ticks = 0;
        input[consumed] = 0;
      }
      sc.ticks++;
    }
  }

  // ---- team menu (TeamMenu_Init select.c 0x40ad80, TeamMenu_Move 0x409430) ----

  private menuInit(side: number, st: Step): void {
    const m = this.menus[side]!;
    m.active = true;
    m.player = st.player;
    m.item = st.item;
    m.items = [];
    if (st.flags & 1) m.items.push({ mode: 'single', name: 'Single', value: -1, min: 0, max: -1 });
    if (st.flags & 2) m.items.push({ mode: 'simul', name: 'Simul', value: 2, min: 2, max: 2 });
    if (st.flags & 4) m.items.push({ mode: 'tag', name: 'Tag', value: 2, min: 2, max: 2 });
    if (st.flags & 8) m.items.push({ mode: 'turns', name: 'Turns', value: 2, min: 2, max: 4 });
    const saved = savedMenu[m.player];
    if (saved && saved.item < m.items.length) {
      m.item = saved.item;
      m.items[saved.item]!.value = saved.value;
    }
  }

  private runMenu(side: number, st: Step, entered: boolean, bits: number): boolean {
    if (entered) this.menuInit(side, st);
    const m = this.menus[side]!;
    const lay = `p${m.player + 1}.teammenu`;
    const oldItem = m.item;
    const oldValue = m.items[oldItem]!.value;
    // Player 2's menu has left and right swapped.
    const inc = m.player === 0 ? IN_R : IN_L;
    const dec = m.player === 0 ? IN_L : IN_R;
    const wrap = this.int('teammenu.move.wrapping', 0) !== 0;
    const n = m.items.length;
    if (bits & IN_U) {
      m.item--;
      if (m.item < 0) m.item = wrap ? n - 1 : 0;
    }
    if (bits & IN_D) {
      m.item++;
      if (m.item >= n) m.item = wrap ? 0 : n - 1;
    }
    const it = m.items[m.item]!;
    if (it.max > it.min) {
      if (bits & inc && it.value < it.max) it.value++;
      if (bits & dec && it.value > it.min) it.value--;
    }
    if (oldItem !== m.item) motifSound(this.ctx, this.v(`${lay}.move.snd`));
    else if (oldValue !== it.value) motifSound(this.ctx, this.v(`${lay}.value.snd`));
    if (!(bits & (BUTTONS | IN_S))) return false;
    motifSound(this.ctx, this.v(`${lay}.done.snd`));
    const target = st.target!;
    switch (it.mode) {
      case 'single':
        target.mode = 'single';
        target.count = 1;
        break;
      case 'simul':
        target.mode = 'simul';
        target.simul = 0;
        target.count = 2;
        break;
      case 'tag':
        throw new Error('Not yet implemented');
      case 'turns':
        target.mode = 'turns';
        target.count = it.value;
        break;
    }
    savedMenu[m.player] = { item: m.item, value: it.value };
    m.active = false;
    return true;
  }

  // ---- characters (Charsel_StartChars 0x40ab70, Charsel_MoveCursor 0x4090e0) ----

  private startChars(side: number, st: Step): void {
    const cur = this.cursors[side]!;
    cur.team = st.team;
    cur.slot = 0;
    cur.count = st.count;
    // Watch: every character is played by the computer.
    const watch = this.mode === 'watch';
    cur.members = Array.from({ length: st.count }, () => ({ side: st.team, ai: watch, startCol: -1, startRow: -1 }));
    for (let k = 0; k < 4 && k < cur.members.length; k++) {
      const last = lastCell[st.team]![k];
      if (last) {
        cur.members[k]!.startCol = last.col;
        cur.members[k]!.startRow = last.row;
      }
    }
    cur.col = cur.members[0]!.startCol;
    if (cur.col === -1) cur.col = this.startCells[st.team]![1];
    cur.row = cur.members[0]!.startRow;
    if (cur.row === -1) cur.row = this.startCells[st.team]![0];
    if (st.mode === 'simul' && st.count === 2) {
      if (st.simul === 0 || st.simul === 2) cur.members[1]!.ai = true;
      if (st.simul === 2) cur.members[0]!.ai = true;
      if (st.simul === 1) cur.members[1]!.side = 1 - cur.members[1]!.side;
    }
    this.teams[st.team] = { mode: st.mode, picks: [], count: st.count, ai: [] };
  }

  private runChars(side: number, st: Step, entered: boolean, input: number[]): { advanced: boolean; pad: number } {
    if (entered) this.startChars(side, st);
    const cur = this.cursors[side]!;
    // Team co-op: the second character is picked by the other player's pad.
    const swap = st.mode === 'simul' && st.count === 2 && cur.slot === 1 && st.simul === 1;
    const padIndex = swap ? 1 - side : side;
    const bits = input[padIndex]!;
    const old = [cur.row, cur.col];
    this.moveCursor(cur, bits);
    if (old[0] !== cur.row || old[1] !== cur.col) motifSound(this.ctx, this.v(`p${side + 1}.cursor.move.snd`));
    const box = this.boxes[cur.team]![cur.slot]!;
    box.col = cur.col;
    box.row = cur.row;
    box.state = 'active';
    box.side = swap ? 1 - side : side;
    const stay = { advanced: false, pad: padIndex };
    let button = -1;
    PAL_BUTTONS.forEach((bit, k) => {
      if (bits & bit) button = k;
    });
    if (button < 0) return stay;
    // Start held: palettes 7..12 of the keymap.
    if ((this.ctx.keys.pads[padIndex]?.bits ?? 0) & IN_S) button += 6;
    let ch = this.cellAtPos(cur.row, cur.col);
    if (!ch) return stay;
    if (ch.entry.def === 'randomselect') {
      const real = this.roster.filter((r) => r.data);
      ch = real[Math.floor(Math.random() * real.length)];
      if (!ch) return stay;
    }
    if (!ch.data) return stay;
    motifSound(this.ctx, this.v(`p${side + 1}.cursor.done.snd`));
    const pal = this.reservePal(ch, ch.data.def.palKeymap[button]! - 1) + 1;
    box.state = 'done';
    box.pal = pal;
    // Charsel_FlashCell: the flash slot that is further along.
    const fk = this.flashTicks[1]! < Math.min(999, this.flashTicks[0]!) ? 1 : 0;
    this.flashTicks[fk] = 5;
    const team = this.teams[cur.team]!;
    team.picks.push({ char: ch, pal });
    team.ai.push(cur.members[cur.slot]!.ai);
    lastCell[cur.team]![cur.slot] = { col: cur.col, row: cur.row };
    cur.slot++;
    const next = cur.members[cur.slot];
    if (next) {
      if (next.startCol !== -1) cur.col = next.startCol;
      if (next.startRow !== -1) cur.row = next.startRow;
    }
    return { advanced: cur.slot >= cur.count, pad: padIndex };
  }

  /**
   * PalReserve_Request (select.c 0x40aea0): two copies of a character never
   * get the same palette. pal is 0-based; returns the palette reserved.
   */
  private reservePal(ch: RosterChar, pal: number): number {
    let free = this.palFree.get(ch);
    if (free === undefined) free = ch.data?.def.palMask ?? 0;
    // No palette information: keep the palette that was asked for.
    if (free === 0) return pal;
    const bit = (n: number) => 1 << n;
    const take = (p: number) => {
      this.palFree.set(ch, free! & ~bit(p));
      return p;
    };
    if (!(free & bit(pal)) && pal >= 6) pal -= 6;
    if (free & bit(pal) && pal < 12) return take(pal);
    let tries = 0;
    do {
      pal++;
      if (pal >= 6) pal = 0;
      tries++;
      if (free & bit(pal)) {
        if (tries < 6) return take(pal);
        break;
      }
    } while (tries < 6);
    do {
      pal++;
      if (pal >= 12) pal = 6;
      tries++;
      if (free & bit(pal)) return take(tries >= 12 ? 0 : pal);
    } while (tries < 12);
    return take(0);
  }

  private moveCursor(c: { row: number; col: number }, bits: number): void {
    // Charsel_MoveCursor (select.c 0x4090e0): left, right, up, down in that
    // order; empty cells are skipped unless moveoveremptyboxes, and the
    // cursor wraps only with wrapping (else it stops at the last filled cell).
    const wrapping = this.int('wrapping', 0) !== 0;
    const overEmpty = this.int('moveoveremptyboxes', 0) !== 0;
    const empty = (row: number, col: number) => {
      const e = this.roster[row * this.cols + col];
      return !e || (!e.data && e.entry.def !== 'randomselect');
    };
    const step = (v: number, n: number, d: number, isEmpty: (v: number) => boolean): number => {
      let last = v;
      for (let tries = n; ;) {
        if (!isEmpty(v)) last = v;
        v += d;
        if (v < 0 || v >= n) {
          if (!wrapping) return last;
          v = v < 0 ? n - 1 : 0;
        }
        if (!isEmpty(v) || overEmpty || --tries === 0) return v;
      }
    };
    if (bits & IN_L) c.col = step(c.col, this.cols, -1, (v) => empty(c.row, v));
    if (bits & IN_R) c.col = step(c.col, this.cols, 1, (v) => empty(c.row, v));
    if (bits & IN_U) c.row = step(c.row, this.rows, -1, (v) => empty(v, c.col));
    if (bits & IN_D) c.row = step(c.row, this.rows, 1, (v) => empty(v, c.col));
  }

  // ---- stage (StageSelect_Move select.c 0x4093c0) ----

  private runStage(st: Step, entered: boolean, bits: number): boolean {
    void st;
    if (entered) this.stageShown = true;
    if (this.stageDone) return true;
    // The list holds random first; the decompile's stage is index - 1 (-1 = random).
    const count = this.stageList.length - 1;
    let s = this.stageIndex - 1;
    const old = s;
    if (bits & IN_L) {
      s--;
      if (s < -1) s = count - 1;
    }
    if (bits & IN_U) {
      s -= 10;
      if (s < -1) s = -1;
    }
    if (bits & IN_R) {
      s++;
      if (s >= count) s = -1;
    }
    if (bits & IN_D) {
      s += 10;
      if (s >= count) s = count - 1;
    }
    this.stageIndex = s + 1;
    if (old !== s) motifSound(this.ctx, this.v('stage.move.snd'));
    if (!(bits & (BUTTONS | IN_S))) return false;
    motifSound(this.ctx, this.v('stage.done.snd'));
    this.stageDone = true;
    return true;
  }

  // ---- cursor boxes (Charsel_Draw, select.c 0x406e10: they glide towards their cell) ----

  private cellPos(row: number, col: number): [number, number] {
    const [px, py] = this.pair('pos');
    const [cw, ch] = this.pair('cell.size', [27, 27]);
    const gap = this.int('cell.spacing', 2);
    return [px + col * (cw + gap), py + row * (ch + gap)];
  }

  private updateBoxes(): void {
    for (const team of this.boxes) {
      for (const b of team) {
        if (b.col === -1 || b.row === -1) continue;
        const [tx, ty] = this.cellPos(b.row, b.col);
        if (b.state === 'done' || b.x === undefined || b.y === undefined) {
          b.x = tx;
          b.y = ty;
          continue;
        }
        b.x = tx * 0.5 + b.x * 0.5;
        if (Math.abs(b.x - tx) < 1) b.x = tx;
        b.y = ty * 0.5 + b.y * 0.5;
        if (Math.abs(b.y - ty) < 1) b.y = ty;
      }
    }
  }

  draw(): void {
    const r = this.ctx.renderer;
    const [w, h] = this.ctx.motif.localCoord;
    r.setProjection(w, h);
    this.bg.drawBack();
    const motif = this.ctx.motif;
    const sff = motif.sff;
    const sec = motif.section('Select Info');
    const spr = (k: string) => {
      const p = this.v(k)
        ?.split(',')
        .map((x) => parseInt(x, 10));
      return p && p.length >= 2 ? sff.get(p[0]!, p[1]!) : undefined;
    };
    const cellBg = spr('cell.bg.spr');
    const random = spr('cell.random.spr');
    const bgScale = this.pair('cell.bg.scale', [1, 1]);
    const rndScale = this.pair('cell.random.scale', [1, 1]);
    const portraitSpr = this.pair('portrait.spr', [9000, 0]);
    const portraitOff = this.pair('portrait.offset');
    const portraitScale = this.pair('portrait.scale', [1, 1]);
    const showEmpty = this.int('showemptyboxes', 0) !== 0;

    // Big portraits of the character under each team's last cursor.
    this.boxes.forEach((team, t) => {
      let active = -1;
      team.forEach((b, s) => {
        if (b.col !== -1 && b.row !== -1 && b.state !== 'none') active = s;
      });
      if (active < 0) return;
      const b = team[active]!;
      const d = this.cellAtPos(b.row, b.col)?.data;
      if (!d) return;
      const pre = `p${t + 1}`;
      const fs = this.pair(`${pre}.face.spr`, [9000, 1]);
      const fo = this.pair(`${pre}.face.offset`);
      const fsc = this.pair(`${pre}.face.scale`, [1, 1]);
      const facing = (parseFloat(this.v(`${pre}.face.facing`) ?? '1') || 1) < 0 ? -1 : 1;
      const s = d.sff.get(fs[0], fs[1]);
      const k = this.charScale(d);
      const win = this.v(`${pre}.face.window`)?.split(',').map(Number);
      if (win && win.length === 4) r.setClip([win[0]!, win[1]!, win[2]! + 1, win[3]! + 1]);
      if (s)
        r.draw({
          sprite: s,
          palette: d.paletteFor(s, b.state === 'done' ? b.pal : 1),
          x: fo[0],
          y: fo[1],
          scaleX: facing * fsc[0] * k,
          scaleY: fsc[1] * k,
        });
      if (win) r.setClip(undefined);
    });

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const entry = this.roster[row * this.cols + col];
        if (!entry && !showEmpty) continue;
        const [x, y] = this.cellPos(row, col);
        if (cellBg) r.draw({ sprite: cellBg, palette: sff.palettes[cellBg.palette], x, y, scaleX: bgScale[0], scaleY: bgScale[1] });
        if (entry?.entry.def === 'randomselect' && random)
          r.draw({ sprite: random, palette: sff.palettes[random.palette], x, y, scaleX: rndScale[0], scaleY: rndScale[1] });
        const d = entry?.data;
        const s = d?.sff.get(portraitSpr[0], portraitSpr[1]);
        const k = d ? this.charScale(d) : 1;
        if (d && s)
          r.draw({
            sprite: s,
            palette: d.paletteFor(s, 1),
            x: x + portraitOff[0],
            y: y + portraitOff[1],
            scaleX: portraitScale[0] * k,
            scaleY: portraitScale[1] * k,
          });
      }
    }

    // Cursors: done ones first, then active ones (blinking when both share a cell).
    const done: Box[] = [];
    const active: Box[] = [];
    for (const team of this.boxes) {
      for (const b of team) {
        if (b.col === -1 || b.row === -1) continue;
        (b.state === 'done' ? done : active).push(b);
      }
    }
    const drawBox = (b: Box, state: 'active' | 'done') => {
      const el = this.cursorEls.get(`p${b.side + 1}.${state}`) ?? this.cursorEls.get(`p${b.side + 1}.active`);
      if (el && b.x !== undefined && b.y !== undefined) el.draw(r, Math.trunc(b.x), Math.trunc(b.y));
    };
    for (const b of done) drawBox(b, 'done');
    const blink =
      active.length === 2 && this.int('p2.cursor.blink', 0) !== 0 && active[0]!.col === active[1]!.col && active[0]!.row === active[1]!.row;
    active.forEach((b, s) => {
      if (blink && (this.time & 7) < 4 !== (s === 1)) return;
      drawBox(b, 'active');
    });

    // Names of the cells under each team's cursors, one line per member.
    this.boxes.forEach((team, t) => {
      const pre = `p${t + 1}`;
      const nameEl = parseElement(sec, `${pre}.name`);
      const font = nameEl?.font ? motif.fonts[nameEl.font[0]] : undefined;
      if (!nameEl?.font || !font) return;
      const [nx, ny] = this.pair(`${pre}.name.offset`);
      const [sx, sy] = this.pair(`${pre}.name.spacing`, [0, 14]);
      let x = nx;
      let y = ny;
      for (const b of team) {
        if (b.col === -1 || b.row === -1) continue;
        const cell = this.cellAtPos(b.row, b.col);
        const name = cell?.data ? cell.data.def.displayName : cell?.entry.def === 'randomselect' ? 'Random' : undefined;
        if (name === undefined) continue;
        drawText(r, font, name, x, y, nameEl.font[1], nameEl.font[2], nameEl.scale, nameEl.fontColor);
        x += sx;
        y += sy;
      }
    });

    // Stage select.
    if (this.stageShown) {
      const sp = this.stageList[this.stageIndex]!;
      const label = sp === 'random' ? 'Stage: Random' : `Stage ${this.stageIndex}: ${this.stageNames.get(sp) ?? sp}`;
      // Charsel_Draw: the active fonts alternate every 2 ticks.
      const key = this.stageDone ? 'stage.done' : Math.floor(this.time / 2) & 1 ? 'stage.active2' : 'stage.active';
      const el = parseElement(sec, key) ?? parseElement(sec, 'stage.active');
      const [sx, sy] = this.pair('stage.pos');
      if (el?.font) {
        const font = motif.fonts[el.font[0]];
        if (font) drawText(r, font, label, sx, sy, el.font[1], el.font[2], el.scale, el.fontColor);
      }
    }

    this.drawTeamMenus();

    // Screen title.
    const titleEl = parseElement(sec, 'title');
    if (titleEl?.font) {
      const font = motif.fonts[titleEl.font[0]];
      const [tx, ty] = this.pair('title.offset');
      if (font) drawText(r, font, MODE_TITLES[this.mode], tx, ty, titleEl.font[1], titleEl.font[2], titleEl.scale, titleEl.fontColor);
    }
    this.bg.drawFront();
    this.fade.draw(r, w, h);
  }

  private drawTeamMenus(): void {
    const r = this.ctx.renderer;
    const fonts = this.ctx.motif.fonts;
    this.menus.forEach((m, t) => {
      if (!m.active) return;
      const lay = this.menuLayouts[m.player]!;
      let [x, y] = lay.pos;
      lay.bg?.draw(r, x, y);
      (t === m.player ? lay.self : lay.enemy)?.draw(r, x, y);
      x += lay.offset[0];
      y += lay.offset[1];
      m.items.forEach((it, i) => {
        const text = (d: ElementDef | undefined) => {
          const font = d?.font ? fonts[d.font[0]] : undefined;
          if (d?.font && font) drawText(r, font, it.name, x, y, d.font[1], d.font[2], d.scale, d.fontColor);
        };
        if (i === m.item) {
          lay.cursor?.draw(r, x, y);
          text(lay.active[Math.floor(this.time / 2) & 1]);
        } else {
          text(lay.item);
        }
        if (it.min <= it.max) {
          let ix = x;
          let iy = y;
          for (let k = 0; k < it.max; k++) {
            (k < it.value ? lay.icon : lay.emptyIcon)?.draw(r, ix, iy);
            ix += lay.valueSpacing[0];
            iy += lay.valueSpacing[1];
          }
        }
        x += lay.spacing[0];
        y += lay.spacing[1];
      });
    });
  }
}
