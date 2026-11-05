// fight.def: life/power bars, faces, names, round clock, combo counter,
// round announcements and win icons.

import { parseAir, type AnimationMap } from '../formats/air';
import { parseSff, type Sff } from '../formats/sff';
import { parseSnd, type Snd } from '../formats/snd';
import { findSection, getValue, parseIni, splitCsv, type IniDoc, type Section } from '../formats/text';
import { DEFAULT_ROUND, type Match, type RoundConfig } from '../engine/match';
import type { Player } from '../engine/player';
import { dirname, type Vfs } from '../engine/vfs';
import type { Renderer } from '../render/renderer';
import { ElementInstance, parseElement, drawText, type ElementAssets } from './element';
import { loadFont, textWidth, type Font } from './font';

const pair = (v: string | undefined, d: [number, number] = [0, 0]): [number, number] => {
  if (v === undefined) return d;
  const p = splitCsv(v).map((x) => parseFloat(x));
  return [Number.isFinite(p[0]) ? p[0]! : d[0], Number.isFinite(p[1]) ? p[1]! : d[1]];
};

interface Bar {
  pos: [number, number];
  bg0?: ElementInstance;
  bg1?: ElementInstance;
  mid?: ElementInstance;
  front?: ElementInstance;
  range: [number, number];
  counter?: ElementInstance;
}

/** [WinIcon] key of each WIN_ICON_* type. */
const WIN_ICON_KEYS = ['n', 's', 'h', 'c', 't', 'throw', 'suicide', 'teammate', 'perfect'];

export class FightHud {
  private assets: ElementAssets;
  /** Life bars of [Lifebar], [Simul Lifebar] and [Turns Lifebar], p1..p4 each. */
  private lifeSets: Record<'single' | 'simul' | 'turns', Bar[]>;
  private power: Bar[];
  /** Lifebar "mid" (recent damage) value per player slot, drains toward life. */
  private midLife = [1, 1, 1, 1];
  private midDelay = [0, 0, 0, 0];
  private lastLife = [1, 1, 1, 1];
  /** ComboState per side (round.c Combo_*): hits, display timer, x slid in from start.x, count shown. */
  private combo = [0, 1].map(() => ({ hits: 0, timer: 0, x: 0, shown: 0, ongoing: false, pending: false }));
  private round: Map<string, ElementInstance> = new Map();

  private constructor(
    private doc: IniDoc,
    readonly sff: Sff,
    readonly snd: Snd | undefined,
    anims: AnimationMap,
    fonts: (Font | undefined)[],
  ) {
    this.assets = { sff, anims, fonts };
    const bars = (name: string) => [0, 1, 2, 3].map((i) => this.bar(findSection(doc, name), `p${i + 1}`));
    this.lifeSets = { single: bars('Lifebar'), simul: bars('Simul Lifebar'), turns: bars('Turns Lifebar') };
    this.power = [0, 1].map((i) => this.bar(findSection(doc, 'Powerbar'), `p${i + 1}`));
    const rs = findSection(doc, 'Round');
    for (const k of ['round.default', 'fight', 'ko', 'dko', 'to', 'win', 'draw']) {
      const d = parseElement(rs, k);
      if (d) this.round.set(k, new ElementInstance(d, this.assets));
    }
  }

  /** Width of the HUD coordinate space (the motif's localcoord). */
  localWidth = 320;

  static async load(vfs: Vfs, defPath = 'data/fight.def', localWidth = 320): Promise<FightHud> {
    const text = await vfs.text(defPath);
    const doc = parseIni(text);
    const dir = dirname(defPath);
    const files = findSection(doc, 'Files');
    const sff = await parseSff(await vfs.read(getValue(files, 'sff') ?? 'fight.sff', dir, 'data'));
    const sndFile = getValue(files, 'snd');
    const snd = sndFile ? parseSnd(await vfs.read(sndFile, dir, 'data')) : undefined;
    const fonts: (Font | undefined)[] = [];
    for (let i = 0; i <= 9; i++) {
      const f = getValue(files, `font${i}`);
      if (f) fonts[i] = await loadFont(vfs, f, dir).catch(() => undefined);
    }
    const hud = new FightHud(doc, sff, snd, parseAir(text), fonts);
    hud.localWidth = localWidth;
    return hud;
  }

