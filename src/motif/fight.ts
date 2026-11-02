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
import { loadFont, type Font } from './font';

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

export class FightHud {
  private assets: ElementAssets;
  private life: Bar[];
  private power: Bar[];
  /** Lifebar "mid" (recent damage) value per side, drains toward life. */
  private midLife = [1, 1];
  private midDelay = [0, 0];
  private lastLife = [1, 1];
  private combo = [{ hits: 0, shown: 0, age: 999 }, { hits: 0, shown: 0, age: 999 }];
  private round: Map<string, ElementInstance> = new Map();

  private constructor(
    private doc: IniDoc,
    readonly sff: Sff,
    readonly snd: Snd | undefined,
    anims: AnimationMap,
    fonts: (Font | undefined)[],
  ) {
    this.assets = { sff, anims, fonts };
    this.life = [0, 1].map((i) => this.bar(findSection(doc, 'Lifebar'), `p${i + 1}`));
    this.power = [0, 1].map((i) => this.bar(findSection(doc, 'Powerbar'), `p${i + 1}`));
    const rs = findSection(doc, 'Round');
    for (const k of ['round.default', 'fight', 'ko', 'dko', 'to', 'win', 'draw']) {
      const d = parseElement(rs, k);
      if (d) this.round.set(k, new ElementInstance(d, this.assets));
    }
  }

  static async load(vfs: Vfs, defPath = 'data/fight.def'): Promise<FightHud> {
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
    return new FightHud(doc, sff, snd, parseAir(text), fonts);
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

  tick(m: Match): void {
    for (const b of [...this.life, ...this.power]) for (const e of [b.bg0, b.bg1, b.mid, b.front]) e?.tick();
    for (const e of this.round.values()) e.tick();
    m.players.forEach((p, i) => {
      const frac = Math.max(0, p.life / p.const('data.life'));
      // The red "mid" bar waits while the player is in hitstun, then drains.
      if (frac < this.lastLife[i]!) this.midDelay[i] = 30;
      this.lastLife[i] = frac;
      if (this.midDelay[i]! > 0 && p.moveType !== 'h') this.midDelay[i]!--;
      if (this.midDelay[i] === 0 && this.midLife[i]! > frac) this.midLife[i] = Math.max(frac, this.midLife[i]! - 0.01);
      if (this.midLife[i]! < frac) this.midLife[i] = frac;
      // Combo counter: hits landed on the opponent this combo.
      const opp = m.players[1 - i];
      const c = this.combo[i]!;
      const hits = opp && opp.moveType === 'h' ? opp.ghv.hitcount : 0;
      if (hits >= 2 && hits !== c.shown) {
        c.shown = hits;
        c.age = 0;
      }
      if (hits === 0) c.shown = 0;
      c.age++;
    });
  }

  draw(r: Renderer, m: Match): void {
    const ps = m.players;
    ps.forEach((p, i) => {
      this.drawBar(r, this.life[i]!, Math.max(0, p.life / p.const('data.life')), this.midLife[i]!);
      const pmax = p.const('data.power');
      const pb = this.power[i]!;
      this.drawBar(r, pb, Math.max(0, p.power / pmax), undefined);
      pb.counter?.draw(r, pb.pos[0], pb.pos[1], String(Math.floor(p.power / 1000)));
      this.drawFace(r, p, i);
      this.drawName(r, p, i);
      this.drawWinIcons(r, m, i);
      this.drawCombo(r, i);
    });
    this.drawClock(r, m);
    this.drawAnnounce(r, m);
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

  private drawFace(r: Renderer, p: Player, i: number): void {
    const sec = findSection(this.doc, 'Face');
    const pre = `p${i + 1}`;
    const [x, y] = pair(getValue(sec, `${pre}.pos`));
    const bg = parseElement(sec, `${pre}.bg`);
    if (bg) new ElementInstance(bg, this.assets).draw(r, x, y);
    const face = parseElement(sec, `${pre}.face`);
    if (face?.spr) {
      const sff = p.prog.data.sff;
      const s = sff.get(face.spr[0], face.spr[1]);
      if (s) {
        r.draw({
          sprite: s,
          palette: p.prog.data.paletteFor(s, p.palNo),
          x: x + face.offset[0],
          y: y + face.offset[1],
          scaleX: face.facing * face.scale[0],
          scaleY: face.scale[1],
        });
      }
    }
  }

  private drawName(r: Renderer, p: Player, i: number): void {
    const sec = findSection(this.doc, 'Name');
    const pre = `p${i + 1}`;
    const [x, y] = pair(getValue(sec, `${pre}.pos`));
    const d = parseElement(sec, `${pre}.name`);
    if (d) new ElementInstance(d, this.assets).draw(r, x, y, p.prog.data.def.displayName);
  }

  private drawClock(r: Renderer, m: Match): void {
    const sec = findSection(this.doc, 'Time');
    const [x, y] = pair(getValue(sec, 'pos'));
    const d = parseElement(sec, 'counter');
    if (!d) return;
    const secs = m.clockSeconds;
    new ElementInstance(d, this.assets).draw(r, x, y, secs < 0 ? 'o' : String(secs));
  }

  private drawWinIcons(r: Renderer, m: Match, i: number): void {
    const sec = findSection(this.doc, 'WinIcon');
    const pre = `p${i + 1}`;
    const [x, y] = pair(getValue(sec, `${pre}.pos`));
    const [dx, dy] = pair(getValue(sec, `${pre}.iconoffset`));
    const icon = parseElement(sec, `${pre}.n`);
    if (!icon) return;
    const e = new ElementInstance(icon, this.assets);
    for (let k = 0; k < m.wins[i]!; k++) e.draw(r, x + dx * k, y + dy * k);
  }

  private drawCombo(r: Renderer, i: number): void {
    const c = this.combo[i]!;
    const sec = findSection(this.doc, 'Combo');
    const pre = `team${i + 1}`;
    const time = parseFloat(getValue(sec, `${pre}.displaytime`) ?? '90');
    if (c.shown < 2 || c.age > time) return;
    const [x, y] = pair(getValue(sec, `${pre}.pos`));
    const counter = parseElement(sec, `${pre}.counter`);
    const text = parseElement(sec, `${pre}.text`);
    if (counter?.font) {
      const font = this.assets.fonts[counter.font[0]];
      if (font) drawText(r, font, String(c.shown), x, y, counter.font[1], counter.font[2]);
    }
    if (text) new ElementInstance(text, this.assets).draw(r, x + (i === 0 ? 30 : -30), y);
  }

  private drawAnnounce(r: Renderer, m: Match): void {
    const a = m.announce;
    if (!a) return;
    const sec = findSection(this.doc, 'Round');
    const [bx, by] = pair(getValue(sec, 'pos'));
    const key = a.kind === 'round' ? 'round.default' : a.kind === 'win' ? (a.winner ? 'win' : 'draw') : a.kind;
    const e = this.round.get(key);
    if (!e) return;
    if (e.def.displayTime >= 0 && a.age > e.def.displayTime) return;
    if (a.age === 0) e.reset();
    let text = e.def.text;
    if (text && a.kind === 'round') text = text.replace('%i', String(a.round));
    if (text && a.kind === 'win' && a.winner) text = text.replace('%s', a.winner.prog.data.def.displayName);
    e.draw(r, bx, by, text);
  }
}
