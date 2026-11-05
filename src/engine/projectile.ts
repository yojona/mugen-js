// Projectiles (sctrls.html Projectile): moving objects that carry a HitDef.

import { BOTTOM, compileExprList, R, toInt, type Fn, type TriggerEnv } from '../expr/compile';
import type { Animation } from '../formats/air';
import { AnimPlayer } from './anim';
import { shadowOn } from './fx';
import type { ControllerDef } from './cns';
import { compileHitDef, type HitDefData } from './hitdef';
import type { Player } from './player';

type P = Player;

export interface Projectile {
  owner: P;
  projId: number;
  anim: AnimPlayer;
  hitAnim: number;
  remAnim: number;
  cancelAnim: number;
  x: number;
  y: number;
  facing: number;
  vel: [number, number];
  remVel: [number, number];
  accel: [number, number];
  velMul: [number, number];
  scale: [number, number];
  /** Clsn scale: the owner's size.xscale/yscale (mugen.exe scales boxes when loading; projscale is drawing only). */
  clsnScale: [number, number];
  removeOnHit: boolean;
  removeTime: number;
  hitsLeft: number;
  missTime: number;
  /** Ticks until it may hit again (multi-hit projectiles). */
  missTimer: number;
  priority: number;
  sprPriority: number;
  /** Casts a shadow (projshadow). */
  shadow: boolean;
  edgeBound: number;
  stageBound: number;
  heightBound: [number, number];
  hd: HitDefData;
  /** active: flying; ending: playing hit/remove/cancel anim; dead: to be deleted. */
  /** removing: ended without an animation; stays listed (InGuardDist) until the next update (Projectiles_Update). */
  phase: 'active' | 'ending' | 'removing' | 'dead';
  /** Created this tick: it first moves (and animates) next tick (measured). */
  fresh: boolean;
  /** Velocity from the next ending tick on (remvelocity). */
  endVel?: [number, number];
  age: number;
  hitPause: number;
  superMoveTime: number;
  pauseMoveTime: number;
  /** Players already hit during the current miss window. */
  hitTargets: Set<P>;
  /** Hit someone this tick (Projectiles_ApplyHits takes its hit and pause). */
  hitPending?: boolean;
  /** Ending as mugen.exe's state 2 (bounds, removetime, a HitDef's hit): it can still hit players. */
  removed?: boolean;
}

