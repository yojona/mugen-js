// Function-type triggers (trigger.html) bound to the Player runtime.

import { BOTTOM, CompileError, compileNode, FLOAT, INT, R, relFn, toInt, type Fn, type TriggerEnv, type VarKind } from '../expr/compile';
import type { CallNode, ClauseNode } from '../expr/parser';
import { isFloatConst } from './cns';
import type { Player } from './player';

type P = Player;
const int = (f: (p: P) => number): Fn<P> => (p) => ((R.t = INT), f(p) | 0);
const flt = (f: (p: P) => number): Fn<P> => (p) => ((R.t = FLOAT), Math.fround(f(p)));
const bottom = (): number => ((R.t = BOTTOM), 0);

/** Evaluate an argument as int; returns undefined on bottom. */
function argInt(fn: Fn<P>, p: P): number | undefined {
  const v = fn(p);
  if (R.t === BOTTOM) return undefined;
  return R.t === FLOAT ? toInt(v) : v;
}
function argNum(fn: Fn<P>, p: P): number | undefined {
  const v = fn(p);
  return R.t === BOTTOM ? undefined : v;
}

/** Triggers without arguments. */
const NULLARY: Record<string, Fn<P>> = {
  time: int((p) => p.time),
  statetime: int((p) => p.time),
  anim: int((p) => p.animNo),
  animtime: int((p) => p.anim.animTime()),
  alive: int((p) => (p.alive ? 1 : 0)),
  ctrl: int((p) => (p.ctrl ? 1 : 0)),
  stateno: int((p) => p.stateNo),
  prevstateno: int((p) => p.prevStateNo),
  facing: int((p) => p.facing),
  life: int((p) => p.life),
  lifemax: int((p) => p.const('data.life')),
  power: int((p) => p.power),
  powermax: int((p) => p.const('data.power')),
  palno: int((p) => p.palNo),
  id: int((p) => p.id),
  ishelper: int(() => 0),
  teamside: int((p) => p.side + 1),
  gametime: int((p) => p.world.gameTime),
  random: int((p) => p.world.random(1000)),
  roundstate: int((p) => p.world.roundState),
  roundno: int((p) => p.world.roundNo),
  matchno: int(() => 1),
  roundsexisted: int(() => 0),
  matchover: int(() => 0),
  win: int(() => 0),
  lose: int(() => 0),
  drawgame: int(() => 0),
  ailevel: int(() => 0),
  ticksperSecond: int(() => 60),
  tickspersecond: int(() => 60),
  numenemy: int((p) => (p.world.enemyOf(p) ? 1 : 0)),
  numpartner: int(() => 0),
  numtarget: int(() => 0),
  numexplod: int(() => 0),
  numproj: int(() => 0),
  numprojid: int(() => 0),
  numhelper: int(() => 0),
  hitcount: int(() => 0),
  uniqhitcount: int(() => 0),
  movecontact: int(() => 0),
  movehit: int(() => 0),
  moveguarded: int(() => 0),
  movereversed: int(() => 0),
  hitshakeover: int(() => 1),
  hitover: int(() => 1),
  hitfall: int(() => 0),
  hitpausetime: int(() => 0),
  canrecover: int(() => 0),
  inguarddist: int(() => 0),
  projcanceltime: int(() => -1),
  projcontacttime: int(() => -1),
  projguardedtime: int(() => -1),
  projhittime: int(() => -1),
  ishometeam: int((p) => (p.side === 0 ? 1 : 0)),
  p2life: (p) => {
    const e = p.world.enemyOf(p);
    return e ? ((R.t = INT), e.life) : bottom();
  },
  p2stateno: (p) => {
    const e = p.world.enemyOf(p);
    return e ? ((R.t = INT), e.stateNo) : bottom();
  },
  // Screen / stage geometry (world units; see World).
  gamewidth: flt((p) => p.world.screenWidth),
  gameheight: flt((p) => p.world.screenHeight),
  screenwidth: flt((p) => p.world.screenWidth),
  screenheight: flt((p) => p.world.screenHeight),
  leftedge: flt((p) => p.world.camera.x - p.world.screenWidth / 2),
  rightedge: flt((p) => p.world.camera.x + p.world.screenWidth / 2),
  topedge: flt((p) => p.world.camera.y),
  bottomedge: flt((p) => p.world.camera.y + p.world.screenHeight),
  frontedge: flt((p) => (p.facing > 0 ? p.world.camera.x + p.world.screenWidth / 2 : p.world.camera.x - p.world.screenWidth / 2)),
  backedge: flt((p) => (p.facing > 0 ? p.world.camera.x - p.world.screenWidth / 2 : p.world.camera.x + p.world.screenWidth / 2)),
  frontedgedist: int((p) => Math.trunc(p.world.edgeDist(p, true))),
  backedgedist: int((p) => Math.trunc(p.world.edgeDist(p, false))),
  frontedgebodydist: int((p) => Math.trunc(p.world.edgeDist(p, true) - p.const('size.ground.front'))),
  backedgebodydist: int((p) => Math.trunc(p.world.edgeDist(p, false) - p.const('size.ground.back'))),
  camerazoom: flt(() => 1),
};

