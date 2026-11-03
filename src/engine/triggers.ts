// Function-type triggers (trigger.html) bound to the Player runtime.

import { hitDefAttrBits } from './hitdef';
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
  roundsexisted: int((p) => p.roundsExisted),
  matchover: int(() => 0),
  // Win / lose by kind (mugen.exe Trigger_Eval: win_type and round winner side).
  win: int((p) => (p.world.winType !== 0 && p.world.roundWinnerSide === p.root.side + 1 ? 1 : 0)),
  winko: int((p) => (p.world.winType === 1 && p.world.roundWinnerSide === p.root.side + 1 ? 1 : 0)),
  wintime: int((p) => (p.world.winType === 2 && p.world.roundWinnerSide === p.root.side + 1 ? 1 : 0)),
  lose: int((p) => (p.world.winType !== 0 && p.world.roundWinnerSide !== 0 && p.world.roundWinnerSide !== p.root.side + 1 ? 1 : 0)),
  loseko: int((p) => (p.world.winType === 1 && p.world.roundWinnerSide !== 0 && p.world.roundWinnerSide !== p.root.side + 1 ? 1 : 0)),
  losetime: int((p) => (p.world.winType === 2 && p.world.roundWinnerSide !== 0 && p.world.roundWinnerSide !== p.root.side + 1 ? 1 : 0)),
  winperfect: int((p) => (p.world.winType !== 0 && p.world.roundWinnerSide === p.root.side + 1 && p.world.players.every((q) => q.side !== p.root.side || q.life >= q.const('data.life')) ? 1 : 0)),
  drawgame: int((p) => (p.world.winType !== 0 && p.world.roundWinnerSide === 0 ? 1 : 0)),
  // CPU players report their AI level, humans 0 (mugen.exe 0x456dc8).
  ailevel: int((p) => p.root.ai?.level ?? 0),
  ticksperSecond: int(() => 60),
  tickspersecond: int(() => 60),
  numenemy: int((p) => (p.world.enemyOf(p) ? 1 : 0)),
  numpartner: int(() => 0),
  numtarget: int((p) => (p.hitTargets.size > 0 && p.hitCount > 0 ? p.hitTargets.size : 0)),
  numexplod: int((p) => p.world.explods.filter((e) => e.owner === p).length),
  // Only live projectiles (state 1), not ones playing their hit/remove anim.
  numproj: int((p) => p.world.projectiles.filter((pr) => pr.owner === p && pr.phase === 'active').length),
  numhelper: int((p) => p.world.helpersOf(p).length),
  hitcount: int((p) => p.hitCount),
  uniqhitcount: int((p) => p.hitCount),
  movecontact: int((p) => p.moveContact),
  movehit: int((p) => p.moveHit),
  moveguarded: int((p) => p.moveGuarded),
  movereversed: int(() => 0),
  hitshakeover: int((p) => (p.ghv.hitshaketime <= 0 ? 1 : 0)),
  // mugen.exe 0x4574d8: hittime < 0.
  hitover: int((p) => (p.ghv.hittime < 0 ? 1 : 0)),
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
  // Screen / stage geometry, converted from world units to the player's units.
  gamewidth: flt((p) => p.world.screenWidth / p.scale),
  gameheight: flt((p) => p.world.screenHeight / p.scale),
  screenwidth: flt((p) => p.world.screenWidth / p.scale),
  screenheight: flt((p) => p.world.screenHeight / p.scale),
  leftedge: flt((p) => (p.world.camera.x - p.world.screenWidth / 2) / p.scale),
  rightedge: flt((p) => (p.world.camera.x + p.world.screenWidth / 2) / p.scale),
  topedge: flt((p) => p.world.camera.y / p.scale),
  bottomedge: flt((p) => (p.world.camera.y + p.world.screenHeight) / p.scale),
  frontedge: flt((p) => (p.facing > 0 ? p.world.camera.x + p.world.screenWidth / 2 : p.world.camera.x - p.world.screenWidth / 2) / p.scale),
  backedge: flt((p) => (p.facing > 0 ? p.world.camera.x - p.world.screenWidth / 2 : p.world.camera.x + p.world.screenWidth / 2) / p.scale),
  frontedgedist: int((p) => Math.trunc(p.world.edgeDist(p, true))),
  backedgedist: int((p) => Math.trunc(p.world.edgeDist(p, false))),
  // mugen.exe 0x4343d0: measured to the player's screen limit (stage
  // screenleft/right plus Width edge), minus 1 in the air and 2 lying down.
  frontedgebodydist: int((p) => Math.trunc(p.world.edgeBodyDist(p, true))),
  backedgebodydist: int((p) => Math.trunc(p.world.edgeBodyDist(p, false))),
  camerazoom: flt(() => 1),
};

