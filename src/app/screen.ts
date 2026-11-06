// Shared screen plumbing: fades, backgrounds and motif sounds.

import type { Mixer } from '../audio/mixer';
import type { DummySettings } from '../engine/ai';
import type { GameOptions } from './game-options';
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
  /** Training mode: the dummy's settings changed; undefined when it ends. */
  onTrainingDummy?: (dummy: DummySettings | undefined) => void;
  /** GameVars.frames: ticks run on every screen since startup (GameTime, the hit order). */
  frames?: number;
  /** The options screen's settings (mugen.cfg [Options], [Sound]). */
  options?: GameOptions;
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

/**
 * A FADE_PALETTE fade (Fade_Update, gfx.c 0x46B7A0): what the fade leaves is a
 * multiplier on the global PalFX for the frame, so what bypasses the PalFX
 * (additive / subtractive rectangles, TrueType text) stays bright. A fade in
 * runs 0, 25, 51 .. 230 and a fade out 256, 230 .. 25, of 256.
 */
export class PaletteFade {
  private ticks = 0;
  private out = false;
  /** ScreenLoop.fade_ticks: the frames left of the fade out. */
  private screenTicks = 0;
  /** PalFx_ScaleGlobalMul's multiplier of this frame, 256 for none. */
  mul = 256;
  constructor(
    private time: number,
    private outTime: number,
  ) {}

  /** Screen_Tick: the fade out's count, then Fade_Update. */
  tick(): void {
    if (this.out && this.screenTicks > 0) this.screenTicks--;
    if (this.ticks >= this.time || this.time === 0) {
      this.mul = 256;
      this.ticks = 0;
      this.time = 0;
      return;
    }
    // float progress, double arithmetic: mul is truncated from these exact values.
    let progress = Math.fround(this.ticks / this.time);
    if (!this.out) progress = Math.fround(1 - progress);
    this.mul = Math.trunc((1 - progress) * 256);
    this.ticks++;
  }
  /** Title_FadeOut */
  fadeOut(): void {
    if (this.out) return;
    this.out = true;
    this.ticks = 0;
    this.time = this.outTime;
    this.screenTicks = this.outTime;
  }
  get fadingOut(): boolean {
    return this.out;
  }
  /** The fade out's frames have run (Screen_Run's loop ends). */
  get done(): boolean {
    return this.out && this.screenTicks <= 0;
  }
  /** The frame's Renderer.tint. */
  get tint(): [number, number, number] | undefined {
    if (this.mul === 256) return undefined;
    const m = this.mul / 256;
    return [m, m, m];
  }
}

function fadeTimes(ctx: AppContext, section: string): [number, number] {
  const n = (k: string) => {
    const v = parseInt(ctx.motif.value(section, k) ?? '', 10);
    return Number.isFinite(v) ? v : 10;
  };
  return [n('fadein.time'), n('fadeout.time')];
}

export function fader(ctx: AppContext, section: string): Fader {
  return new Fader(...fadeTimes(ctx, section));
}

export function paletteFader(ctx: AppContext, section: string): PaletteFade {
  return new PaletteFade(...fadeTimes(ctx, section));
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
    // Gfx_SoftClear goes through the global PalFX.
    const t = this.ctx.renderer.tint ?? [1, 1, 1];
    this.ctx.renderer.clear((this.clear[0] / 255) * t[0], (this.clear[1] / 255) * t[1], (this.clear[2] / 255) * t[2]);
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