  /** [Round] timings for the Match. */
  roundConfig(): RoundConfig {
    const r = findSection(this.doc, 'Round');
    const t = findSection(this.doc, 'Time');
    const n = (k: string, d: number) => {
      const v = parseFloat(getValue(r, k) ?? '');
      return Number.isFinite(v) ? v : d;
    };
    const D = DEFAULT_ROUND;
    return {
      ...D,
      matchWins: n('match.wins', D.matchWins),
      maxDrawGames: n('match.maxdrawgames', D.maxDrawGames),
      startWaitTime: n('start.waittime', D.startWaitTime),
      roundTime: n('round.time', D.roundTime),
      roundDisplayTime: n('round.default.displaytime', D.roundDisplayTime),
      introTime: n('intro.time', D.introTime),
      roundSndTime: n('round.sndtime', D.roundSndTime),
      fightTime: n('fight.time', D.fightTime),
      fightSndTime: n('fight.sndtime', D.fightSndTime),
      ctrlTime: n('ctrl.time', D.ctrlTime),
      koTime: n('ko.time', D.koTime),
      koSndTime: n('ko.sndtime', D.koSndTime),
      slowTime: n('slow.time', D.slowTime),
      overWaitTime: n('over.waittime', D.overWaitTime),
      overHitTime: n('over.hittime', D.overHitTime),
      overWinTime: n('over.wintime', D.overWinTime),
      overTime: n('over.time', D.overTime),
      winTime: n('win.time', D.winTime),
      framesPerCount: parseFloat(getValue(t, 'framespercount') ?? '') || D.framesPerCount,
    };
  }

  private bar(sec: Section | undefined, p: string): Bar {
    const el = (k: string) => {
      const d = parseElement(sec, `${p}.${k}`);
      return d ? new ElementInstance(d, this.assets) : undefined;
    };
    return {
      pos: pair(getValue(sec, `${p}.pos`)),
      bg0: el('bg0'),
      bg1: el('bg1'),
      mid: el('mid'),
      front: el('front'),
      range: pair(getValue(sec, `${p}.range.x`)),
      counter: el('counter'),
    };
  }

  /** `simulated`: the match ran a game tick this frame (no Combo_Tick in the KO slow motion's skipped frames). */
  tick(m: Match, simulated = true): void {
    for (const b of [...Object.values(this.lifeSets).flat(), ...this.power]) for (const e of [b.bg0, b.bg1, b.mid, b.front]) e?.tick();
    for (const e of this.round.values()) e.tick();
    // A new announcement starts its element over this tick (whether or not
    // the frame gets drawn: several ticks can run per drawn frame).
    const a = m.announce;
    if (a && a.age === 0) this.round.get(this.announceKey(a))?.reset();
    for (const p of m.players) {
      const i = p.slotNo - 1;
      if (i < 0 || i > 3) continue;
      const frac = Math.max(0, p.life / p.lifeMax);
      // The red "mid" bar waits while the player is in hitstun, then drains.
      if (frac < this.lastLife[i]!) this.midDelay[i] = 30;
      this.lastLife[i] = frac;
      if (this.midDelay[i]! > 0 && p.moveType !== 'h') this.midDelay[i]!--;
      if (this.midDelay[i] === 0 && this.midLife[i]! > frac) this.midLife[i] = Math.max(frac, this.midLife[i]! - 0.01);
      if (this.midLife[i]! < frac) this.midLife[i] = frac;
    }
    const comboSec = findSection(this.doc, 'Combo');
    const unit = this.localWidth / 320;
    for (let side = 0; side < 2; side++) {
      const c = this.combo[side]!;
      const pre = `team${side + 1}`;
      const startX = parseFloat(getValue(comboSec, `${pre}.start.x`) ?? '0') || 0;
      const posX = pair(getValue(comboSec, `${pre}.pos`))[0];
      const displayTime = parseInt(getValue(comboSec, `${pre}.displaytime`) ?? '90', 10);
      // Combo_Tick of the previous frame (gameloop runs it after drawing,
      // not in the KO slow motion), with that frame's ongoing flag.
      if (c.pending) {
        c.pending = false;
        if (!c.ongoing) c.hits = 0;
        if (c.timer > 0) {
          if (c.x !== posX) {
            const dir = c.x < posX ? 1 : -1;
            c.x = Math.trunc((posX - c.x) / 8) + c.x + dir;
            if ((posX - c.x) * dir < 0) c.x = posX;
          }
          c.timer--;
        }
        if (c.hits < 2 && c.timer === 0 && c.x !== startX) {
          const dir = c.x < startX ? 1 : -1;
          c.x = Math.trunc(3 * unit * dir + c.x);
          if ((startX - c.x) * dir <= 0) {
            c.x = startX;
            c.shown = 0;
          }
        }
      }
      // Combo_AddHits for this tick's hits.
      const add = m.world.comboAdded[side] ?? 0;
      if (add > 0) {
        c.hits += add;
        if (c.timer === 0 && c.hits >= 2) c.x = startX;
        if (c.hits >= 2) {
          c.timer = displayTime;
          c.shown = Math.min(999, c.hits);
        }
      }
      c.ongoing = m.world.comboOngoing[side] ?? false;
      c.pending = simulated;
    }
  }

