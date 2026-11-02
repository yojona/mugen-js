// Animation playback state for one AIR action.
// Tick semantics are provisional; they will be pinned down against the
// reference binary (AnimTime / AnimElemTime triggers depend on them).

import type { AnimElement, Animation, Blend } from '../formats/air';

export interface FrameView {
  element: AnimElement;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  blend: Blend;
}

export class AnimPlayer {
  elem = 0;
  elemTime = 0;
  /** Ticks since the animation started. */
  time = 0;

  constructor(public anim: Animation) {}

  reset(anim: Animation = this.anim, elem = 0): void {
    this.anim = anim;
    this.elem = Math.min(Math.max(elem, 0), Math.max(anim.elements.length - 1, 0));
    this.elemTime = 0;
    this.time = 0;
  }

  get current(): AnimElement | undefined {
    return this.anim.elements[this.elem];
  }

  tick(): void {
    const els = this.anim.elements;
    const el = els[this.elem];
    this.time++;
    if (!el || el.time < 0) return;
    this.elemTime++;
    // Skip over zero-length elements without looping forever.
    let guard = els.length + 1;
    while (guard-- > 0) {
      const e = els[this.elem]!;
      if (e.time < 0 || this.elemTime < e.time) break;
      this.elemTime -= e.time;
      this.elem++;
      if (this.elem >= els.length) this.elem = this.anim.loopStart;
    }
  }

  /** Current element with AIR 1.1 linear interpolation applied. */
  view(): FrameView | undefined {
    const e = this.current;
    if (!e) return undefined;
    const base: FrameView = { element: e, x: e.x, y: e.y, scaleX: e.scaleX, scaleY: e.scaleY, angle: e.angle, blend: e.blend };
    const it = e.interp;
    if (e.time <= 0 || !(it.offset || it.blend || it.scale || it.angle)) return base;
    const els = this.anim.elements;
    const nextIdx = this.elem + 1 < els.length ? this.elem + 1 : this.anim.loopStart;
    const n = els[nextIdx];
    if (!n) return base;
    const t = this.elemTime / e.time;
    const lerp = (a: number, b: number) => a + (b - a) * t;
    if (it.offset) {
      base.x = lerp(e.x, n.x);
      base.y = lerp(e.y, n.y);
    }
    if (it.scale) {
      base.scaleX = lerp(e.scaleX, n.scaleX);
      base.scaleY = lerp(e.scaleY, n.scaleY);
    }
    if (it.angle) base.angle = lerp(e.angle, n.angle);
    if (it.blend && e.blend.kind === 'add' && n.blend.kind === 'add') {
      base.blend = { kind: 'add', src: lerp(e.blend.src, n.blend.src), dst: lerp(e.blend.dst, n.blend.dst) };
    }
    return base;
  }
}
