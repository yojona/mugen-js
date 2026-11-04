// AIR animation files (docs/air.html, MUGEN 1.1 incl. scale/angle/interpolation).

import { splitLines, stripComment } from './text';

export interface Clsn {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Blend =
  | { kind: 'none' }
  | { kind: 'add'; src: number; dst: number } // A = AS256D256, A1 = AS256D128, ASxDy
  | { kind: 'sub' };

export interface AnimElement {
  group: number;
  number: number;
  x: number;
  y: number;
  /** Ticks to display; -1 = forever. */
  time: number;
  flipH: boolean;
  flipV: boolean;
  blend: Blend;
  scaleX: number;
  scaleY: number;
  angle: number;
  /** Attack boxes for this element (null = none). */
  clsn1: Clsn[] | null;
  /** Hurt boxes for this element (null = none). */
  clsn2: Clsn[] | null;
  /** Interpolate from this element towards the next one. */
  interp: { offset: boolean; blend: boolean; scale: boolean; angle: boolean };
}

export interface Animation {
  action: number;
  elements: AnimElement[];
  /** Index of the element the animation loops back to. */
  loopStart: number;
  /** mugen.exe's total time: restarts at -1 on a -1 element, then adds the rest. */
  totalTime: number;
}

export type AnimationMap = Map<number, Animation>;

const ACTION_RE = /^\[\s*begin\s+action\s+(-?\d+)\s*\]/i;
const CLSN_HDR_RE = /^clsn([12])(default)?\s*:\s*(\d+)/i;
const CLSN_BOX_RE = /^clsn([12])\s*\[\s*\d+\s*\]\s*=\s*(.+)$/i;
const INTERP_RE = /^interpolate\s+(offset|blend|scale|angle)\b/i;

function num(s: string | undefined, def: number): number {
  if (s === undefined) return def;
  const t = s.trim();
  if (t === '') return def;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : def;
}

function int(s: string | undefined, def: number): number {
  const v = num(s, def);
  return Math.trunc(v);
}

export function parseBlend(s: string | undefined): Blend {
  const t = (s ?? '').trim().toUpperCase();
  if (t === '') return { kind: 'none' };
  if (t === 'S') return { kind: 'sub' };
  if (t === 'A') return { kind: 'add', src: 256, dst: 256 };
  if (t === 'A1') return { kind: 'add', src: 256, dst: 128 };
  const m = /^AS(\d*)D(\d*)$/.exec(t);
  if (m) return { kind: 'add', src: m[1] ? +m[1] : 0, dst: m[2] ? +m[2] : 0 };
  if (t.startsWith('A')) return { kind: 'add', src: 256, dst: 256 };
  return { kind: 'none' };
}

export function parseAir(text: string): AnimationMap {
  const anims: AnimationMap = new Map();
  let cur: Animation | null = null;
  let clsnTarget: { which: 1 | 2; isDefault: boolean; boxes: Clsn[] } | null = null;
  let def1: Clsn[] | null = null;
  let def2: Clsn[] | null = null;
  let next1: Clsn[] | null = null;
  let next2: Clsn[] | null = null;
  // A ClsnNDefault and then a ClsnN in the same element's lines: mugen.exe
  // releases the default box set (Anim_Load's Clsn_Release) and the new set
  // takes its freed memory, so the default the next elements get is that set.
  let defHere1 = false;
  let defHere2 = false;
  let pendingInterp = { offset: false, blend: false, scale: false, angle: false };
  let interpBeforeFirst = { offset: false, blend: false, scale: false, angle: false };
  let setLoopStart = false;

  const closeAction = () => {
    if (!cur) return;
    // Interpolate lines before the first element apply to last -> first wrap.
    const last = cur.elements[cur.elements.length - 1];
    if (last) last.interp = { ...interpBeforeFirst };
    // mugen.exe: a -1 element sets the total to -1, later elements add on.
    let total = 0;
    for (const e of cur.elements) {
      if (e.time === -1) total = -1;
      else total += e.time;
    }
    cur.totalTime = total;
    if (cur.loopStart >= cur.elements.length) cur.loopStart = 0;
  };

  for (const rawLine of splitLines(text)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const am = ACTION_RE.exec(line);
    if (am) {
      closeAction();
      const action = parseInt(am[1]!, 10);
      cur = { action, elements: [], loopStart: 0, totalTime: 0 };
      // MUGEN keeps the first definition of a duplicated action.
      if (!anims.has(action)) anims.set(action, cur);
      def1 = def2 = next1 = next2 = null;
      defHere1 = defHere2 = false;
      clsnTarget = null;
      pendingInterp = { offset: false, blend: false, scale: false, angle: false };
      interpBeforeFirst = { ...pendingInterp };
      setLoopStart = false;
      continue;
    }
    if (!cur) continue;

    const hm = CLSN_HDR_RE.exec(line);
    if (hm) {
      const which = hm[1] === '1' ? 1 : 2;
      const isDefault = !!hm[2];
      clsnTarget = { which, isDefault, boxes: [] };
      if (which === 1) {
        if (isDefault) {
          def1 = clsnTarget.boxes;
          defHere1 = true;
        } else {
          next1 = clsnTarget.boxes;
          if (defHere1) def1 = next1;
        }
      } else {
        if (isDefault) {
          def2 = clsnTarget.boxes;
          defHere2 = true;
        } else {
          next2 = clsnTarget.boxes;
          if (defHere2) def2 = next2;
        }
      }
      continue;
    }
    const bm = CLSN_BOX_RE.exec(line);
    if (bm) {
      const p = bm[2]!.split(',');
      const box = { x1: int(p[0], 0), y1: int(p[1], 0), x2: int(p[2], 0), y2: int(p[3], 0) };
      // Normalize so x1<=x2, y1<=y2 (MUGEN accepts boxes in any corner order).
      if (box.x1 > box.x2) [box.x1, box.x2] = [box.x2, box.x1];
      if (box.y1 > box.y2) [box.y1, box.y2] = [box.y2, box.y1];
      const target = bm[1] === '1' ? (next1 ?? def1) : (next2 ?? def2);
      target?.push(box);
      continue;
    }
    if (/^loopstart\b/i.test(line)) {
      setLoopStart = true;
      continue;
    }
    const im = INTERP_RE.exec(line);
    if (im) {
      const k = im[1]!.toLowerCase() as keyof typeof pendingInterp;
      if (cur.elements.length === 0) interpBeforeFirst[k] = true;
      else pendingInterp[k] = true;
      continue;
    }

    // Animation element: group, number, x, y, time[, flip[, blend[, xs, ys[, angle]]]]
    if (!/^-?\d/.test(line)) continue;
    const p = line.split(',');
    if (p.length < 5) continue;
    const flip = (p[5] ?? '').trim().toUpperCase();
    const el: AnimElement = {
      group: int(p[0], 0),
      number: int(p[1], 0),
      x: int(p[2], 0),
      y: int(p[3], 0),
      time: int(p[4], 0),
      flipH: flip.includes('H'),
      flipV: flip.includes('V'),
      blend: parseBlend(p[6]),
      scaleX: num(p[7], 1),
      scaleY: num(p[8], 1),
      angle: num(p[9], 0),
      clsn1: next1 ?? def1,
      clsn2: next2 ?? def2,
      interp: { offset: false, blend: false, scale: false, angle: false },
    };
    // Interpolate lines between two elements belong to the earlier element.
    const prev = cur.elements[cur.elements.length - 1];
    if (prev) prev.interp = pendingInterp;
    pendingInterp = { offset: false, blend: false, scale: false, angle: false };
    if (setLoopStart) {
      cur.loopStart = cur.elements.length;
      setLoopStart = false;
    }
    cur.elements.push(el);
    next1 = next2 = null;
    defHere1 = defHere2 = false;
    clsnTarget = null;
  }
  closeAction();
  return anims;
}