  /**
   * Mt_SideBars / Faces / Names: a side with a P3 / P4 uses the simul
   * sections (its slots side and side + 2), a team of several members the
   * turns ones, else the single ones.
   */
  private sideKind(m: Match, side: number): 'single' | 'simul' | 'turns' {
    if (m.world.slot(3 + side)) return 'simul';
    return m.teamView(side).memberCount >= 2 ? 'turns' : 'single';
  }

  private sideSlots(m: Match, side: number): number[] {
    return this.sideKind(m, side) === 'simul' ? [side, side + 2] : [side];
  }

  /** bars false: no Fight_DrawHud (demo fights with [Demo Mode] fight.bars.display = 0), only combos and announcements. */
  draw(r: Renderer, m: Match, bars = true): void {
    const w = m.world;
    for (let side = 0; side < 2; side++) {
      if (!bars) {
        this.drawCombo(r, side);
        continue;
      }
      const kind = this.sideKind(m, side);
      for (const i of this.sideSlots(m, side)) {
        const p = w.slot(i + 1);
        if (p) this.drawBar(r, this.lifeSets[kind][i]!, Math.max(0, p.life / p.lifeMax), this.midLife[i]!);
      }
      const leader = w.slot(side + 1);
      if (leader) {
        const pb = this.power[side]!;
        this.drawBar(r, pb, Math.max(0, leader.power / leader.const('data.power')), undefined);
        pb.counter?.draw(r, pb.pos[0], pb.pos[1], String(Math.floor(leader.power / 1000)));
      }
      const faceSec = findSection(this.doc, { single: 'Face', simul: 'Simul Face', turns: 'Turns Face' }[kind]);
      if (kind === 'turns') this.drawTeammates(r, m, side, faceSec);
      // Faces: the last slot first.
      for (const i of [...this.sideSlots(m, side)].reverse()) {
        const p = w.slot(i + 1);
        if (p) this.drawFace(r, faceSec, `p${i + 1}`, p.prog.data, p.palNo);
      }
      const nameSec = findSection(this.doc, { single: 'Name', simul: 'Simul Name', turns: 'Turns Name' }[kind]);
      for (const i of this.sideSlots(m, side)) {
        const p = w.slot(i + 1);
        if (p) this.drawName(r, nameSec, `p${i + 1}`, p.prog.data.def.displayName);
      }
      this.drawWinIcons(r, m, side);
      this.drawCombo(r, side);
    }
    if (bars) this.drawClock(r, m);
    this.drawAnnounce(r, m);
  }