/** Vector triggers selected with an axis word. */
const AXIS: Record<string, (p: P, axis: 'x' | 'y' | 'z') => number | undefined> = {
  pos: (p, a) => (a === 'x' ? p.pos.x - p.world.camera.x : a === 'y' ? p.pos.y : 0),
  vel: (p, a) => (a === 'x' ? p.vel.x : a === 'y' ? p.vel.y : 0),
  hitvel: () => 0,
  screenpos: (p, a) => (a === 'x' ? p.pos.x - (p.world.camera.x - p.world.screenWidth / 2) : a === 'y' ? p.pos.y - p.world.camera.y + p.world.groundY : 0),
  camerapos: (p, a) => (a === 'x' ? p.world.camera.x : a === 'y' ? p.world.camera.y : 0),
  p2dist: (p, a) => {
    const e = p.world.enemyOf(p);
    if (!e) return undefined;
    return a === 'x' ? (e.pos.x - p.pos.x) * p.facing : a === 'y' ? e.pos.y - p.pos.y : 0;
  },
  p2bodydist: (p, a) => {
    const e = p.world.enemyOf(p);
    if (!e) return undefined;
    if (a !== 'x') return a === 'y' ? e.pos.y - p.pos.y : 0;
    const dx = (e.pos.x - p.pos.x) * p.facing;
    const front = p.stateType === 'a' ? p.const('size.air.front') : p.const('size.ground.front');
    const eFacesUs = e.facing !== p.facing;
    const eBack = e.stateType === 'a' ? (eFacesUs ? e.const('size.air.front') : e.const('size.air.back')) : eFacesUs ? e.const('size.ground.front') : e.const('size.ground.back');
    return dx - front - eBack;
  },
  parentdist: () => undefined,
  rootdist: () => undefined,
};

/** Axis triggers whose result is an int (trigger.html). */
const AXIS_INT = new Set(['p2dist', 'p2bodydist']);

function call(node: CallNode, args: Fn<P>[]): Fn<P> | undefined {
  const name = node.name;
  if (node.axis) {
    const f = AXIS[name];
    if (!f) return undefined;
    const axis = node.axis;
    const isInt = AXIS_INT.has(name);
    return (p) => {
      const v = f(p, axis);
      if (v === undefined) return bottom();
      if (isInt) {
        R.t = INT;
        return Math.trunc(v) | 0;
      }
      R.t = FLOAT;
      return Math.fround(v);
    };
  }
  if (node.word !== undefined) {
    const w = node.word;
    if (name === 'const') {
      const isF = isFloatConst(w);
      return (p) => {
        const v = p.prog.consts.get(w);
        if (v === undefined) return bottom();
        if (isF) return (R.t = FLOAT), Math.fround(v);
        return (R.t = INT), Math.trunc(v) | 0;
      };
    }
    if (name === 'gethitvar') return int(() => 0);
    if (name === 'stagevar') return int(() => 0);
    return undefined;
  }
  if (args.length === 0) return NULLARY[name];

  const a = args[0]!;
  switch (name) {
    case 'animelemtime':
      return (p) => {
        const n = argInt(a, p);
        const v = n === undefined ? undefined : p.anim.animElemTime(n);
        return v === undefined ? bottom() : ((R.t = INT), v);
      };
    case 'animelemno':
      return (p) => {
        const n = argInt(a, p);
        const v = n === undefined ? undefined : p.anim.animElemNo(n);
        return v === undefined ? bottom() : ((R.t = INT), v);
      };
    case 'animexist':
    case 'selfanimexist':
      return (p) => {
        const n = argInt(a, p);
        return n === undefined ? bottom() : ((R.t = INT), p.hasAnim(n) ? 1 : 0);
      };
    case 'const240p':
    case 'const480p':
    case 'const720p': {
      const base = name === 'const240p' ? 320 : name === 'const480p' ? 640 : 1280;
      return (p) => {
        const v = argNum(a, p);
        if (v === undefined) return bottom();
        R.t = FLOAT;
        return Math.fround((v * p.prog.data.def.localCoord[0]) / base);
      };
    }
    case 'numhelper':
    case 'numexplod':
    case 'numproj':
    case 'numprojid':
    case 'numtarget':
    case 'playeridexist':
    case 'ishelper':
      return (p) => (argNum(a, p) === undefined ? bottom() : ((R.t = INT), 0));
    case 'projcontacttime':
    case 'projguardedtime':
    case 'projhittime':
      return (p) => (argNum(a, p) === undefined ? bottom() : ((R.t = INT), -1));
  }
  return undefined;
}

