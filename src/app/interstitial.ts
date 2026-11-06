// VS screen ([VS Screen]) and victory screen ([Victory Screen]).

import type { BgmInfo } from '../audio/music';
import { IN_S } from '../engine/cmd';
import { drawText, parseElement } from '../motif/element';
import type { Pick } from './select';
import { BUTTONS } from './input';
import { fader, MotifBackground, type AppContext, type Screen, motifBgm } from './screen';

function pair(v: string | undefined, d: [number, number] = [0, 0]): [number, number] {
  const p = (v ?? '').split(',').map((x) => parseFloat(x));
  return [Number.isFinite(p[0]) ? p[0]! : d[0], Number.isFinite(p[1]) ? p[1]! : d[1]];
}

function drawPortrait(ctx: AppContext, sec: string, pre: string, pick: Pick, sprDefault: [number, number]): void {
  const v = (k: string) => ctx.motif.value(sec, `${pre}.${k}`);
  const d = pick.char.data;
  if (!d) return;
  const [g, n] = pair(v('spr'), sprDefault);
  const s = d.sff.get(g, n);
  if (!s) return;
  const [x, y] = pair(v('offset'));
  const [sx, sy] = pair(v('scale'), [1, 1]);
  const facing = (parseFloat(v('facing') ?? '1') || 1) < 0 ? -1 : 1;
  const win = v('window')?.split(',').map(Number);
  if (win && win.length === 4) ctx.renderer.setClip([win[0]!, win[1]!, win[2]! + 1, win[3]! + 1]);
  const k = ctx.motif.localCoord[0] / (d.def.localCoord[0] || 320);
  ctx.renderer.draw({ sprite: s, palette: d.paletteFor(s, pick.pal), x, y, scaleX: facing * sx * k, scaleY: sy * k });
  if (win) ctx.renderer.setClip(undefined);
}

function drawLabel(ctx: AppContext, sec: string, key: string, text: string): void {
  const el = parseElement(ctx.motif.section(sec), key);
  if (!el?.font) return;
  const font = ctx.motif.fonts[el.font[0]];
  const [x, y] = pair(ctx.motif.value(sec, `${key}.offset`));
  if (font) drawText(ctx.renderer, font, text, x, y, el.font[1], el.font[2], el.scale, el.fontColor);
}

export class VersusScreen implements Screen {
  result: true | undefined;
  bgm: BgmInfo | null;
  private bg: MotifBackground;
  private fade;
  private t = 0;
  private time: number;

  constructor(
    private ctx: AppContext,
    private p1: Pick,
    private p2: Pick,
    private matchNo: number,
  ) {
    this.bgm = motifBgm(ctx, 'vs.bgm');
    this.bg = new MotifBackground(ctx, 'versus');
    this.fade = fader(ctx, 'VS Screen');
    this.time = parseInt(ctx.motif.value('VS Screen', 'time') ?? '150', 10) || 150;
  }

  tick(): void {
    this.t++;
    this.bg.tick();
    this.fade.tick();
    // Pressing a button skips ahead. The screen lasts one frame past `time`
    // (measured: VS to RoundState 1 takes 196 frames in mugen.exe).
    if (!this.fade.fadingOut && (this.t > this.time || (this.t > 20 && this.ctx.keys.pads[0]!.pressed(BUTTONS | IN_S))))
      this.fade.fadeOut();
    if (this.fade.done) this.result = true;
  }

  draw(): void {
    const r = this.ctx.renderer;
    const [w, h] = this.ctx.motif.localCoord;
    r.setProjection(w, h);
    this.bg.drawBack();
    drawPortrait(this.ctx, 'VS Screen', 'p1', this.p1, [9000, 1]);
    drawPortrait(this.ctx, 'VS Screen', 'p2', this.p2, [9000, 1]);
    drawLabel(this.ctx, 'VS Screen', 'p1.name', this.p1.char.data?.def.displayName ?? '');
    drawLabel(this.ctx, 'VS Screen', 'p2.name', this.p2.char.data?.def.displayName ?? '');
    const mt = (this.ctx.motif.value('VS Screen', 'match.text') ?? '').replace(/^"|"$/g, '');
    if (mt) drawLabel(this.ctx, 'VS Screen', 'match', mt.replace('%i', String(this.matchNo)));
    this.bg.drawFront();
    this.fade.draw(r, w, h);
  }
}

export class VictoryScreen implements Screen {
  result: true | undefined;
  bgm: BgmInfo | null;
  private bg: MotifBackground;
  private fade;
  private t = 0;
  private time: number;

  constructor(
    private ctx: AppContext,
    /** The winner; none after a draw (match_winner 0: only the background). */
    private winner: Pick | undefined,
    private quote: string,
  ) {
    this.bgm = motifBgm(ctx, 'victory.bgm');
    this.bg = new MotifBackground(ctx, 'victory');
    this.fade = fader(ctx, 'Victory Screen');
    this.time = parseInt(ctx.motif.value('Victory Screen', 'time') ?? '300', 10) || 300;
  }

  tick(): void {
    this.t++;
    this.bg.tick();
    this.fade.tick();
    if (!this.fade.fadingOut && (this.t >= this.time || (this.t > 20 && this.ctx.keys.pads[0]!.pressed(BUTTONS | IN_S))))
      this.fade.fadeOut();
    if (this.fade.done) this.result = true;
  }

  draw(): void {
    const r = this.ctx.renderer;
    const [w, h] = this.ctx.motif.localCoord;
    r.setProjection(w, h);
    this.bg.drawBack();
    if (!this.winner) {
      this.bg.drawFront();
      this.fade.draw(r, w, h);
      return;
    }
    drawPortrait(this.ctx, 'Victory Screen', 'p1', this.winner, [9000, 2]);
    drawLabel(this.ctx, 'Victory Screen', 'p1.name', this.winner.char.data?.def.displayName ?? '');
    const sec = 'Victory Screen';
    const el = parseElement(this.ctx.motif.section(sec), 'winquote');
    const font = el?.font ? this.ctx.motif.fonts[el.font[0]] : undefined;
    if (el?.font && font) {
      const [x, y] = pair(this.ctx.motif.value(sec, 'winquote.offset'));
      const win = this.ctx.motif.value(sec, 'winquote.window')?.split(',').map(Number);
      const maxW = win && win.length === 4 ? win[2]! - x : w - x;
      // textwrap = w: wrap on word boundaries inside the window.
      const lines = wrap(this.quote, (s) => s.length * (font.spaceWidth + font.spacing[0]), maxW);
      lines.forEach((line, i) =>
        drawText(r, font, line, x, y + i * (font.height + font.spacing[1]), el.font![1], el.font![2], el.scale, el.fontColor),
      );
    }
    this.bg.drawFront();
    this.fade.draw(r, w, h);
  }
}

function wrap(text: string, measure: (s: string) => number, maxW: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxW) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}
