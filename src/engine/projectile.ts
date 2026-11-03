// Projectiles (sctrls.html Projectile): moving objects that carry a HitDef.

import { BOTTOM, compileExprList, R, toInt, type Fn, type TriggerEnv } from '../expr/compile';
import type { Animation } from '../formats/air';
import { AnimPlayer } from './anim';
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
  removeOnHit: boolean;
  removeTime: number;
  hitsLeft: number;
  missTime: number;
  /** Ticks until it may hit again (multi-hit projectiles). */
  missTimer: number;
  priority: number;
  sprPriority: number;
  edgeBound: number;
  stageBound: number;
  heightBound: [number, number];
  hd: HitDefData;
  /** active: flying; ending: playing hit/remove/cancel anim; dead: to be deleted. */
  phase: 'active' | 'ending' | 'dead';
  /** Created this tick: it first moves (and animates) next tick (measured). */
  fresh: boolean;
  age: number;
  hitPause: number;
  superMoveTime: number;
  pauseMoveTime: number;
  /** Players already hit during the current miss window. */
  hitTargets: Set<P>;
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
    const off = pair(p, 'offset', [0, 0]).map((v) => v * k) as [number, number];
    const kp = (v: [number, number]): [number, number] => [v[0] * k, v[1] * k];
    const postype = (c.params.get('postype') ?? 'p1').trim().toLowerCase();
    let x = p.wx + off[0] * p.facing;
    const y = p.wy + off[1];
    const left = w.camera.x - w.screenWidth / 2;
    const right = w.camera.x + w.screenWidth / 2;
    if (postype === 'p2') {
      const e = w.enemyOf(p);
      if (e) x = e.wx + off[0] * p.facing;
    } else if (postype === 'front') x = (p.facing > 0 ? right : left) + off[0] * p.facing;
    else if (postype === 'back') x = (p.facing > 0 ? left : right) + off[0] * p.facing;
    else if (postype === 'left') x = left + off[0] * p.facing;
    else if (postype === 'right') x = right + off[0] * p.facing;
    const hitAnim = int(p, 'projhitanim') ?? -1;
    const doScale = p.const('size.proj.doscale') !== 0;
    const ps = pair(p, 'projscale', [1, 1]);
    const projId = int(p, 'projid') ?? 0;
    w.projectiles.push({
      owner: p,
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
      scale: (doScale ? [ps[0] * p.const('size.xscale') * k, ps[1] * p.const('size.yscale') * k] : [ps[0] * k, ps[1] * k]) as [number, number],
      removeOnHit: (int(p, 'projremove') ?? 1) !== 0,
      removeTime: int(p, 'projremovetime') ?? -1,
      hitsLeft: int(p, 'projhits') ?? 1,
      missTime: int(p, 'projmisstime') ?? 0,
      missTimer: 0,
      priority: int(p, 'projpriority') ?? 1,
      sprPriority: int(p, 'projsprpriority') ?? 3,
      edgeBound: (int(p, 'projedgebound') ?? Math.trunc(40 * local)) * k,
      stageBound: (int(p, 'projstagebound') ?? Math.trunc(40 * local)) * k,
      heightBound: [(int(p, 'projheightbound', 0) ?? Math.trunc(-240 * local)) * k, (int(p, 'projheightbound', 1) ?? Math.trunc(1 * local)) * k],
      hd: hdBuild(p),
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

/** Note a projectile contact on its owner (mugen.exe: one record per player). */
export function noteProjContact(p: P, kind: 1 | 2 | 3, id: number): void {
  p.projContact = kind;
  if (kind !== 3) p.projContactId = id;
  p.projContactTime = 0;
}

/** Switch to an ending animation (hit / remove / cancel); -1 removes immediately. */
export function endProjectile(pr: Projectile, anim: number, vel?: [number, number]): void {
  if (pr.phase !== 'active') return;
  const a = anim >= 0 ? pr.owner.prog.data.anims.get(anim) : undefined;
  if (vel) pr.vel = [...vel];
  else pr.vel = [0, 0];
  pr.accel = [0, 0];
  pr.velMul = [1, 1];
  if (a) {
    pr.anim.set(a);
    pr.phase = 'ending';
  } else pr.phase = 'dead';
}

/** Move, age and bound-check one projectile. */
export function updateProjectile(pr: Projectile): void {
  if (pr.phase === 'dead') return;
  if (pr.fresh) {
    pr.fresh = false;
    return;
  }
  if (pr.hitPause > 0) {
    pr.hitPause--;
    return;
  }
  pr.anim.tick();
  pr.x += pr.vel[0] * pr.facing;
  pr.y += pr.vel[1];
  if (pr.phase === 'ending') {
    if (pr.anim.totalTime >= 0 && pr.anim.animTime() >= 0) pr.phase = 'dead';
    return;
  }
  pr.vel = [pr.vel[0] * pr.velMul[0] + pr.accel[0], pr.vel[1] * pr.velMul[1] + pr.accel[1]];
  pr.age++;
  if (pr.missTimer > 0 && --pr.missTimer === 0) pr.hitTargets.clear();
  const w = pr.owner.world;
  const left = w.camera.x - w.screenWidth / 2;
  const right = w.camera.x + w.screenWidth / 2;
  const outScreen = pr.x < left - pr.edgeBound || pr.x > right + pr.edgeBound;
  const outStage = pr.x < w.boundLeft - w.screenWidth / 2 - pr.stageBound || pr.x > w.boundRight + w.screenWidth / 2 + pr.stageBound;
  const outHeight = pr.y < pr.heightBound[0] || pr.y > pr.heightBound[1];
  if (outScreen || outStage || outHeight) {
    pr.phase = 'dead';
    return;
  }
  if (pr.removeTime >= 0 && pr.age >= pr.removeTime) endProjectile(pr, pr.remAnim, pr.remVel);
}
