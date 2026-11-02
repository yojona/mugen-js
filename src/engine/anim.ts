// Animation playback for one AIR action.
//
// State is just `time` (ticks elapsed since the action was set); the displayed
// element and the AnimTime / AnimElemTime trigger values are derived from it,
// so they can never drift. Looping follows air.html: after the last element the
// action restarts at Loopstart. Exact tick alignment is provisional until
// verified against the reference binary.

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

interface Timing {
  /** Start tick of each element within the first pass. */
  starts: number[];
  /** Total looptime, or -1 if some element lasts forever. */
  total: number;
  /** Sum of finite element times. */
  finite: number;
  /** Literal sum of element times, counting -1 as -1 (MUGEN's AnimTime base). */
  literal: number;
  loopStartTime: number;
  /** Length of the looping portion. */
  loopLen: number;
}

const timingCache = new WeakMap<Animation, Timing>();

function timing(anim: Animation): Timing {
  let t = timingCache.get(anim);
  if (t) return t;
  const starts: number[] = [];
  let acc = 0;
  let literal = 0;
  let infinite = false;
  for (const e of anim.elements) {
    starts.push(acc);
    literal += e.time;
    if (e.time < 0) infinite = true;
    else acc += e.time;
  }
  const loopStartTime = starts[anim.loopStart] ?? 0;
  t = { starts, total: infinite ? -1 : acc, finite: acc, literal, loopStartTime, loopLen: Math.max(1, acc - loopStartTime) };
  timingCache.set(anim, t);
  return t;
}

export class AnimPlayer {
  /** Ticks since the action started. */
  time = 0;
  /** Element shown at `time` (0-based) and ticks spent in it. */
  elem = 0;
  elemTime = 0;
  private t: Timing;

  constructor(public anim: Animation, startElem = 0) {
    this.t = timing(anim);
    this.set(anim, startElem);
  }

  /** Switch action. `startElem` (0-based) supports ChangeAnim's elem parameter. */
  set(anim: Animation, startElem = 0): void {
    this.anim = anim;
    this.t = timing(anim);
    const s = this.t.starts[Math.min(Math.max(startElem, 0), Math.max(anim.elements.length - 1, 0))] ?? 0;
    this.time = s;
    this.update();
  }

  /** Back-compat alias used by the viewer. */
  reset(anim: Animation = this.anim, elem = 0): void {
    this.set(anim, elem);
  }

  get current(): AnimElement | undefined {
    return this.anim.elements[this.elem];
  }

  get totalTime(): number {
    return this.t.total;
  }

  tick(): void {
    this.time++;
    this.update();
  }

  /** Position within the first pass that corresponds to elapsed time `e`. */
  private mapped(e: number): number {
    const t = this.t;
    if (t.total < 0 || e < t.total) return e;
    return t.loopStartTime + ((e - t.total) % t.loopLen);
  }

  private elementAt(pos: number): { elem: number; elemTime: number } {
    const { starts } = this.t;
    const els = this.anim.elements;
    let i = 0;
    for (let k = 0; k < els.length; k++) {
      const e = els[k]!;
      if (pos >= starts[k]! && (e.time < 0 || pos < starts[k]! + e.time)) {
        i = k;
        return { elem: i, elemTime: pos - starts[k]! };
      }
    }
    return { elem: Math.max(0, els.length - 1), elemTime: 0 };
  }

  private update(): void {
    const r = this.elementAt(this.mapped(this.time));
    this.elem = r.elem;
    this.elemTime = r.elemTime;
  }

  /** AnimTime trigger: 0 when the end of the action is reached, negative before. */
  animTime(): number {
    const t = this.t;
    const e = this.time;
    // Actions with a -1 element: MUGEN sums element times literally (the -1
    // included), measured against MUGEN 1.1 with KFM's action 5160.
    if (t.total < 0) return e - t.literal;
    if (e <= t.total) return e - t.total;
    const r = (e - t.total) % t.loopLen;
    return r === 0 ? 0 : t.loopStartTime + r - t.total;
  }

  /** AnimElemTime(n) with 1-based n; undefined if n is not a valid element. */
  animElemTime(n: number): number | undefined {
    const start = this.t.starts[n - 1];
    if (start === undefined) return undefined;
    const e = this.time;
    if (this.t.total < 0 || e < this.t.total) return e - start;
    // In the looping portion: measured within the current loop, never 0 on the
    // first tick of a new loop (trigger.html AnimElem notes).
    const pos = this.t.loopStartTime + ((e - this.t.total) % this.t.loopLen);
    const v = pos - start;
    return v === 0 && n - 1 === this.anim.loopStart ? this.t.loopLen : v;
  }

  /** AnimElemNo(offset): 1-based element displayed `offset` ticks from now. */
  animElemNo(offset: number): number | undefined {
    const e = this.time + offset;
    if (e < 0) return undefined;
    return this.elementAt(this.mapped(e)).elem + 1;
  }

  /** Current element with AIR 1.1 linear interpolation applied. */
  view(): FrameView | undefined {
    const e = this.current;
    if (!e) return undefined;
    const base: FrameView = { element: e, x: e.x, y: e.y, scaleX: e.scaleX, scaleY: e.scaleY, angle: e.angle, blend: e.blend };
    const it = e.interp;
    if (e.time <= 0 || !(it.offset || it.blend || it.scale || it.angle)) return base;
    const els = this.anim.elements;
    const n = els[this.elem + 1 < els.length ? this.elem + 1 : this.anim.loopStart];
    if (!n) return base;
    const k = this.elemTime / e.time;
    const lerp = (a: number, b: number) => a + (b - a) * k;
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