function clause(node: ClauseNode, nums: Fn<P>[]): Fn<P> | undefined {
  const eq = node.op === '=';
  const word = node.words[0] ?? '';
  const boolOut = (f: (p: P) => boolean): Fn<P> => (p) => ((R.t = INT), f(p) === eq ? 1 : 0);
  switch (node.name) {
    case 'command':
      return boolOut((p) => p.commands.has(word.toLowerCase()));
    case 'statetype':
      return boolOut((p) => p.stateType === word[0]);
    case 'movetype':
      return boolOut((p) => p.moveType === word[0]);
    case 'p2statetype':
      return (p) => {
        const e = p.world.enemyOf(p);
        return e ? ((R.t = INT), (e.stateType === word[0]) === eq ? 1 : 0) : bottom();
      };
    case 'p2movetype':
      return (p) => {
        const e = p.world.enemyOf(p);
        return e ? ((R.t = INT), (e.moveType === word[0]) === eq ? 1 : 0) : bottom();
      };
    case 'name':
    case 'p1name':
      return boolOut((p) => p.name.toLowerCase() === word.toLowerCase());
    case 'p2name':
      return boolOut((p) => p.world.enemyOf(p)?.name.toLowerCase() === word.toLowerCase());
    case 'p3name':
    case 'p4name':
      return boolOut(() => false);
    case 'authorname':
      return boolOut((p) => p.prog.data.def.author.toLowerCase() === word.toLowerCase());
    case 'teammode':
      return boolOut(() => word === 'single');
    case 'hitdefattr':
      return boolOut(() => false);
    case 'stagevar':
      return boolOut(() => false);
    case 'timemod': {
      const [div, val] = nums as [Fn<P>, Fn<P>];
      const cmp = relFn(node.op);
      return (p) => {
        const d = argInt(div, p);
        const v = argInt(val, p);
        if (d === undefined || v === undefined || d === 0) return bottom();
        R.t = INT;
        return cmp(p.time % d, v) ? 1 : 0;
      };
    }
    case 'animelem': {
      const n = nums[0]!;
      const second = node.second;
      const secondFn = second ? compileSecond(second.value) : undefined;
      const outer = relFn(node.op);
      return (p) => {
        const el = argInt(n, p);
        if (el === undefined) return bottom();
        const t = p.anim.animElemTime(el);
        if (t === undefined) return bottom();
        R.t = INT;
        if (!second) {
          // Format 1: true on the first tick of element `el` (first pass only).
          const hit = t === 0;
          return outer(hit ? 1 : 0, 1) ? 1 : 0;
        }
        const v = argInt(secondFn!, p);
        if (v === undefined) return bottom();
        R.t = INT;
        return relFn(second.op)(t, v) ? 1 : 0;
      };
    }
    case 'projcontact':
    case 'projguarded':
    case 'projhit':
      // Projectiles are not simulated yet: never hit/contacted/guarded.
      return () => ((R.t = INT), eq ? 0 : 1);
  }
  return undefined;
}

/** The optional second value of an AnimElem clause arrives as an AST. */
function compileSecond(node: ClauseNode['nums'][number]): Fn<P> {
  return compileNode(node, playerEnv);
}

function redirect(p: P, to: string, _id: number | undefined): P | undefined {
  switch (to) {
    case 'root':
      return p;
    case 'enemy':
    case 'enemynear':
      return p.world.enemyOf(p);
    case 'playerid':
      return p.world.players.find((q) => q.id === _id);
  }
  return undefined;
}

function varArray(p: P, kind: VarKind): Int32Array | Float32Array {
  switch (kind) {
    case 'var':
      return p.vars;
    case 'fvar':
      return p.fvars;
    case 'sysvar':
      return p.sysVars;
    case 'sysfvar':
      return p.sysFvars;
  }
}

export const playerEnv: TriggerEnv<P> = {
  call,
  clause,
  redirect,
  getVar(p, kind, i) {
    const arr = varArray(p, kind);
    if (i < 0 || i >= arr.length) return bottom();
    R.t = arr instanceof Float32Array ? FLOAT : INT;
    return arr[i]!;
  },
  setVar(p, kind, i, v) {
    const arr = varArray(p, kind);
    if (i < 0 || i >= arr.length) return false;
    arr[i] = v;
    return true;
  },
};

export { CompileError };