  /** Turns: the members still waiting (small faces) and a KO mark on those beaten. */
  private drawTeammates(r: Renderer, m: Match, side: number, sec: Section | undefined): void {
    // Fight_DrawHud: not for survival's computer team.
    const sv = m.opts.survivalSide;
    if (sv !== undefined && sv !== side) return;
    const t = m.teamView(side);
    const pre = `p${side + 1}.teammate`;
    const [x0, y0] = pair(getValue(sec, `${pre}.pos`));
    const [dx, dy] = pair(getValue(sec, `${pre}.spacing`));
    const el = (k: string) => {
      const d = parseElement(sec, `${pre}.${k}`);
      return d ? new ElementInstance(d, this.assets) : undefined;
    };
    const bgs = [el('bg0'), el('bg1'), el('bg2')];
    for (let k = 0; k < t.memberCount - 1; k++) for (const b of bgs) b?.draw(r, x0 + dx * k, y0 + dy * k);
    let n = 0;
    for (let k = 0; k < t.memberCount; k++) {
      if (k === t.cur) continue;
      const f = t.faces?.[k];
      if (f) this.drawFace(r, sec, pre, f.data, f.pal, x0 + dx * n, y0 + dy * n, true);
      n++;
    }
    const ko = el('ko');
    for (let k = 0; k < t.cur; k++) ko?.draw(r, x0 + dx * k, y0 + dy * k);
  }

  /** Draw a bar: bg layers, then mid and front clipped to their fractions. */
  private drawBar(r: Renderer, b: Bar, frac: number, mid: number | undefined): void {
    const [x, y] = b.pos;
    b.bg0?.draw(r, x, y);
    b.bg1?.draw(r, x, y);
    const clipTo = (f: number, e: ElementInstance | undefined) => {
      if (!e) return;
      const x0 = x + b.range[0];
      const x1 = x + b.range[0] + (b.range[1] - b.range[0]) * f;
      r.setClip([x0, 0, x1 + (b.range[1] < b.range[0] ? 0 : 1), 480]);
      e.draw(r, x, y);
      r.setClip(undefined);
    };
    if (mid !== undefined) clipTo(mid, b.mid);
    clipTo(frac, b.front);
  }

  /** A face: its backgrounds (bg0..bg2) at pos, then the character's face sprite. */
  private drawFace(r: Renderer, sec: Section | undefined, pre: string, data: import('../engine/character').CharacterData, pal: number, px?: number, py?: number, noBg = false): void {
    const [x, y] = px === undefined ? pair(getValue(sec, `${pre}.pos`)) : [px, py!];
    if (!noBg) {
      for (const k of ['bg', 'bg0', 'bg1', 'bg2']) {
        const bg = parseElement(sec, `${pre}.${k}`);
        if (bg) new ElementInstance(bg, this.assets).draw(r, x, y);
      }
    }
    const face = parseElement(sec, `${pre}.face`);
    if (face?.spr) {
      const s = data.sff.get(face.spr[0], face.spr[1]);
      if (s) {
        // Character sprites are in the character's coordinate space.
        const k = this.localWidth / (data.def.localCoord[0] || 320);
        r.draw({
          sprite: s,
          // Mt_DrawFace draws from the character's sprite set without the
          // player's palette remap: the sprite's own palette.
          palette: s.palette < 0 ? undefined : data.sff.palettes[s.palette],
          x: x + face.offset[0],
          y: y + face.offset[1],
          scaleX: face.facing * face.scale[0] * k,
          scaleY: face.scale[1] * k,
        });
      }
    }
  }

  private drawName(r: Renderer, sec: Section | undefined, pre: string, name: string): void {
    const [x, y] = pair(getValue(sec, `${pre}.pos`));
    const d = parseElement(sec, `${pre}.name`);
    if (d) new ElementInstance(d, this.assets).draw(r, x, y, name);
  }

  private drawClock(r: Renderer, m: Match): void {
    const sec = findSection(this.doc, 'Time');
    const [x, y] = pair(getValue(sec, 'pos'));
    const d = parseElement(sec, 'counter');
    if (!d) return;
    const secs = m.clockSeconds;
    new ElementInstance(d, this.assets).draw(r, x, y, secs < 0 ? 'o' : String(secs));
  }

