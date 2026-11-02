// CMD command definitions and input matching.
//
// Syntax (KFM's kfm.cmd): steps separated by commas, each step one or more
// elements joined with '+'. Modifiers: '/' hold, '~' release (optional charge
// ticks: ~30), '$' direction including diagonals, '>' no other input between
// this step and the previous one. Directions: B DB D DF F UF U UB.
// Buttons: a b c x y z s.
//
// The matcher searches the input history backwards. Exact MUGEN timing rules
// still have to be confirmed against the reference binary.

import { parseIni, getValue, findSection, unquote } from '../formats/text';

// Input bits (absolute directions; F/B are resolved with facing at match time).
export const IN_U = 1;
export const IN_D = 2;
export const IN_L = 4;
export const IN_R = 8;
export const IN_A = 16;
export const IN_B = 32;
export const IN_C = 64;
export const IN_X = 128;
export const IN_Y = 256;
export const IN_Z = 512;
export const IN_S = 1024;
const DIR_MASK = IN_U | IN_D | IN_L | IN_R;
const BUTTONS: Record<string, number> = { a: IN_A, b: IN_B, c: IN_C, x: IN_X, y: IN_Y, z: IN_Z, s: IN_S };

/** Relative direction bits used inside commands. */
const R_U = 1;
const R_D = 2;
const R_B = 4;
const R_F = 8;
// Case matters: uppercase B is "back", lowercase b is the button.
const DIRS: Record<string, number> = { U: R_U, D: R_D, B: R_B, F: R_F, UB: R_U | R_B, UF: R_U | R_F, DB: R_D | R_B, DF: R_D | R_F };

interface Element {
  /** Relative direction bits (0 if this element is a button). */
  dir: number;
  /** Button bit (0 if direction). */
  button: number;
  /** '$': any direction containing `dir`. */
  loose: boolean;
}

interface Step {
  elements: Element[];
  hold: boolean;
  release: boolean;
  /** Minimum ticks held before a release ('~30'). */
  charge: number;
  strict: boolean;
}

export interface Command {
  name: string;
  steps: Step[];
  time: number;
  bufferTime: number;
}

export interface CommandSet {
  commands: Command[];
  /** Lowercased names, for validating `command = "x"` triggers. */
  names: Set<string>;
}

export function parseCmd(text: string): CommandSet {
  const doc = parseIni(text);
  const defaults = findSection(doc, 'Defaults');
  const defTime = parseInt(getValue(defaults, 'command.time') ?? '15', 10) || 15;
  const defBuffer = parseInt(getValue(defaults, 'command.buffer.time') ?? '1', 10) || 1;
  const commands: Command[] = [];
  for (const sec of doc.sections) {
    if (sec.name.toLowerCase() !== 'command') continue;
    const name = unquote(getValue(sec, 'name') ?? '');
    const src = getValue(sec, 'command');
    if (!name || !src) continue;
    const steps = parseSteps(src);
    if (!steps.length) continue;
    commands.push({
      name: name.toLowerCase(),
      steps,
      time: Math.max(1, parseInt(getValue(sec, 'time') ?? '', 10) || defTime),
      bufferTime: Math.max(1, Math.min(30, parseInt(getValue(sec, 'buffer.time') ?? '', 10) || defBuffer)),
    });
  }
  return { commands, names: new Set(commands.map((c) => c.name)) };
}

