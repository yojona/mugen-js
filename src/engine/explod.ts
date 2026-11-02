// Explods (sctrls.html Explod, ModifyExplod, RemoveExplod, ExplodBindTime,
// GameMakeAnim, MakeDust): free-standing animations owned by a player.

import { BOTTOM, compileExprList, R, toInt, type Fn, type TriggerEnv } from '../expr/compile';
import type { Animation, Blend } from '../formats/air';
import { parseBlend } from '../formats/air';
import { AnimPlayer } from './anim';
import type { ControllerDef } from './cns';
import type { Player } from './player';

type P = Player;

export interface Explod {
  owner: P;
  id: number;
  anim: AnimPlayer;
  /** Sprites/anims from fightfx (true) or the owner's files. */
  common: boolean;
  space: 'stage' | 'screen';
  x: number;
  y: number;
  facing: number;
  vfacing: number;
  bindTo: P | undefined;
  bindTime: number;
  bindOffset: [number, number];
  vel: [number, number];
  accel: [number, number];
  removeTime: number;
  /** Ticks displayed so far. */
  age: number;
  scale: [number, number];
  angle: number;
  sprPriority: number;
  onTop: boolean;
  ownPal: boolean;
  removeOnGetHit: boolean;
  ignoreHitPause: boolean;
  trans: Blend | undefined;
  /** Sprite scale: the owner's unit scale (own files) or the fightfx scale. */
  drawScale: number;
  /** Set when created during a SuperPause/Pause: ticks it may still animate. */
  superMoveTime: number;
  pauseMoveTime: number;
}

/** Compiled parameter access shared by Explod / ModifyExplod. */
function params(c: ControllerDef, env: TriggerEnv<P>) {
  const cache = new Map<string, Fn<P>[]>();
  const list = (k: string, src?: string): Fn<P>[] => {
    const key = src === undefined ? k : `${k}#${src}`;
    let v = cache.get(key);
    if (!v) {
      const s = src ?? c.params.get(k);
      v = s === undefined || s.trim() === '' ? [] : compileExprList(s, env);
      cache.set(key, v);
    }
    return v;
  };
  const num = (p: P, k: string, i = 0, src?: string): number | undefined => {
    const fn = list(k, src)[i];
    if (!fn) return undefined;
    const v = fn(p);
    return R.t === BOTTOM ? undefined : v;
  };
  const int = (p: P, k: string, i = 0, src?: string) => {
    const v = num(p, k, i, src);
    return v === undefined ? undefined : toInt(v);
  };
  // Validate expressions eagerly.
  for (const k of ['id', 'pos', 'facing', 'vfacing', 'bindid', 'bindtime', 'vel', 'accel', 'removetime', 'scale', 'angle', 'sprpriority', 'ontop', 'ownpal', 'removeongethit', 'ignorehitpause', 'random', 'supermovetime', 'pausemovetime']) {
    if (c.params.has(k)) list(k);
  }
  return { list, num, int, has: (k: string) => c.params.has(k), raw: (k: string) => c.params.get(k)?.trim() };
}

/** Anim reference "F123" (fightfx) or "123" / expression. */
function animRef(c: ControllerDef, key: string, env: TriggerEnv<P>): { common: boolean; fn: Fn<P> } | undefined {
  const raw = c.params.get(key)?.trim();
  if (!raw) return undefined;
  const common = /^f/i.test(raw);
  const expr = common ? raw.slice(1) : raw.replace(/^s/i, '');
  return { common, fn: compileExprList(expr, env)[0]! };
}

function lookupAnim(p: P, common: boolean, no: number): Animation | undefined {
  return common ? p.world.fightFx?.anims.get(no) : p.prog.data.anims.get(no);
}