export function compileProjectile(c: ControllerDef, env: TriggerEnv<P>): (p: P) => void {
  const hdBuild = compileHitDef(c, env);
  const cache = new Map<string, Fn<P>[]>();
  const list = (k: string) => {
    let v = cache.get(k);
    if (!v) {
      const s = c.params.get(k);
      v = s === undefined || s.trim() === '' ? [] : compileExprList(s, env);
      cache.set(k, v);
    }
    return v;
  };
  const num = (p: P, k: string, i = 0): number | undefined => {
    const fn = list(k)[i];
    if (!fn) return undefined;
    const v = fn(p);
    return R.t === BOTTOM ? undefined : v;
  };
  const int = (p: P, k: string, i = 0) => {
    const v = num(p, k, i);
    return v === undefined ? undefined : toInt(v);
  };
  const pair = (p: P, k: string, d: [number, number]): [number, number] => [num(p, k, 0) ?? d[0], num(p, k, 1) ?? d[1]];

  return (p) => {
    const w = p.world;
    const local = p.prog.data.def.localCoord[0] / 320;
    const animNo = int(p, 'projanim') ?? 0;
    const a: Animation | undefined = p.prog.data.anims.get(animNo);
    if (!a) {
      p.warn(`Projectile: animación ${animNo} no existe`);
      return;
    }
    // Projectiles live in world units; parameters are in the owner's units.
    const k = p.scale;
    // Projectile_Fire: offset is read as integers.
    const off = [Math.trunc(num(p, 'offset', 0) ?? 0) * k, Math.trunc(num(p, 'offset', 1) ?? 0) * k] as [number, number];
    const kp = (v: [number, number]): [number, number] => [v[0] * k, v[1] * k];
    const postype = (c.params.get('postype') ?? 'p1').trim().toLowerCase();
    let x = p.wx + off[0] * p.facing;
    let y = p.wy + off[1];
    if (postype === 'p2') {
      const e = w.enemyOf(p);
      if (e) {
        x = e.wx + off[0] * p.facing;
        y = e.wy + off[1];
      }
    } else if (postype === 'front' || postype === 'back' || postype === 'left' || postype === 'right') {
      // Projectile_Fire takes only Player_GetPosOrigin's x and y, not its
      // edge offset: the screen-edge postypes start at the camera centre, at
      // y = 0 (measured: probepos fires at x = camera + offset).
      x = w.camera.x + off[0] * p.facing;
      y = off[1];
    }
    const hitAnim = int(p, 'projhitanim') ?? -1;
    const doScale = p.const('size.proj.doscale') !== 0;
    const ps = pair(p, 'projscale', [1, 1]);
    const projId = int(p, 'projid') ?? 0;
    w.projectiles.push({
      // SCTRL_PROJECTILE: a helper's projectile belongs to its root (its list,
      // NumProj, ProjHit, InGuardDist, juggle and hits).
      owner: p.root,
      projId,
      anim: new AnimPlayer(a),
      hitAnim,
      remAnim: int(p, 'projremanim') ?? hitAnim,
      cancelAnim: int(p, 'projcancelanim') ?? int(p, 'projremanim') ?? hitAnim,
      x,
      y,
      facing: p.facing,
      vel: kp(pair(p, 'velocity', [0, 0])),
      remVel: kp(pair(p, 'remvelocity', [0, 0])),
      accel: kp(pair(p, 'accel', [0, 0])),
      velMul: pair(p, 'velmul', [1, 1]),
      clsnScale: [p.const('size.xscale') * k, p.const('size.yscale') * k] as [number, number],
      scale: (doScale ? [ps[0] * p.const('size.xscale') * k, ps[1] * p.const('size.yscale') * k] : [ps[0] * k, ps[1] * k]) as [number, number],
      removeOnHit: (int(p, 'projremove') ?? 1) !== 0,
      removeTime: int(p, 'projremovetime') ?? -1,
      hitsLeft: int(p, 'projhits') ?? 1,
      missTime: int(p, 'projmisstime') ?? 0,
      missTimer: 0,
      priority: int(p, 'projpriority') ?? 1,
      sprPriority: int(p, 'projsprpriority') ?? 3,
      shadow: shadowOn(int(p, 'projshadow', 0), int(p, 'projshadow', 1), int(p, 'projshadow', 2)),
      edgeBound: (int(p, 'projedgebound') ?? Math.trunc(40 * local)) * k,
      stageBound: (int(p, 'projstagebound') ?? Math.trunc(40 * local)) * k,
      heightBound: [(int(p, 'projheightbound', 0) ?? Math.trunc(-240 * local)) * k, (int(p, 'projheightbound', 1) ?? Math.trunc(1 * local)) * k],
      hd: projHitDef(hdBuild(p), p),
      phase: 'active',
      fresh: true,
      age: 0,
      hitPause: 0,
      superMoveTime: int(p, 'supermovetime') ?? 0,
      pauseMoveTime: int(p, 'pausemovetime') ?? 0,
      hitTargets: new Set(),
    });
    // mugen.exe 0x44a2bd: the move being recorded fired this projectile.
    if (p.recorder) p.recorder.projPending = projId;
  };
}

/** Projectile_Fire: a projectile's HitDef without guard.dist uses size.proj.attack.dist. */
function projHitDef(hd: HitDefData, p: P): HitDefData {
  if (hd.guardDist === -1) hd.guardDist = p.const('size.proj.attack.dist');
  return hd;
}

/** Note a projectile contact on its owner (mugen.exe: one record per player). */
export function noteProjContact(p: P, kind: 1 | 2 | 3, id: number): void {
  p.projContact = kind;
  if (kind !== 3) p.projContactId = id;
  p.projContactTime = 0;
}

/** Switch to an ending animation (hit / remove / cancel); -1 removes immediately. */
export function endProjectile(pr: Projectile, anim: number, vel?: [number, number], removed = false): void {
  if (pr.phase !== 'active') return;
  pr.removed = removed;
  const a = anim >= 0 ? pr.owner.prog.data.anims.get(anim) : undefined;
  // Projectiles_Update: an ending projectile (removed, cancelled or hit)
  // still moves by its old velocity on its first ending tick, then by
  // projremvelocity.
  pr.endVel = vel ? [...vel] : [...pr.remVel];
  pr.accel = [0, 0];
  pr.velMul = [1, 1];
  if (a) {
    // Anim_SetAction keeps the time when the action does not change
    // (projhitanim = projanim: the end counts from where it is).
    if (a !== pr.anim.anim) pr.anim.set(a);
    pr.phase = 'ending';
  } else pr.phase = 'removing';
}

