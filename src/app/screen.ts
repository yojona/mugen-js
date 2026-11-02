// Shared screen plumbing: fades, backgrounds and motif sounds.

import type { Mixer } from '../audio/mixer';
import type { Renderer } from '../render/renderer';
import { drawStageLayer } from '../render/stage-draw';
import type { Background } from '../stage/stage';
import { StageRuntime } from '../stage/stage';
import type { Motif } from '../motif/system';
import type { Keyboard } from './input';

export interface AppContext {
  renderer: Renderer;
  mixer: Mixer;
  keys: Keyboard;
  motif: Motif;
  /** CPU AI level (mugen.cfg [Options] Difficulty, 1..8). */
  aiLevel: number;
}

export interface Screen {
  tick(): void;
  draw(): void;
  /** Set when the screen has finished (after its fade-out). */
  result?: unknown;
}

/** Fade in at start, fade out on request; alpha of the black overlay. */
export class Fader {
  private t = 0;
  private outT = -1;
  constructor(
    private inTime: number,
    private outTime: number,
  ) {}
  tick(): void {
    this.t++;
    if (this.outT >= 0) this.outT++;
  }
  fadeOut(): void {
    if (this.outT < 0) this.outT = 0;
  }
  get fadingOut(): boolean {
    return this.outT >= 0;
  }
  get done(): boolean {
    return this.outT >= this.outTime;
  }
  get alpha(): number {
    if (this.outT >= 0) return this.outTime <= 0 ? 1 : Math.min(1, this.outT / this.outTime);
    if (this.t < this.inTime) return 1 - this.t / this.inTime;
    return 0;
  }
  draw(r: Renderer, w: number, h: number): void {
    const a = this.alpha;
    if (a > 0) r.rect(0, 0, w, h, [0, 0, 0, Math.round(a * 255)]);
  }
}

export function fader(ctx: AppContext, section: string): Fader {
  const n = (k: string, d: number) => parseInt(ctx.motif.value(section, k) ?? '', 10);
  const fi = n('fadein.time', 10);
  const fo = n('fadeout.time', 10);
  return new Fader(Number.isFinite(fi) ? fi : 10, Number.isFinite(fo) ? fo : 10);
}

/** A motif background (title, select, versus...) with its own clock. */
export class MotifBackground {
  private rt: StageRuntime | undefined;
  private clear: [number, number, number] = [0, 0, 0];
  constructor(
    private ctx: AppContext,
    name: string,
  ) {
    const bg = ctx.motif.backgrounds.get(name) as (Background & { clearColor: [number, number, number] }) | undefined;
    if (bg) {
      this.rt = new StageRuntime(bg);
      this.clear = bg.clearColor;
    }
  }
  tick(): void {
    this.rt?.tick();
  }
  drawBack(): void {
    const [w, h] = this.ctx.motif.localCoord;
    this.ctx.renderer.clear(this.clear[0] / 255, this.clear[1] / 255, this.clear[2] / 255);
    if (this.rt) drawStageLayer(this.ctx.renderer, this.rt, { x: 0, y: 0 }, 0, w, h);
  }
  drawFront(): void {
    const [w, h] = this.ctx.motif.localCoord;
    if (this.rt) drawStageLayer(this.ctx.renderer, this.rt, { x: 0, y: 0 }, 1, w, h);
  }
}

/** Play a motif sound given "group, number" text. */
export function motifSound(ctx: AppContext, value: string | undefined): void {
  if (!value) return;
  const [g, n] = value.split(',').map((x) => parseInt(x, 10));
  if (g === undefined || n === undefined || Number.isNaN(g) || Number.isNaN(n)) return;
  ctx.mixer.play(ctx.motif.snd?.get(g, n));
}