export function compileExplod(c: ControllerDef, env: TriggerEnv<P>): (p: P) => void {
  const prm = params(c, env);
  const anim = animRef(c, 'anim', env);
  const legacy = (p: P) => parseFloat(p.prog.data.def.mugenVersion) < 1.1 || !p.prog.data.def.mugenVersion;
  return (p) => {
    if (!anim) return;
    const no = anim.fn(p);
    if (R.t === BOTTOM) return;
    const a = lookupAnim(p, anim.common, toInt(no));
    if (!a) {
      p.warn(`Explod: animación ${anim.common ? 'F' : ''}${toInt(no)} no existe`);
      return;
    }
    const posType = (prm.raw('postype') ?? (legacy(p) && !prm.has('space') ? 'p1' : 'none')).toLowerCase();
    // Explods live in world units; parameters are in the owner's units.
    const k = p.scale;
    const off: [number, number] = [(prm.num(p, 'pos', 0) ?? 0) * k, (prm.num(p, 'pos', 1) ?? 0) * k];
    const rnd: [number, number] = [prm.int(p, 'random', 0) ?? 0, prm.int(p, 'random', 1) ?? 0];
    // mugen.exe 0x410c02: every Explod draws two numbers, random param or not:
    // seed % (r + 1) - ((r + 1) >> 1).
    off[0] += (p.world.random(rnd[0] + 1) - ((rnd[0] + 1) >> 1)) * k;
    off[1] += (p.world.random(rnd[1] + 1) - ((rnd[1] + 1) >> 1)) * k;
    let facing = (prm.int(p, 'facing') ?? 1) < 0 ? -1 : 1;
    const w = p.world;
    let space: Explod['space'] = (prm.raw('space') ?? 'stage').toLowerCase() === 'screen' ? 'screen' : 'stage';
    let x = off[0];
    let y = off[1];
    let bindTo: P | undefined;
    const bindId = prm.int(p, 'bindid') ?? -2;
    switch (posType) {
      case 'p1':
      case 'p2': {
        const ref = posType === 'p1' ? p : (w.enemyOf(p) ?? p);
        x = ref.wx + off[0] * ref.facing;
        y = ref.wy + off[1];
        facing *= ref.facing;
        if (prm.has('bindtime')) bindTo = ref;
        space = 'stage';
        break;
      }
      case 'front':
      case 'back':
      case 'left':
      case 'right': {
        space = 'screen';
        const edgeRight = (posType === 'front') === p.facing > 0;
        if (posType === 'left') x = off[0];
        else if (posType === 'right') x = w.screenWidth + off[0];
        else if (posType === 'front') x = (edgeRight ? w.screenWidth : 0) + off[0];
        else x = (p.facing > 0 ? 0 : w.screenWidth) + off[0] * p.facing;
        if (posType === 'back') facing *= p.facing;
        break;
      }
      default:
        if (space === 'stage' && bindId !== -2) {
          bindTo = bindId === -1 ? p : (w.allPlayers().find((q) => q.id === bindId) ?? p);
          x = bindTo.wx + off[0];
          y = bindTo.wy + off[1];
        }
    }
    const e: Explod = {
      owner: p,
      id: prm.int(p, 'id') ?? -1,
      anim: new AnimPlayer(a),
      common: anim.common,
      space,
      x,
      y,
      facing,
      vfacing: (prm.int(p, 'vfacing') ?? 1) < 0 ? -1 : 1,
      bindTo,
      bindTime: bindTo ? (prm.int(p, 'bindtime') ?? (posType === 'none' ? -1 : 0)) : 0,
      bindOffset: posType === 'p1' || posType === 'p2' ? [off[0] * (bindTo?.facing ?? 1), off[1]] : off,
      vel: [(prm.num(p, 'vel', 0) ?? 0) * k, (prm.num(p, 'vel', 1) ?? 0) * k],
      accel: [(prm.num(p, 'accel', 0) ?? 0) * k, (prm.num(p, 'accel', 1) ?? 0) * k],
      drawScale: anim.common ? 1 : k,
      removeTime: prm.int(p, 'removetime') ?? -2,
      age: 0,
      scale: [prm.num(p, 'scale', 0) ?? 1, prm.num(p, 'scale', 1) ?? 1],
      angle: prm.num(p, 'angle') ?? 0,
      sprPriority: prm.int(p, 'sprpriority') ?? 0,
      onTop: (prm.int(p, 'ontop') ?? 0) !== 0,
      ownPal: (prm.int(p, 'ownpal') ?? (anim.common ? 1 : 0)) !== 0,
      removeOnGetHit: (prm.int(p, 'removeongethit') ?? 0) !== 0,
      ignoreHitPause: (prm.int(p, 'ignorehitpause') ?? 1) !== 0,
      trans: prm.has('trans') ? transBlend(prm.raw('trans')!) : undefined,
      superMoveTime: prm.int(p, 'supermovetime') ?? 0,
      pauseMoveTime: prm.int(p, 'pausemovetime') ?? 0,
    };
    w.explods.push(e);
  };
}

/** Trans controller / explod trans values: none, add, add1, addalpha, sub. */
export function transBlend(raw: string): Blend {
  switch (raw.toLowerCase()) {
    case 'add':
      return { kind: 'add', src: 256, dst: 256 };
    case 'add1':
      return { kind: 'add', src: 256, dst: 128 };
    case 'addalpha':
      return { kind: 'add', src: 256, dst: 0 };
    case 'sub':
      return { kind: 'sub' };
    case 'none':
    case 'default':
      return { kind: 'none' };
  }
  return parseBlend(raw);
}