function parseSteps(src: string): Step[] {
  const steps: Step[] = [];
  for (const raw of src.split(',')) {
    let s = raw.trim();
    if (!s) continue;
    const step: Step = { elements: [], hold: false, release: false, charge: 0, strict: false };
    for (;;) {
      if (s.startsWith('>')) step.strict = true;
      else if (s.startsWith('/')) step.hold = true;
      else if (s.startsWith('~')) {
        step.release = true;
        const m = /^~(\d+)/.exec(s);
        if (m) {
          step.charge = parseInt(m[1]!, 10);
          s = s.slice(m[0].length);
          continue;
        }
      } else break;
      s = s.slice(1).trimStart();
    }
    for (let part of s.split('+')) {
      part = part.trim();
      let loose = false;
      while (part.startsWith('$') || part.startsWith('/') || part.startsWith('~') || part.startsWith('>')) {
        if (part[0] === '$') loose = true;
        else if (part[0] === '/') step.hold = true;
        else if (part[0] === '~') step.release = true;
        else step.strict = true;
        part = part.slice(1).trim();
      }
      if (DIRS[part] !== undefined) step.elements.push({ dir: DIRS[part]!, button: 0, loose });
      else if (DIRS[part.toUpperCase()] !== undefined && part.length > 1) step.elements.push({ dir: DIRS[part.toUpperCase()]!, button: 0, loose });
      else if (BUTTONS[part] !== undefined) step.elements.push({ dir: 0, button: BUTTONS[part]!, loose: false });
    }
    if (step.elements.length) steps.push(step);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Matching

/** Ring buffer of raw input bits, one entry per tick (index 0 = most recent). */
export class InputHistory {
  private buf: Int32Array;
  private head = 0;
  private count = 0;

  constructor(readonly size = 128) {
    this.buf = new Int32Array(size);
  }

  push(bits: number): void {
    // Opposite directions cancel out, as on a real stick.
    if ((bits & (IN_L | IN_R)) === (IN_L | IN_R)) bits &= ~(IN_L | IN_R);
    if ((bits & (IN_U | IN_D)) === (IN_U | IN_D)) bits &= ~(IN_U | IN_D);
    this.head = (this.head + 1) % this.size;
    this.buf[this.head] = bits;
    this.count = Math.min(this.count + 1, this.size);
  }

  /** Input `ago` ticks back (0 = current tick). Ticks before the start are 0. */
  at(ago: number): number {
    if (ago >= this.count) return 0;
    return this.buf[(this.head - ago + this.size * 2) % this.size]!;
  }

  get length(): number {
    return this.count;
  }
}

function relDir(bits: number, facing: number): number {
  let r = 0;
  if (bits & IN_U) r |= R_U;
  if (bits & IN_D) r |= R_D;
  if (bits & (facing >= 0 ? IN_R : IN_L)) r |= R_F;
  if (bits & (facing >= 0 ? IN_L : IN_R)) r |= R_B;
  return r;
}

function elementOn(e: Element, bits: number, facing: number): boolean {
  if (e.button) return (bits & e.button) !== 0;
  const d = relDir(bits & DIR_MASK, facing);
  return e.loose ? (d & e.dir) === e.dir : d === e.dir;
}

/** Is step satisfied at tick `ago`? */
function stepAt(step: Step, h: InputHistory, ago: number, facing: number): boolean {
  const cur = h.at(ago);
  const prev = h.at(ago + 1);
  if (step.hold) return step.elements.every((e) => elementOn(e, cur, facing));
  if (step.release) {
    if (!step.elements.every((e) => !elementOn(e, cur, facing) && elementOn(e, prev, facing))) return false;
    if (step.charge > 0) {
      for (let k = 1; k <= step.charge; k++) {
        if (!step.elements.every((e) => elementOn(e, h.at(ago + k), facing))) return false;
      }
    }
    return true;
  }
  // Press: all elements down now, at least one newly pressed this tick.
  if (!step.elements.every((e) => elementOn(e, cur, facing))) return false;
  return step.elements.some((e) => !elementOn(e, prev, facing));
}

function sameStep(a: Step, b: Step): boolean {
  if (a.hold !== b.hold || a.release !== b.release || a.elements.length !== b.elements.length) return false;
  return a.elements.every((e, i) => {
    const f = b.elements[i]!;
    return e.dir === f.dir && e.button === f.button && e.loose === f.loose;
  });
}

function anyPressBetween(h: InputHistory, from: number, to: number): boolean {
  // Ticks strictly after `from` (older) and before `to` (newer), in "ago" units.
  for (let ago = to + 1; ago < from; ago++) {
    const newly = h.at(ago) & ~h.at(ago + 1);
    if (newly) return true;
  }
  return false;
}

export function commandActive(cmd: Command, h: InputHistory, facing: number): boolean {
  const steps = cmd.steps;
  const last = steps.length - 1;
  for (let end = 0; end < cmd.bufferTime && end < h.length; end++) {
    if (!stepAt(steps[last]!, h, end, facing)) continue;
    if (matchFrom(cmd, h, facing, last - 1, end, end)) return true;
  }
  return false;
}

/** Match steps[i..0] at ticks older than `newer`, all within cmd.time of `end`. */
function matchFrom(cmd: Command, h: InputHistory, facing: number, i: number, newer: number, end: number): boolean {
  if (i < 0) return true;
  const step = cmd.steps[i]!;
  const limit = end + cmd.time;
  // Different steps may complete on the same tick (e.g. "~D, DF": releasing D
  // by rolling into DF); identical consecutive steps ("F, F") need two events.
  const same = sameStep(step, cmd.steps[i + 1]!);
  for (let ago = same ? newer + 1 : newer; ago < limit && ago < h.length; ago++) {
    if (!stepAt(step, h, ago, facing)) continue;
    if (cmd.steps[i + 1]!.strict && anyPressBetween(h, ago, newer)) continue;
    if (matchFrom(cmd, h, facing, i - 1, ago, end)) return true;
  }
  return false;
}

/** Names of all commands active this tick (MUGEN allows several entries per name). */
export function activeCommands(set: CommandSet, h: InputHistory, facing: number): Set<string> {
  const out = new Set<string>();
  for (const c of set.commands) {
    if (!out.has(c.name) && commandActive(c, h, facing)) out.add(c.name);
  }
  return out;
}
