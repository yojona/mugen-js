// Character and stage select ([Select Info]).

import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_S, IN_U, IN_X, IN_Y, IN_Z } from '../engine/cmd';
import type { CharacterData } from '../engine/character';
import { drawText, ElementInstance, parseElement } from '../motif/element';
import type { RosterEntry } from '../motif/system';
import type { Pad } from './input';
import { fader, MotifBackground, motifSound, type AppContext, type Screen } from './screen';
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

export interface SelectResult {
  p1: Pick;
  p2?: Pick;
  stage?: string;
  cancelled?: boolean;
}

/** Button -> palette number (default [Palette Keymap]: x y z a b c = 1..6). */
const PAL_BUTTONS: [number, number][] = [
  [IN_X, 1],
  [IN_Y, 2],
  [IN_Z, 3],
  [IN_A, 4],
  [IN_B, 5],
  [IN_C, 6],
];

interface Cursor {
  row: number;
  col: number;
  done: boolean;
  pick?: Pick;
  pad: Pad;
}

const DONE_WAIT = 5;

export class SelectScreen implements Screen {
  result: SelectResult | undefined;
  private bg: MotifBackground;
  private fade;
  private rows: number;
  private cols: number;
  private cursors: Cursor[] = [];
  /** Training and watch: P1's pad picks both sides, one after the other. */
  private get oneDriver(): boolean {
    return this.mode === 'training' || this.mode === 'watch';
  }

  /** Which cursor P1's pad drives in training (it also picks the opponent). */
  private active = 0;
  private stageList: string[];
  private stageIndex = 0;
  private stageDone = false;
  private needStage: boolean;
  private time = 0;

