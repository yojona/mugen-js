// Visual effect state: PalFX, AfterImage, EnvShake (sctrls.html).

import type { Blend } from '../formats/air';
import type { Sprite } from '../formats/sff';

/** PalFX state; values in MUGEN units (add 0..255, mul /256, color 0..256). */
export interface PalFxState {
  time: number;
  /** Ticks elapsed since the effect started (drives sinadd). */
  elapsed: number;
  add: [number, number, number];
  mul: [number, number, number];
  sinAdd: [number, number, number];
  sinPeriod: number;
  invertAll: boolean;
  color: number;
}

export function newPalFx(): PalFxState {
  return { time: 0, elapsed: 0, add: [0, 0, 0], mul: [256, 256, 256], sinAdd: [0, 0, 0], sinPeriod: 0, invertAll: false, color: 256 };
}

export function palFxActive(f: PalFxState): boolean {
  return f.time !== 0;
}

export function tickPalFx(f: PalFxState): void {
  if (f.time > 0) f.time--;
  if (f.time !== 0) f.elapsed++;
}

/** Shader parameters (normalized) for the current PalFX state. */
export function palFxUniforms(
  f: PalFxState | undefined,
): { add: [number, number, number]; mul: [number, number, number]; color: number; invertAll: boolean } | undefined {
  if (!f || f.time === 0) return undefined;
  const s = f.sinPeriod > 0 ? Math.sin((2 * Math.PI * f.elapsed) / f.sinPeriod) : 0;
  return {
    add: [(f.add[0] + f.sinAdd[0] * s) / 255, (f.add[1] + f.sinAdd[1] * s) / 255, (f.add[2] + f.sinAdd[2] * s) / 255],
    mul: [f.mul[0] / 256, f.mul[1] / 256, f.mul[2] / 256],
    color: f.color / 256,
    invertAll: f.invertAll,
  };
}

// ---------------------------------------------------------------------------
// AfterImage

export interface AfterImageFrame {
  sprite: Sprite;
  palette: Uint8Array | undefined;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  /** The player's sprite priority when recorded (AnimState.layer). */
  layer: number;
}

export interface AfterImageState {
  time: number;
  length: number;
  timeGap: number;
  frameGap: number;
  blend: Blend;
  palColor: number;
  palInvertAll: boolean;
  palBright: [number, number, number];
  palContrast: [number, number, number];
  palPostBright: [number, number, number];
  palAdd: [number, number, number];
  palMul: [number, number, number];
  /** afterimage.c: the ring of recorded frames (null: a blank one), the next slot, the oldest, the ticks run and whether it runs. */
  frames: (AfterImageFrame | null)[];
  next: number;
  oldest: number;
  ticks: number;
  running: boolean;
}

export function newAfterImage(): AfterImageState {
  return {
    time: 0,
    length: 20,
    timeGap: 1,
    frameGap: 4,
    blend: { kind: 'none' },
    palColor: 256,
    palInvertAll: false,
    palBright: [30, 30, 30],
    palContrast: [120, 120, 220],
    palPostBright: [0, 0, 0],
    palAdd: [10, 10, 25],
    palMul: [0.65, 0.65, 0.75],
    frames: [],
    next: 0,
    oldest: 0,
    ticks: 0,
    running: false,
  };
}

/** AfterImage_Apply: an empty ring, running from tick 0. */
export function startAfterImage(a: AfterImageState): void {
  a.frames = new Array<AfterImageFrame | null>(a.length).fill(null);
  a.next = a.oldest = a.ticks = 0;
  a.running = true;
}

/**
 * AfterImage_Update, once per player update: every timegap ticks the
 * player's frame goes into the ring (a blank one once `time` is over, so
 * the trail empties out), then the tick counts unless in hit pause. It
 * stops timegap * length ticks after `time`.
 */