/** Vector triggers selected with an axis word. */
const AXIS: Record<string, (p: P, axis: 'x' | 'y' | 'z') => number | undefined> = {
  // Pos X is relative to the camera centre (trigger.html), in the player's units.
  pos: (p, a) => (a === 'x' ? p.pos.x - p.world.camera.x / p.scale : a === 'y' ? p.pos.y : 0),
  vel: (p, a) => (a === 'x' ? p.vel.x : a === 'y' ? p.vel.y : 0),
  hitvel: (p, a) => (a === 'x' ? p.ghv.xvel : a === 'y' ? p.ghv.yvel : 0),
  screenpos: (p, a) => (a === 'x' ? (p.wx - (p.world.camera.x - p.world.screenWidth / 2)) / p.scale : a === 'y' ? (p.wy - p.world.camera.y + p.world.groundY) / p.scale : 0),
  camerapos: (p, a) => (a === 'x' ? p.world.camera.x / p.scale : a === 'y' ? p.world.camera.y / p.scale : 0),
  p2dist: (p, a) => {
    const e = p.world.enemyOf(p);
    if (!e) return undefined;
    return a === 'x' ? ((e.wx - p.wx) * p.facing) / p.scale : a === 'y' ? (e.wy - p.wy) / p.scale : 0;
  },
  p2bodydist: (p, a) => {
    const e = p.world.enemyOf(p);
    if (!e) return undefined;
    if (a !== 'x') return a === 'y' ? (e.wy - p.wy) / p.scale : 0;
    // Player_BodyDistX (0x4346xx): from p's front edge to the opponent's
    // front edge when p is in front of it, else (level included) its back edge.
    const f = Math.fround;
    const front = f((p.stateType === 'a' ? p.const('size.air.front') : p.const('size.ground.front')) * p.scale * p.facing + p.wx);
    const side = f((p.wx - e.wx) * e.facing);
    const eEdge =
      side > 0
        ? f((e.stateType === 'a' ? e.const('size.air.front') : e.const('size.ground.front')) * e.scale * e.facing + e.wx)
        : f(e.wx - (e.stateType === 'a' ? e.const('size.air.back') : e.const('size.ground.back')) * e.scale * e.facing);
    return f((eEdge - front) * p.facing) / p.scale;
  },
  parentdist: (p, a) => (p.parent ? (a === 'x' ? ((p.parent.wx - p.wx) * p.facing) / p.scale : a === 'y' ? (p.parent.wy - p.wy) / p.scale : 0) : undefined),
  rootdist: (p, a) => (p.isHelper ? (a === 'x' ? ((p.root.wx - p.wx) * p.facing) / p.scale : a === 'y' ? (p.root.wy - p.wy) / p.scale : 0) : undefined),
};

/** Axis triggers whose result is an int (trigger.html). */
// MUGEN 1.1 returns floats for P2Dist / P2BodyDist (measured: 224.55).
const AXIS_INT = new Set<string>();

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
        return id === undefined ? bottom() : ((R.t = INT), p.world.projectiles.filter((pr) => pr.owner === p && pr.phase === 'active' && pr.projId === (id < 0 ? 0 : id)).length);
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

const slotCache = new WeakMap<object, Map<string, number>>();
/** The command's number in MUGEN's command buffer. */
function commandSlot(p: P, name: string): number {
  const set = p.prog.cmd;
  let m = slotCache.get(set);
  if (!m) {
    m = new Map();
    for (const c of set.commands) if (!m.has(c.name)) m.set(c.name, c.slot);
    slotCache.set(set, m);
  }
  return m.get(name) ?? -1;
}