  constructor(
    private ctx: AppContext,
    private mode: GameMode,
    private roster: RosterChar[],
    stages: { path: string; name: string }[],
  ) {
    this.bg = new MotifBackground(ctx, 'select');
    this.fade = fader(ctx, 'Select Info');
    this.rows = this.int('rows', 2);
    this.cols = this.int('columns', 5);
    const start = (k: string) => (this.v(k) ?? '0,0').split(',').map((x) => parseInt(x, 10) || 0);
    const p1s = start('p1.cursor.startcell');
    const p2s = start('p2.cursor.startcell');
    const pads = ctx.keys.pads;
    this.cursors.push({ row: p1s[0]!, col: p1s[1]!, done: false, pad: pads[0]! });
    if (mode !== 'arcade') this.cursors.push({ row: p2s[0]!, col: p2s[1]!, done: false, pad: mode === 'versus' ? pads[1]! : pads[0]! });
    this.stageList = ['random', ...stages.map((s) => s.path)];
    this.stageNames = new Map(stages.map((s) => [s.path, s.name]));
    this.needStage = mode !== 'arcade';
    const sec = ctx.motif.section('Select Info');
    for (const pl of ['p1', 'p2']) {
      for (const st of ['active', 'done']) {
        const d = parseElement(sec, `${pl}.cursor.${st}`);
        if (d) this.cursorEls.set(`${pl}.${st}`, new ElementInstance(d, ctx.motif.assets));
      }
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

  private cellAt(c: Cursor): RosterChar | undefined {
    return this.roster[c.row * this.cols + c.col];
  }

  tick(): void {
    this.time++;
    for (const e of this.cursorEls.values()) e.tick();
    this.bg.tick();
    this.fade.tick();
    if (this.fade.done && this.result === undefined) this.result = this.pending;
    if (this.fade.fadingOut) return;
    if (this.ctx.keys.escape) {
      motifSound(this.ctx, this.v('cancel.snd'));
      this.pending = { p1: this.cursors[0]!.pick!, cancelled: true };
      this.fade.fadeOut();
      return;
    }
    const allChars = this.cursors.every((c) => c.done);
    if (!allChars) {
      const list = this.oneDriver ? [this.cursors[this.active]!] : this.cursors;
      list.forEach((c, i) => this.moveCursor(c, this.oneDriver ? this.active : i));
      return;
    }
    if (this.needStage && !this.stageDone) {
      const pad = this.ctx.keys.pads[0]!;
      const n = this.stageList.length;
      if (pad.pressed(IN_R)) {
        this.stageIndex = (this.stageIndex + 1) % n;
        motifSound(this.ctx, this.v('stage.move.snd'));
      } else if (pad.pressed(IN_L)) {
        this.stageIndex = (this.stageIndex - 1 + n) % n;
        motifSound(this.ctx, this.v('stage.move.snd'));
      } else if (pad.pressed(IN_X | IN_Y | IN_Z | IN_A | IN_B | IN_C | IN_S)) {
        motifSound(this.ctx, this.v('stage.done.snd'));
        this.stageDone = true;
      }
      return;
    }
    // The screen holds a few frames after the last pick before fading out
    // (measured in mugen.exe: the done cursor shows 5 frames).
    if (++this.doneWait <= DONE_WAIT) return;
    if (!this.fade.fadingOut) {
      let stage = this.needStage ? this.stageList[this.stageIndex] : undefined;
      if (stage === 'random') stage = this.stageList[1 + Math.floor(Math.random() * (this.stageList.length - 1))];
      this.pending = { p1: this.cursors[0]!.pick!, p2: this.cursors[1]?.pick, stage };
      this.fade.fadeOut();
    }
  }
  private pending: SelectResult | undefined;
  private doneWait = 0;

  private moveCursor(c: Cursor, index: number): void {
    if (c.done) return;
    const pad = c.pad;
    const pre = `p${index + 1}`;
    const move = (dr: number, dc: number) => {
      c.row = Math.max(0, Math.min(this.rows - 1, c.row + dr));
      c.col = Math.max(0, Math.min(this.cols - 1, c.col + dc));
      motifSound(this.ctx, this.v(`${pre}.cursor.move.snd`));
    };
    if (pad.pressed(IN_U)) move(-1, 0);
    else if (pad.pressed(IN_D)) move(1, 0);
    else if (pad.pressed(IN_L)) move(0, -1);
    else if (pad.pressed(IN_R)) move(0, 1);
    for (const [bit, pal] of PAL_BUTTONS) {
      if (!pad.pressed(bit)) continue;
      let ch = this.cellAt(c);
      if (!ch) return;
      if (ch.entry.def === 'randomselect') {
        const real = this.roster.filter((r) => r.data);
        ch = real[Math.floor(Math.random() * real.length)];
        if (!ch) return;
      }
      if (!ch.data) return;
      c.pick = { char: ch, pal };
      c.done = true;
      motifSound(this.ctx, this.v(`${pre}.cursor.done.snd`));
      if (this.oneDriver && this.active === 0) this.active = 1;
      return;
    }
  }

  draw(): void {
    const r = this.ctx.renderer;
    const [w, h] = this.ctx.motif.localCoord;
    r.setProjection(w, h);
    this.bg.drawBack();
    const motif = this.ctx.motif;
    const sff = motif.sff;
    const spr = (k: string) => {
      const p = this.v(k)?.split(',').map((x) => parseInt(x, 10));
      return p && p.length >= 2 ? sff.get(p[0]!, p[1]!) : undefined;
    };
    const [px, py] = this.pair('pos');
    const [cw, ch] = this.pair('cell.size', [27, 27]);
    const gap = this.int('cell.spacing', 2);
    const cellBg = spr('cell.bg.spr');
    const random = spr('cell.random.spr');
    const portraitSpr = this.pair('portrait.spr', [9000, 0]);
    const portraitOff = this.pair('portrait.offset');
    const portraitScale = this.pair('portrait.scale', [1, 1]);
    const showEmpty = this.int('showemptyboxes', 0) !== 0;
    const cellPos = (row: number, col: number): [number, number] => [px + col * (cw + gap), py + row * (ch + gap)];

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const entry = this.roster[row * this.cols + col];
        if (!entry && !showEmpty) continue;
        const [x, y] = cellPos(row, col);
        if (cellBg) r.draw({ sprite: cellBg, palette: sff.palettes[cellBg.palette], x, y, scaleX: 1, scaleY: 1 });
        if (entry?.entry.def === 'randomselect' && random) r.draw({ sprite: random, palette: sff.palettes[random.palette], x, y, scaleX: 1, scaleY: 1 });
        const d = entry?.data;
        const s = d?.sff.get(portraitSpr[0], portraitSpr[1]);
        const k = d ? this.charScale(d) : 1;
        if (d && s) r.draw({ sprite: s, palette: d.paletteFor(s, 1), x: x + portraitOff[0], y: y + portraitOff[1], scaleX: portraitScale[0] * k, scaleY: portraitScale[1] * k });
      }
    }

    this.cursors.forEach((c, i) => {
      const pre = `p${i + 1}`;
      const blink = i === 1 && this.int('p2.cursor.blink', 0) !== 0 && this.cursors[0]!.row === c.row && this.cursors[0]!.col === c.col && Math.floor(this.time / 8) % 2 === 1;
      const showCursor = !this.oneDriver || i === this.active || c.done;
      const cur = this.cursorEls.get(`${pre}.${c.done ? 'done' : 'active'}`) ?? this.cursorEls.get(`${pre}.active`);
      if (cur && showCursor && !blink) {
        const [x, y] = cellPos(c.row, c.col);
        cur.draw(r, x, y);
      }
      // Big portrait and name of the hovered / chosen character.
      const hovered = c.pick?.char ?? this.cellAt(c);
      const d = hovered?.data;
      if (d && showCursor) {
        const fs = this.pair(`${pre}.face.spr`, [9000, 1]);
        const fo = this.pair(`${pre}.face.offset`);
        const fsc = this.pair(`${pre}.face.scale`, [1, 1]);
        const facing = (parseFloat(this.v(`${pre}.face.facing`) ?? '1') || 1) < 0 ? -1 : 1;
        const s = d.sff.get(fs[0], fs[1]);
        const k = this.charScale(d);
        const win = this.v(`${pre}.face.window`)?.split(',').map(Number);
        if (win && win.length === 4) r.setClip([win[0]!, win[1]!, win[2]! + 1, win[3]! + 1]);
        if (s) r.draw({ sprite: s, palette: d.paletteFor(s, c.pick?.pal ?? 1), x: fo[0], y: fo[1], scaleX: facing * fsc[0] * k, scaleY: fsc[1] * k });
        if (win) r.setClip(undefined);
        const nameEl = parseElement(motif.section('Select Info'), `${pre}.name`);
        if (nameEl?.font) {
          const font = motif.fonts[nameEl.font[0]];
          const [nx, ny] = this.pair(`${pre}.name.offset`);
          if (font) drawText(r, font, d.def.displayName, nx, ny, nameEl.font[1], nameEl.font[2], nameEl.scale, nameEl.fontColor);
        }
      }
    });

    // Screen title.
    const titleEl = parseElement(motif.section('Select Info'), 'title');
    if (titleEl?.font) {
      const font = motif.fonts[titleEl.font[0]];
      const [tx, ty] = this.pair('title.offset');
      const label = this.mode === 'arcade' ? 'Arcade' : this.mode === 'versus' ? 'Versus Mode' : this.mode === 'watch' ? 'Watch Mode' : 'Training Mode';
      if (font) drawText(r, font, label, tx, ty, titleEl.font[1], titleEl.font[2], titleEl.scale, titleEl.fontColor);
    }

    // Stage select.
    if (this.needStage && this.cursors.every((c) => c.done)) {
      const sp = this.stageList[this.stageIndex]!;
      const label = sp === 'random' ? 'Stage: Random' : `Stage ${this.stageIndex}: ${this.stageNames.get(sp) ?? sp}`;
      const key = this.stageDone ? 'stage.done' : Math.floor(this.time / 6) % 2 ? 'stage.active2' : 'stage.active';
      const el = parseElement(motif.section('Select Info'), key) ?? parseElement(motif.section('Select Info'), 'stage.active');
      const [sx, sy] = this.pair('stage.pos');
      if (el?.font) {
        const font = motif.fonts[el.font[0]];
        if (font) drawText(r, font, label, sx, sy, el.font[1], el.font[2], el.scale, el.fontColor);
      }
    }
    this.bg.drawFront();
    this.fade.draw(r, w, h);
  }
}