export function recordAfterImage(a: AfterImageState, frame: AfterImageFrame | undefined, active: boolean): void {
  if (!a.running) return;
  if (a.time !== -1 && a.ticks + 1 >= a.timeGap * a.length + a.time) {
    a.running = false;
    return;
  }
  if (a.ticks % a.timeGap === 0) {
    a.frames[a.next] = a.ticks + 1 >= a.time && a.time !== -1 ? null : (frame ?? null);
    if (++a.next >= a.length) a.next = 0;
    if (a.next === a.oldest && ++a.oldest >= a.length) a.oldest = 0;
  }
  if (active) a.ticks++;
}

/**
 * AfterImage_Draw: every framegap-th recorded frame, newest first, with
 * palcolor / palinvertall, palbright, palcontrast and palpostbright /
 * palcontrast; the k-th one drawn (from 0) also paladd * k and palmul to
 * the k-th power. Returned oldest first (drawing order).
 */
export function afterImageDraws(a: AfterImageState): {
  frame: AfterImageFrame;
  add: [number, number, number];
  mul: [number, number, number];
  color: number;
  invertAll: boolean;
  k: number;
}[] {
  const out: ReturnType<typeof afterImageDraws> = [];
  if (!a.running || a.next === a.oldest) return out;
  let idx = a.next;
  let wrapped = idx >= a.oldest;
  let drawn = 0;
  const mulAcc = [256, 256, 256];
  for (;;) {
    idx -= a.frameGap;
    if (idx < 0 && !wrapped) {
      idx += a.length;
      wrapped = true;
    }
    if (idx < a.oldest && wrapped) break;
    const f = a.frames[idx];
    if (!f) continue;
    const add = [0, 1, 2].map((i) => a.palBright[i]!);
    const mul = [0, 1, 2].map((i) => a.palContrast[i]!);
    for (let i = 0; i < 3; i++) if (a.palContrast[i] !== 0) add[i]! += Math.trunc(a.palPostBright[i]! / a.palContrast[i]!);
    if (drawn > 0) {
      for (let i = 0; i < 3; i++) {
        add[i]! += a.palAdd[i]! * drawn;
        mulAcc[i] = Math.fround(a.palMul[i]! * mulAcc[i]!);
        mul[i] = (mul[i]! * Math.trunc(mulAcc[i]!)) >> 8;
      }
    }
    drawn++;
    out.push({
      frame: f,
      add: [add[0]! / 255, add[1]! / 255, add[2]! / 255] as [number, number, number],
      mul: [mul[0]! / 256, mul[1]! / 256, mul[2]! / 256] as [number, number, number],
      color: a.palColor / 256,
      invertAll: a.palInvertAll,
      k: drawn - 1,
    });
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// EnvShake

export interface EnvShake {
  time: number;
  freq: number;
  /** Amplitude in game (internal) units (EnvShake_Apply: ampl * GameWidth / localcoord). */
  ampl: number;
  phase: number;
  /** Ticks run so far (GameVars.envshake[0]). */
  elapsed: number;
}

/**
 * EnvShake_Apply: an EnvShake from the given parameters, in game units for a
 * player whose units are `unit` (GameWidth / localcoord). freq 0 becomes
 * 0.001 and a negative one positive; without a phase, freq 90 or more gives
 * phase 90.
 */
export function makeEnvShake(time: number, freq: number, ampl: number, phase: number | undefined, unit: number): EnvShake {
  const f = freq === 0 ? 0.001 : Math.abs(freq);
  return { time, freq: Math.fround(f), ampl: Math.fround(ampl * unit), phase: Math.fround(phase ?? (f >= 90 ? 90 : 0)), elapsed: 0 };
}

/**
 * The shadow parameters of explods and projectiles: -1 asks for a shadow, an
 * illegal value too; otherwise Video_MapRGB (RGB565 in the reference's 16-bit
 * mode) decides, and a colour mapping to 0 means none.
 */
export function shadowOn(r = 0, g = 0, b = 0): boolean {
  if (r < -1 || g < -1 || b < -1 || r > 255 || g > 255 || b > 255) return true;
  return r >> 3 !== 0 || g >> 2 !== 0 || b >> 3 !== 0;
}