export function compileModifyExplod(c: ControllerDef, env: TriggerEnv<P>): (p: P) => void {
  const prm = params(c, env);
  return (p) => {
    const id = prm.int(p, 'id') ?? -1;
    for (const e of p.world.explods) {
      if (e.owner !== p || (id !== -1 && e.id !== id)) continue;
      const sc = p.scale;
      const v2 = (k: string, unit = sc): [number, number] | undefined => (prm.has(k) ? [(prm.num(p, k, 0) ?? 0) * unit, (prm.num(p, k, 1) ?? 0) * unit] : undefined);
      const pos = v2('pos');
      if (pos) {
        if (e.bindTo) e.bindOffset = pos;
        else {
          e.x = pos[0];
          e.y = pos[1];
        }
      }
      e.vel = v2('vel') ?? e.vel;
      e.accel = v2('accel') ?? e.accel;
      e.scale = v2('scale', 1) ?? e.scale;
      if (prm.has('angle')) e.angle = prm.num(p, 'angle') ?? e.angle;
      if (prm.has('facing')) e.facing = (prm.int(p, 'facing') ?? 1) < 0 ? -1 : 1;
      if (prm.has('vfacing')) e.vfacing = (prm.int(p, 'vfacing') ?? 1) < 0 ? -1 : 1;
      if (prm.has('removetime')) e.removeTime = prm.int(p, 'removetime') ?? e.removeTime;
      if (prm.has('bindtime')) e.bindTime = prm.int(p, 'bindtime') ?? e.bindTime;
      if (prm.has('sprpriority')) e.sprPriority = prm.int(p, 'sprpriority') ?? e.sprPriority;
      if (prm.has('ontop')) e.onTop = (prm.int(p, 'ontop') ?? 0) !== 0;
      if (prm.has('trans')) e.trans = transBlend(prm.raw('trans')!);
    }
  };
}

export function compileRemoveExplod(c: ControllerDef, env: TriggerEnv<P>): (p: P) => void {
  const prm = params(c, env);
  return (p) => {
    const id = prm.int(p, 'id') ?? -1;
    p.world.explods = p.world.explods.filter((e) => e.owner !== p || (id !== -1 && e.id !== id));
  };
}

export function compileExplodBindTime(c: ControllerDef, env: TriggerEnv<P>): (p: P) => void {
  const prm = params(c, env);
  return (p) => {
    const id = prm.int(p, 'id') ?? -1;
    const t = prm.int(p, 'time') ?? prm.int(p, 'value') ?? 1;
    for (const e of p.world.explods) if (e.owner === p && (id === -1 || e.id === id)) e.bindTime = t;
  };
}

/** GameMakeAnim: fightfx animation at a position relative to the player (deprecated). */
export function compileGameMakeAnim(c: ControllerDef, env: TriggerEnv<P>): (p: P) => void {
  const prm = params(c, env);
  return (p) => {
    const a = p.world.fightFx?.anims.get(prm.int(p, 'value') ?? 0);
    if (!a) return;
    const under = (prm.int(p, 'under') ?? 0) !== 0;
    p.world.explods.push(simpleExplod(p, a, true, p.wx + (prm.num(p, 'pos', 0) ?? 0) * p.facing * p.scale, p.wy + (prm.num(p, 'pos', 1) ?? 0) * p.scale, under ? -10 : 10));
  };
}

/** MakeDust: fightfx action 120 every `spacing` ticks (deprecated). */
export function compileMakeDust(c: ControllerDef, env: TriggerEnv<P>): (p: P) => void {
  const prm = params(c, env);
  return (p) => {
    const spacing = Math.max(1, prm.int(p, 'spacing') ?? 3);
    if (p.time % spacing !== 0) return;
    const a = p.world.fightFx?.anims.get(120);
    if (!a) return;
    for (const k of ['pos', 'pos2']) {
      if (k === 'pos2' && !prm.has('pos2')) continue;
      p.world.explods.push(simpleExplod(p, a, true, p.wx + (prm.num(p, k, 0) ?? 0) * p.facing * p.scale, p.wy + (prm.num(p, k, 1) ?? 0) * p.scale, 0));
    }
  };
}

export function simpleExplod(p: P, a: Animation, common: boolean, x: number, y: number, sprPriority: number, facing = p.facing): Explod {
  return {
    owner: p, id: -1, anim: new AnimPlayer(a), common, space: 'stage', x, y, facing, vfacing: 1, bindTo: undefined, bindTime: 0, bindOffset: [0, 0],
    vel: [0, 0], accel: [0, 0], removeTime: -2, age: 0, scale: [1, 1], angle: 0, sprPriority, onTop: false, ownPal: true, removeOnGetHit: false,
    ignoreHitPause: true, trans: undefined, superMoveTime: 0, pauseMoveTime: 0, drawScale: common ? 1 : p.scale,
  };
}

/** Advance one explod by a tick; returns false when it should be removed. */
export function updateExplod(e: Explod): boolean {
  if (e.bindTo && e.bindTime !== 0) {
    e.x = e.bindTo.wx + e.bindOffset[0];
    e.y = e.bindTo.wy + e.bindOffset[1];
    if (e.bindTime > 0) e.bindTime--;
  } else {
    e.x += e.vel[0] * e.facing;
    e.y += e.vel[1];
    e.vel[0] += e.accel[0];
    e.vel[1] += e.accel[1];
  }
  e.age++;
  e.anim.tick();
  if (e.removeTime === -2) return e.anim.totalTime < 0 || e.anim.animTime() < 0;
  if (e.removeTime >= 0) return e.age < e.removeTime;
  return true;
}