function clause(node: ClauseNode, nums: Fn<P>[]): Fn<P> | undefined {
  const eq = node.op === '=';
  const word = node.words[0] ?? '';
  const boolOut = (f: (p: P) => boolean): Fn<P> => (p) => ((R.t = INT), f(p) === eq ? 1 : 0);
  switch (node.name) {
    case 'command': {
      const name = word.toLowerCase();
      // An active command tested with "=" is noted for the AI recorder
      // (mugen.exe 0x456d9f; measured: common1's command != "holdback" exit
      // from 130 sends no message).
      return boolOut((p) => {
        if (!p.commands.has(name)) return false;
        const fired = p.recorder?.fired;
        if (eq && fired && fired.length < 9) fired.push(commandSlot(p, name));
        return true;
      });
    }
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
      // mugen.exe: attack only, and the HitDef's attr must share a state bit
      // and a type bit with the trigger's (bits from HitDefAttr_Parse).
      const want = node.bits ?? 0;
      return (p) => {
        R.t = INT;
        const hd = p.hitDef;
        let v = 0;
        if (hd && p.moveType === 'a') {
          const b = hitDefAttrBits(hd.attrState, hd.attrType) & want;
          v = (b & 7) !== 0 && (b & ~7) !== 0 ? 1 : 0;
        }
        return eq ? v : 1 - v;
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
      const secondFn = second ? compileSecond(second) : undefined;
      const outer = relFn(node.op);
      return (p) => {
        const el = argInt(n, p);
        if (el === undefined) return bottom();
        const t = p.anim.animElemTime(el);
        if (t === undefined) return bottom();
        R.t = INT;
        if (!second) {
          // No comparison: "[0, 0]", true on the element's first tick.
          const hit = t === 0;
          return outer(hit ? 1 : 0, 1) ? 1 : 0;
        }
        const r = secondFn!(p, t);
        if (r === undefined) return bottom();
        R.t = INT;
        return r ? 1 : 0;
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
      const secondFn = second ? compileSecond(second) : undefined;
      return (p) => {
        const v = argInt(want, p);
        if (v === undefined) return bottom();
        const t = projTime(p, node.id ?? 0, kind);
        // No comparison means "[0, 0]": the contact happened this tick.
        let happened = t >= 0;
        if (happened) {
          if (second) {
            const r = secondFn!(p, t);
            if (r === undefined) return bottom();
            happened = r;
          } else happened = t === 0;
        }
        R.t = INT;
        return happened === ((v !== 0) === eq) ? 1 : 0;
      };
    }
  }
  return undefined;
}

/** The optional comparison of an AnimElem / ProjHit clause: a relation or a range. */
function compileSecond(second: NonNullable<ClauseNode['second']>): (p: P, t: number) => boolean | undefined {
  const a = compileNode(second.value, playerEnv);
  const rel = relFn(second.op);
  if (!second.value2) {
    return (p, t) => {
      const v = argInt(a, p);
      return v === undefined ? undefined : rel(t, v);
    };
  }
  const b = compileNode(second.value2, playerEnv);
  const { loOpen, hiOpen } = second;
  return (p, t) => {
    const lo = argInt(a, p);
    const hi = argInt(b, p);
    if (lo === undefined || hi === undefined) return undefined;
    return (loOpen ? t > lo : t >= lo) && (hiOpen ? t < hi : t <= hi);
  };
}


/**
 * ProjHitTime & co. (mugen.exe Trigger_Eval): ticks since the last contact if
 * it is of that kind (contact = hit or guarded) and from that ID (0 = any), else -1.
 */
function projTime(p: P, id: number, kind: 'hit' | 'contact' | 'guarded' | 'cancel'): number {
  const c = p.projContact;
  const ok = kind === 'contact' ? c === 1 || c === 2 : c === (kind === 'hit' ? 2 : kind === 'cancel' ? 3 : 1);
  if (!ok || (id !== 0 && p.projContactId !== id)) return -1;
  return p.projContactTime;
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
