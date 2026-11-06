// Explods (sctrls.html Explod, ModifyExplod, RemoveExplod, ExplodBindTime,
// GameMakeAnim, MakeDust): free-standing animations owned by a player.

import { shadowOn } from './fx';
import { isPre10 } from './sctrl-params';
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
  /** Direction of vel/accel x: the anchor's facing (not the facing param). */
  velDir: number;
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
  /** Casts a shadow (the shadow parameter). */
  shadow: boolean;
  trans: Blend | undefined;
  /** Sprite scale: the owner's unit scale (own files) or the fightfx scale. */
  drawScale: number;
  /** Set when created during a SuperPause/Pause: ticks it may still animate. */
  superMoveTime: number;
  pauseMoveTime: number;
  /**
   * A hit/guard spark (Player_MakeSpark): owner id 0 in mugen.exe, so no
   * player's NumExplod, RemoveExplod or ModifyExplod sees it.
   */
  system?: boolean;
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
  for (const k of ['id', 'pos', 'facing', 'vfacing', 'bindid', 'bindtime', 'vel', 'accel', 'removetime', 'scale', 'angle', 'sprpriority', 'ontop', 'ownpal', 'removeongethit', 'ignorehitpause', 'random', 'supermovetime', 'supermove', 'pausemovetime']) {
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
  // sctrl.c Explod: default postype p1 below mugenversion 1.1 (dates "y,m,d"
  // parse as 0), none from 1.1 on, whatever the space.
  const legacy = (p: P) => isPre10(p.prog.data.def.mugenVersion) || parseFloat(p.prog.data.def.mugenVersion) < 1.1;
  return (p) => {
    if (!anim) return;
    const no = anim.fn(p);
    if (R.t === BOTTOM) return;
    const a = lookupAnim(p, anim.common, toInt(no));
    if (!a) {
      p.warn(`Explod: no animation ${anim.common ? 'F' : ''}${toInt(no)}`);
      return;
    }
    const posType = (prm.raw('postype') ?? (legacy(p) ? 'p1' : 'none')).toLowerCase();
    // Explods live in world units; parameters are in the owner's units.
    const k = p.scale;
    const off: [number, number] = [(prm.num(p, 'pos', 0) ?? 0) * k, (prm.num(p, 'pos', 1) ?? 0) * k];
    const rnd: [number, number] = [prm.int(p, 'random', 0) ?? 0, prm.int(p, 'random', 1) ?? 0];
    // mugen.exe 0x410c02: every Explod draws two numbers, random param or not:
    // seed % (r + 1) - ((r + 1) >> 1).
    // The random offset is added after pos is turned by the origin's facing
    // (explod.c: it is never mirrored).
    const rx = (p.world.random(rnd[0] + 1) - ((rnd[0] + 1) >> 1)) * k;
    const ry = (p.world.random(rnd[1] + 1) - ((rnd[1] + 1) >> 1)) * k;
    const faceParam = (prm.int(p, 'facing') ?? 1) < 0 ? -1 : 1;
    let facing = faceParam;
    const w = p.world;
    // space: unset or auto, the screen for the edge postypes and else the stage.
    const edge = posType === 'front' || posType === 'back' || posType === 'left' || posType === 'right';
    const rawSpace = prm.raw('space')?.trim().toLowerCase();
    const space: Explod['space'] = rawSpace === 'screen' || (rawSpace !== 'stage' && edge) ? 'screen' : 'stage';
    const o = explodOrigin(p, posType, space);
    facing *= o.dir;
    let bindTo = o.bindTo;
    const bindId = prm.int(p, 'bindid') ?? -2;
    if (bindId !== -2 && space === 'stage') {
      bindTo = bindId === -1 ? p : bindId >= 0 ? (w.allPlayers().find((q) => q.id === bindId) ?? bindTo) : bindTo;
    }
    const offX = o.ox + off[0] * o.dir + rx;
    const offY = o.oy + off[1] + ry;
    const e: Explod = {
      owner: p,
      // An Explod without an id has id 0 (a ModifyExplod's default is -1).
      id: prm.int(p, 'id') ?? 0,
      anim: new AnimPlayer(a),
      common: anim.common,
      space,
      x: o.x + offX,
      y: o.y + offY,
      facing,
      vfacing: (prm.int(p, 'vfacing') ?? 1) < 0 ? -1 : 1,
      bindTo,
      // bindtime defaults to 1 (sctrl.c bindtime_def).
      bindTime: bindTo ? (prm.int(p, 'bindtime') ?? 1) : 0,
      bindOffset: [offX, offY],
      // Explod_ReadParams: vel, or velocity when vel is absent.
      vel: [(prm.num(p, velKey(prm), 0) ?? 0) * k, (prm.num(p, velKey(prm), 1) ?? 0) * k],
      velDir: o.dir,
      accel: [(prm.num(p, 'accel', 0) ?? 0) * k, (prm.num(p, 'accel', 1) ?? 0) * k],
      drawScale: anim.common ? p.world.fightFxScale : k,
      removeTime: prm.int(p, 'removetime') ?? -2,
      age: 0,
      scale: [prm.num(p, 'scale', 0) ?? 1, prm.num(p, 'scale', 1) ?? 1],
      angle: prm.num(p, 'angle') ?? 0,
      sprPriority: prm.int(p, 'sprpriority') ?? 0,
      shadow: shadowOn(prm.int(p, 'shadow', 0), prm.int(p, 'shadow', 1), prm.int(p, 'shadow', 2)),
      onTop: (prm.int(p, 'ontop') ?? 0) !== 0,
      ownPal: (prm.int(p, 'ownpal') ?? (anim.common ? 1 : 0)) !== 0,
      removeOnGetHit: (prm.int(p, 'removeongethit') ?? 0) !== 0,
      ignoreHitPause: (prm.int(p, 'ignorehitpause') ?? 1) !== 0,
      trans: prm.has('trans') ? transBlend(prm.raw('trans')!) : undefined,
      superMoveTime: 0,
      pauseMoveTime: 0,
    };
    // Explod_SetParams: removetime -2 is the animation's length; the pause
    // move times may follow it (-2, or supermove = 1 without supermovetime).
    if (e.removeTime === -2) e.removeTime = e.anim.totalTime < 0 ? -1 : e.anim.totalTime;
    const smt = prm.int(p, 'supermovetime');
    if (!smt) {
      if (prm.int(p, 'supermove')) e.superMoveTime = e.removeTime;
    } else e.superMoveTime = smt === -2 ? e.removeTime : smt;
    const pmt = prm.int(p, 'pausemovetime');
    if (pmt !== undefined) e.pauseMoveTime = pmt === -2 ? e.removeTime : pmt;
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

/**
 * Player_GetPosOrigin: where a postype puts an explod (x, y, plus an offset
 * kept when it follows its anchor), the sign of its x parameters and the
 * player it is bound to. A p1/p2 explod in screen space keeps the player's
 * screen position as its offset and, while bound, adds the stage position
 * on top (the reference does the same).
 */
function explodOrigin(p: P, posType: string, space: Explod['space']): { x: number; y: number; ox: number; oy: number; dir: number; bindTo: P | undefined } {
  const w = p.world;
  const zero = { x: 0, y: 0, ox: 0, oy: 0 };
  switch (posType) {
    case 'p1':
    case 'p2': {
      const ref = posType === 'p1' ? p : (w.enemyOf(p) ?? p);
      if (space === 'screen') {
        return { ...zero, ox: ref.wx - (w.camera.x - w.screenWidth / 2), oy: w.groundY + ref.wy - w.camera.y - (w.shakeBase + w.cropTop), dir: ref.facing, bindTo: ref };
      }
      return { ...zero, x: ref.wx, y: ref.wy, dir: ref.facing, bindTo: ref };
    }
    case 'front':
    case 'back':
    case 'left':
    case 'right': {
      const left = posType === 'left' || (posType === 'back' ? p.facing === 1 : posType === 'front' && p.facing === -1);
      const width = w.screenWidth;
      // The edge is GameWidth - 1 internal units from the other.
      const span = width - width / w.gameWidth;
      const dir = posType === 'back' ? p.facing : 1;
      if (space === 'screen') return { ...zero, ox: left ? 0 : span, dir, bindTo: undefined };
      return { ...zero, x: w.camera.x, ox: -width / 2 + (left ? 0 : span), dir, bindTo: undefined };
    }
    default:
      return { ...zero, dir: 1, bindTo: undefined };
  }
}

export function compileModifyExplod(c: ControllerDef, env: TriggerEnv<P>): (p: P) => void {
  const prm = params(c, env);
  return (p) => {
    const id = prm.int(p, 'id') ?? -1;
    for (const e of p.world.explods) {
      if (e.owner !== p || e.system || (id !== -1 && e.id !== id)) continue;
      const sc = p.scale;
      const v2 = (k: string, unit = sc): [number, number] | undefined => (prm.has(k) ? [(prm.num(p, k, 0) ?? 0) * unit, (prm.num(p, k, 1) ?? 0) * unit] : undefined);
      // explod.c: position, velocity, acceleration, facing and the random
      // offset are only re-set when postype is given (two draws as for an
      // Explod); scale, angle, times and the rest always apply.
      const anchored = prm.has('postype');
      if (anchored) {
        const r0 = prm.int(p, 'random', 0) ?? 0;
        const r1 = prm.int(p, 'random', 1) ?? 0;
        p.world.random(r0 + 1);
        p.world.random(r1 + 1);
        const pos = v2('pos');
        if (pos) {
          if (e.bindTo) e.bindOffset = pos;
          else {
            e.x = pos[0];
            e.y = pos[1];
          }
        }
        e.vel = v2(velKey(prm)) ?? e.vel;
        e.accel = v2('accel') ?? e.accel;
        if (e.bindTime === 0) e.bindTime = 1;
      }
      e.scale = v2('scale', 1) ?? e.scale;
      if (prm.has('shadow')) e.shadow = shadowOn(prm.int(p, 'shadow', 0), prm.int(p, 'shadow', 1), prm.int(p, 'shadow', 2));
      if (prm.has('angle')) e.angle = prm.num(p, 'angle') ?? e.angle;
      if (anchored && prm.has('facing')) e.facing = (prm.int(p, 'facing') ?? 1) < 0 ? -1 : 1;
      if (anchored && prm.has('vfacing')) e.vfacing = (prm.int(p, 'vfacing') ?? 1) < 0 ? -1 : 1;
      if (prm.has('removetime')) {
        const v = prm.int(p, 'removetime') ?? e.removeTime;
        // -2: what is left of the animation, counted from the current age.
        e.removeTime = v === -2 ? (e.anim.totalTime < 0 ? -1 : e.anim.totalTime - e.age) : v;
      }
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
    p.world.explods = p.world.explods.filter((e) => e.owner !== p || e.system || (id !== -1 && e.id !== id));
  };
}

export function compileExplodBindTime(c: ControllerDef, env: TriggerEnv<P>): (p: P) => void {
  const prm = params(c, env);
  return (p) => {
    const id = prm.int(p, 'id') ?? -1;
    const t = prm.int(p, 'time') ?? prm.int(p, 'value') ?? 1;
    for (const e of p.world.explods) if (e.owner === p && !e.system && (id === -1 || e.id === id)) e.bindTime = t;
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
    // The round state clock, like the floor dust (not the state's Time).
    if ((p.world.roundClock ?? p.world.fightTime) % spacing !== 0) return;
    const a = p.world.fightFx?.anims.get(120);
    if (!a) return;
    for (const k of ['pos', 'pos2']) {
      if (k === 'pos2' && !prm.has('pos2')) continue;
      // Each puff jitters by -1..1 like the engine's floor dust: two draws
      // from the shared generator (measured: KFM's hop-back landing, 106).
      const jx = p.world.random(3) - 1;
      const jy = p.world.random(3) - 1;
      p.world.explods.push(simpleExplod(p, a, true, p.wx + (prm.num(p, k, 0) ?? 0) * p.facing * p.scale + jx, p.wy + (prm.num(p, k, 1) ?? 0) * p.scale + jy, 0));
    }
  };
}

export function simpleExplod(p: P, a: Animation, common: boolean, x: number, y: number, sprPriority: number, facing = p.facing): Explod {
  return {
    owner: p, id: -1, anim: new AnimPlayer(a), common, space: 'stage', x, y, facing, vfacing: 1, bindTo: undefined, bindTime: 0, bindOffset: [0, 0],
    vel: [0, 0], velDir: facing, accel: [0, 0], removeTime: -2, age: 0, scale: [1, 1], angle: 0, sprPriority, onTop: false, ownPal: true, removeOnGetHit: false, shadow: false,
    ignoreHitPause: true, trans: undefined, superMoveTime: 0, pauseMoveTime: 0, drawScale: common ? p.world.fightFxScale : p.scale,
  };
}

/**
 * Advance one explod by a frame; returns false when it is removed
 * (SysDraw_Start): it goes at the start of the frame its age reaches the
 * remove time, so an explod lives remove time + 1 frames (NumExplod counts it
 * on the last one); it does not move on the frame it was created.
 */
export function updateExplod(e: Explod): boolean {
  const time = e.removeTime === -2 ? (e.anim.totalTime < 0 ? -1 : e.anim.totalTime) : e.removeTime;
  if (time !== -1 && e.age >= time) return false;
  // SysDraw_Start -> Anim_Step: the element of the current time is shown,
  // then the time moves on (a new explod shows its first element).
  e.anim.resync();
  e.anim.tick(true);
  if (e.age > 0) {
    e.x += e.vel[0] * e.velDir;
    e.y += e.vel[1];
    e.vel[0] += e.accel[0];
    e.vel[1] += e.accel[1];
  }
  if (e.bindTo && e.bindTime !== 0) {
    // PlayerRef_GetPos: an explod's anchor includes the player's draw offset.
    e.x = e.bindTo.clsnX + e.bindOffset[0];
    e.y = e.bindTo.clsnY + e.bindOffset[1];
    if (e.bindTime > 0) e.bindTime--;
  }
  e.age++;
  return true;
}

/** Explod_ReadParams reads vel, or velocity when there is no vel. */
function velKey(prm: { has(k: string): boolean }): string {
  return prm.has('vel') || !prm.has('velocity') ? 'vel' : 'velocity';
}