/** Move, age and bound-check one projectile. */
export function updateProjectile(pr: Projectile): void {
  if (pr.phase === 'dead') return;
  if (pr.phase === 'removing') {
    pr.phase = 'dead';
    return;
  }
  const fresh = pr.fresh;
  pr.fresh = false;
  if (pr.hitPause > 0) {
    // Projectiles_Update: in hit pause the animation still steps.
    if (!fresh) stepAnim(pr);
    pr.hitPause--;
    return;
  }
  if (pr.phase === 'ending') {
    pr.x += pr.vel[0] * pr.facing;
    pr.y += pr.vel[1];
    if (pr.endVel) {
      pr.vel = pr.endVel;
      pr.endVel = undefined;
    }
    // Projectiles_Update: an end animation with no length (or endless:
    // total_time <= 0) removes the projectile at once; otherwise it goes
    // when the animation time reached its length before this tick's step.
    if (pr.anim.totalTime <= 0 || pr.anim.animTime() >= 0) pr.phase = 'dead';
    else if (!fresh) stepAnim(pr);
    return;
  }
  if (!fresh) stepAnim(pr);
  pr.x += pr.vel[0] * pr.facing;
  pr.y += pr.vel[1];
  pr.vel = [pr.vel[0] * pr.velMul[0] + pr.accel[0], pr.vel[1] * pr.velMul[1] + pr.accel[1]];
  // Projectiles_Update: bounds, miss time and removetime are checked with
  // the time before this tick's increment (time++ comes last).
  const age = pr.age++;
  const w = pr.owner.world;
  // World-space velocity: stage and height bounds only remove a projectile
  // moving out past them (Projectiles_Update); the camera edges always do.
  const wvx = pr.vel[0] * pr.facing;
  const wvy = pr.vel[1];
  const left = w.camera.x - w.screenWidth / 2;
  const right = w.camera.x + w.screenWidth / 2;
  const outStage =
    (pr.x < w.boundLeft - w.screenWidth / 2 - pr.stageBound && wvx < 0) ||
    (pr.y < pr.heightBound[0] && wvy < 0) ||
    (pr.x > w.boundRight + w.screenWidth / 2 + pr.stageBound && wvx > 0) ||
    (pr.y > pr.heightBound[1] && wvy > 0);
  const outScreen = pr.x < left - pr.edgeBound || pr.x > right + pr.edgeBound;
  if (outStage || outScreen) return removeNow(pr);
  // Then the miss time, then removetime (with the time before this tick's increment).
  if (pr.missTimer > 0 && --pr.missTimer === 0) pr.hitTargets.clear();
  if (pr.removeTime >= 0 && age >= pr.removeTime) removeNow(pr);
}

/**
 * Projectiles_Update removing a projectile in its own update (bounds or
 * removetime, state 2): it moves once more by its velocity, then takes
 * projremvelocity and projremanim; without one it is gone at once.
 */
function removeNow(pr: Projectile): void {
  const a = pr.remAnim >= 0 ? pr.owner.prog.data.anims.get(pr.remAnim) : undefined;
  if (!a) {
    pr.phase = 'dead';
    return;
  }
  pr.x += pr.vel[0] * pr.facing;
  pr.y += pr.vel[1];
  endProjectile(pr, pr.remAnim, pr.remVel, true);
  pr.vel = [...pr.remVel];
  pr.endVel = undefined;
  // Projectiles_Update, same update: an end animation with no length goes
  // at once, and so does one already at its end (projremanim = projanim
  // keeps the time: Benimaru's 1220 does not hit after its removetime).
  if (pr.anim.totalTime <= 0 || pr.anim.animTime() >= 0) pr.phase = 'dead';
}

/**
 * Anim_Step seeks the element before the time moves on: the step that
 * reaches the end of the action still shows its last element (not the
 * loop's first), as the hit check sees it (Benimaru's 1230 at its end).
 */
function stepAnim(pr: Projectile): void {
  pr.anim.tick(pr.anim.animTime() === -1);
}
