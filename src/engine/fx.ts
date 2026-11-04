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
export function palFxUniforms(f: PalFxState | undefined): { add: [number, number, number]; mul: [number, number, number]; color: number; invertAll: boolean } | undefined {
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
  /** Most recent first. */
  history: AfterImageFrame[];
  counter: number;
}

export function newAfterImage(): AfterImageState {
  return {
    time: 0, length: 20, timeGap: 1, frameGap: 4, blend: { kind: 'none' }, palColor: 256, palInvertAll: false,
    palBright: [30, 30, 30], palContrast: [120, 120, 220], palPostBright: [0, 0, 0], palAdd: [10, 10, 25], palMul: [0.65, 0.65, 0.75],
    history: [], counter: 0,
  };
}

/** Record this tick's frame (if due) and count down the effect time. */
export function recordAfterImage(a: AfterImageState, frame: AfterImageFrame | undefined): void {
  if (a.time === 0) {
    a.history.length = 0;
    return;
  }
  if (frame && a.counter++ % Math.max(1, a.timeGap) === 0) {
    a.history.unshift(frame);
    if (a.history.length > a.length) a.history.length = a.length;
  }
  if (a.time > 0) a.time--;
}

/** Frames to draw (oldest first) with their cumulative palette effect. */
export function afterImageDraws(a: AfterImageState): { frame: AfterImageFrame; add: [number, number, number]; mul: [number, number, number]; color: number; invertAll: boolean }[] {
  const out = [];
  // Base effect: bright (add), contrast (mul/256), postbright (add). Each
  // successive image applies paladd then palmul once more.
  let add: [number, number, number] = [...a.palBright];
  let mul: [number, number, number] = [a.palContrast[0] / 256, a.palContrast[1] / 256, a.palContrast[2] / 256];
  const gap = Math.max(1, a.frameGap);
  for (let i = gap - 1; i < a.history.length; i += gap) {
    add = [add[0] + a.palAdd[0], add[1] + a.palAdd[1], add[2] + a.palAdd[2]];
    mul = [mul[0] * a.palMul[0], mul[1] * a.palMul[1], mul[2] * a.palMul[2]];
    out.push({
      frame: a.history[i]!,
      add: [(add[0] + a.palPostBright[0] / Math.max(mul[0], 1e-3)) / 255, (add[1] + a.palPostBright[1] / Math.max(mul[1], 1e-3)) / 255, (add[2] + a.palPostBright[2] / Math.max(mul[2], 1e-3)) / 255] as [number, number, number],
      mul: [...mul] as [number, number, number],
      color: a.palColor / 256,
      invertAll: a.palInvertAll,
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