  /**
   * Fight_DrawHud's win icons: past useiconupto wins, bg0 and the count;
   * else bg0 for each round needed (up to useiconupto), then each won
   * round's icon and its perfect overlay.
   */
  private drawWinIcons(r: Renderer, m: Match, i: number): void {
    const sec = findSection(this.doc, 'WinIcon');
    const pre = `p${i + 1}`;
    const [x, y] = pair(getValue(sec, `${pre}.pos`));
    const [dx, dy] = pair(getValue(sec, `${pre}.iconoffset`));
    const upto = Math.min(9, parseInt(getValue(sec, 'useiconupto') ?? '0', 10) || 0);
    const draw = (key: string, k: number, text?: string) => {
      const def = parseElement(sec, `${pre}.${key}`);
      if (def) new ElementInstance(def, this.assets).draw(r, x + dx * k, y + dy * k, text);
    };
    const wins = m.wins[i]!;
    if (wins > upto) {
      draw('bg0', 0);
      draw('counter', 0, String(wins));
      return;
    }
    const needed = Math.min(m.teamView(i).winsNeeded, upto);
    for (let k = 0; k < needed; k++) draw('bg0', k);
    const w = m.world;
    for (const types of [w.winIcons[i]!, w.winPerfect[i]!]) {
      for (let k = 0; k < wins; k++) {
        const t = types[k]!;
        if (t >= 0) draw(WIN_ICON_KEYS[t]!, k);
      }
    }
  }

  /** Combo_Draw: team 1 puts the text after the counter, team 2 the counter before the text; the counter shakes at first. */
  private drawCombo(r: Renderer, i: number): void {
    const c = this.combo[i]!;
    if (c.shown < 2) return;
    const sec = findSection(this.doc, 'Combo');
    const pre = `team${i + 1}`;
    const y = pair(getValue(sec, `${pre}.pos`))[1];
    const counter = parseElement(sec, `${pre}.counter`);
    const text = parseElement(sec, `${pre}.text`);
    const n = String(c.shown);
    const fmt = (t: string | undefined) => (t ?? '').replace('%i', n);
    const unit = this.localWidth / 320;
    const displayTime = parseInt(getValue(sec, `${pre}.displaytime`) ?? '90', 10);
    const shake = (base: number, team1: boolean) => {
      if (parseInt(getValue(sec, `${pre}.counter.shake`) ?? '0', 10) === 0) return base;
      const t = c.timer;
      if (t === displayTime - 1) return team1 ? Math.trunc(unit) : Math.trunc(unit + base);
      if (t === displayTime - 2) return Math.trunc(2 * unit + base);
      if (t === displayTime - 3 || t === displayTime - 5 || t === displayTime - 7) return Math.trunc(unit + base);
      return base;
    };
    const width = (el: typeof counter, str: string) => {
      const f = el?.font ? this.assets.fonts[el.font[0]] : undefined;
      return f ? Math.trunc(textWidth(f, str) * (el!.scale[0] ?? 1)) : 0;
    };
    const textStr = fmt(text?.text ?? getValue(sec, `${pre}.text.text`));
    if (i === 0) {
      const w = width(counter, n);
      if (text) new ElementInstance(text, this.assets).draw(r, c.x + w, y, textStr);
      if (counter) new ElementInstance(counter, this.assets).draw(r, shake(0, true) + c.x, y, n);
    } else {
      if (text) new ElementInstance(text, this.assets).draw(r, c.x, y, textStr);
      if (text?.font) {
        const w = width(text, textStr);
        if (counter) new ElementInstance(counter, this.assets).draw(r, c.x - shake(w, false), y, n);
      }
    }
  }

  private announceKey(a: NonNullable<Match['announce']>): string {
    return a.kind === 'round' ? 'round.default' : a.kind === 'win' ? (a.winner ? 'win' : 'draw') : a.kind;
  }

  private drawAnnounce(r: Renderer, m: Match): void {
    const a = m.announce;
    if (!a) return;
    const sec = findSection(this.doc, 'Round');
    const [bx, by] = pair(getValue(sec, 'pos'));
    const e = this.round.get(this.announceKey(a));
    if (!e) return;
    if (e.def.displayTime >= 0 ? a.age > e.def.displayTime : e.finished) return;
    let text = e.def.text;
    if (text && a.kind === 'round') text = text.replace('%i', String(a.round));
    if (text && a.kind === 'win' && a.winner) text = text.replace('%s', a.winner.prog.data.def.displayName);
    e.draw(r, bx, by, text);
  }
}
