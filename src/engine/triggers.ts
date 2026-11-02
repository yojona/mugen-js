// Function-type triggers (trigger.html) bound to the Player runtime.

import { BOTTOM, CompileError, compileNode, FLOAT, INT, R, relFn, toInt, type Fn, type TriggerEnv, type VarKind } from '../expr/compile';
import type { CallNode, ClauseNode } from '../expr/parser';
import { isFloatConst } from './cns';
import { emptyGetHitVars, GETHITVAR_FLOATS, type GetHitVars } from './hitdef';
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
  ishelper: int((p) => (p.isHelper ? 1 : 0)),
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
  numtarget: int((p) => (p.hitTargets.size > 0 && p.hitCount > 0 ? p.hitTargets.size : 0)),
  numexplod: int((p) => p.world.explods.filter((e) => e.owner === p).length),
  numproj: int((p) => p.world.projectiles.filter((pr) => pr.owner === p && pr.phase !== 'dead').length),
  numhelper: int((p) => p.world.helpersOf(p).length),
  hitcount: int((p) => p.hitCount),
  uniqhitcount: int((p) => p.hitCount),
  movecontact: int((p) => p.moveContact),
  movehit: int((p) => p.moveHit),
  moveguarded: int((p) => p.moveGuarded),
  movereversed: int(() => 0),
  hitshakeover: int((p) => (p.ghv.hitshaketime <= 0 ? 1 : 0)),
  hitover: int((p) => (p.ghv.hittime <= 0 ? 1 : 0)),
  hitfall: int((p) => p.ghv.fall),
  hitpausetime: int((p) => p.hitPause),
  canrecover: int((p) => (p.ghv.fall && p.ghv['fall.recover'] && p.ghv['fall.recovertime'] <= 0 ? 1 : 0)),
  inguarddist: int((p) => (p.inGuardDist() ? 1 : 0)),
  projcanceltime: int((p) => projTime(p, 0, 'cancel')),
  projcontacttime: int((p) => projTime(p, 0, 'contact')),
  projguardedtime: int((p) => projTime(p, 0, 'guarded')),
  projhittime: int((p) => projTime(p, 0, 'hit')),
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
  hitvel: (p, a) => (a === 'x' ? p.ghv.xvel : a === 'y' ? p.ghv.yvel : 0),
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
  parentdist: (p, a) => (p.parent ? (a === 'x' ? (p.parent.pos.x - p.pos.x) * p.facing : a === 'y' ? p.parent.pos.y - p.pos.y : 0) : undefined),
  rootdist: (p, a) => (p.isHelper ? (a === 'x' ? (p.root.pos.x - p.pos.x) * p.facing : a === 'y' ? p.root.pos.y - p.pos.y : 0) : undefined),
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
    if (name === 'gethitvar') {
      if (!(w in emptyGetHitVars())) throw new CompileError(`GetHitVar(${w}) desconocido`);
      // IsBound: currently held by an attacker's TargetBind.
      if (w === 'isbound') return int((p) => (p.bind?.byTarget ? 1 : 0));
      const key = w as keyof GetHitVars;
      const isF = GETHITVAR_FLOATS.has(w);
      return (p) => {
        const v = p.ghv[key];
        if (isF) return (R.t = FLOAT), Math.fround(Number.isNaN(v) ? 0 : v);
        return (R.t = INT), Math.trunc(v) | 0;
      };
    }
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
      return (p) => {
        const id = argInt(a, p);
        return id === undefined ? bottom() : ((R.t = INT), p.world.helpersOf(p, id).length);
      };
    case 'numexplod':
      return (p) => {
        const id = argInt(a, p);
        return id === undefined ? bottom() : ((R.t = INT), p.world.explods.filter((e) => e.owner === p && (id === -1 || e.id === id)).length);
      };
    case 'numproj':
    case 'numprojid':
      return (p) => {
        const id = argInt(a, p);
        return id === undefined ? bottom() : ((R.t = INT), p.world.projectiles.filter((pr) => pr.owner === p && pr.phase !== 'dead' && pr.projId === id).length);
      };
    case 'numtarget':
      return (p) => {
        const id = argInt(a, p);
        if (id === undefined) return bottom();
        R.t = INT;
        let n = 0;
        for (const tid of p.targets.values()) if (id === -1 || tid === id) n++;
        return n;
      };
    case 'playeridexist':
      return (p) => {
        const id = argInt(a, p);
        return id === undefined ? bottom() : ((R.t = INT), p.world.allPlayers().some((q) => q.id === id) ? 1 : 0);
      };
    case 'ishelper':
      return (p) => {
        const id = argInt(a, p);
        return id === undefined ? bottom() : ((R.t = INT), p.isHelper && p.helperId === id ? 1 : 0);
      };
    case 'projcanceltime':
    case 'projcontacttime':
    case 'projguardedtime':
    case 'projhittime': {
      const kind = name.slice(4, -4) as 'cancel' | 'contact' | 'guarded' | 'hit';
      return (p) => {
        const id = argInt(a, p);
        return id === undefined ? bottom() : ((R.t = INT), projTime(p, id, kind));
      };
    }
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
    case 'hitdefattr': {
      // HitDefAttr = SCA, NA, SA: state letters, then attack attributes.
      const states = node.words[0] ?? '';
      const types = node.words.slice(1);
      return (p) => {
        R.t = INT;
        const hd = p.hitDef;
        if (!hd || p.moveType !== 'a') return eq ? 0 : 1;
        const match = states.includes(hd.attrState) && (types.length === 0 || types.some((t) => t === hd.attrType || (t[0] === 'a' && t[1] === hd.attrType[1]) || (t[1] === 'a' && t[0] === hd.attrType[0])));
        return match === eq ? 1 : 0;
      };
    }
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
    case 'projhit': {
      // ProjHit[ID] = value [, op time]: true if a projectile (with that ID) hit,
      // optionally comparing the ticks since the hit.
      const kind = node.name === 'projhit' ? 'hit' : node.name === 'projcontact' ? 'contact' : 'guarded';
      const want = nums[0]!;
      const second = node.second;
      const secondFn = second ? compileSecond(second.value) : undefined;
      return (p) => {
        const v = argInt(want, p);
        if (v === undefined) return bottom();
        const t = projTime(p, node.id ?? 0, kind);
        let happened = t >= 0;
        if (happened && second) {
          const sv = argInt(secondFn!, p);
          if (sv === undefined) return bottom();
          happened = relFn(second.op)(t, sv);
        }
        R.t = INT;
        return happened === ((v !== 0) === eq) ? 1 : 0;
      };
    }
  }
  return undefined;
}

/** The optional second value of an AnimElem clause arrives as an AST. */
function compileSecond(node: ClauseNode['nums'][number]): Fn<P> {
  return compileNode(node, playerEnv);
}

/** Ticks since the last projectile event of a kind (-1 = never); id 0 = any. */
function projTime(p: P, id: number, kind: 'hit' | 'contact' | 'guarded' | 'cancel'): number {
  if (id !== 0) return p.projInfo.get(id)?.[kind] ?? -1;
  let best = -1;
  for (const info of p.projInfo.values()) {
    const t = info[kind];
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

function redirect(p: P, to: string, _id: number | undefined): P | undefined {
  switch (to) {
    case 'root':
      return p.root;
    case 'parent':
      return p.parent;
    case 'helper':
      return p.world.helpersOf(p, _id)[0];
    case 'target': {
      for (const [t, tid] of p.targets) if (_id === undefined || tid === _id) return t;
      return undefined;
    }
    case 'partner':
      return undefined;
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
