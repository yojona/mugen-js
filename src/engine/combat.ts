// Hit detection and resolution between players.
//
// Each tick, after states and physics, every active HitDef is tested:
// attacker Clsn1 boxes against defender Clsn2 boxes. Hits found in the same
// tick are applied together (so trades are possible). Exact ordering and timer
// alignment still need to be verified against the reference binary.

import type { Clsn } from '../formats/air';
import { attrMatches, type HitDefData } from './hitdef';
import { endProjectile, projInfo, type Projectile } from './projectile';
import type { Player } from './player';

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function worldBoxes(p: Player, boxes: Clsn[] | null): Box[] {
  if (!boxes) return [];
  // Boxes are in the character's units; collisions happen in world units.
  const sx = p.const('size.xscale') * p.scale;
  const sy = p.const('size.yscale') * p.scale;
  const x = p.wx;
  const y = p.wy;
  return boxes.map((b) => {
    const xa = x + p.facing * b.x1 * sx;
    const xb = x + p.facing * b.x2 * sx;
    return { x1: Math.min(xa, xb), x2: Math.max(xa, xb), y1: y + b.y1 * sy, y2: y + b.y2 * sy };
  });
}

/** Do the players' current Clsn2 boxes touch? MUGEN only pushes them apart if so. */
export function clsn2Overlap(a: Player, b: Player): boolean {
  return overlap(worldBoxes(a, a.anim.current?.clsn2 ?? null), worldBoxes(b, b.anim.current?.clsn2 ?? null));
}

function overlap(a: Box[], b: Box[]): boolean {
  for (const x of a) for (const y of b) if (x.x1 <= y.x2 && y.x1 <= x.x2 && x.y1 <= y.y2 && y.y1 <= x.y2) return true;
  return false;
}

/** Letter describing the defender for hitflag / guardflag tests. */
function stanceOk(flags: string, d: Player): boolean {
  switch (d.stateType) {
    case 's':
      return flags.includes('h') || flags.includes('m');
    case 'c':
      return flags.includes('l') || flags.includes('m');
    case 'a':
      return flags.includes('a');
    case 'l':
      return flags.includes('d');
  }
  return false;
}

function canHit(a: Player, hd: HitDefData, d: Player): boolean {
  const f = hd.hitFlag;
  if (f.includes('+') && d.moveType !== 'h') return false;
  if (f.includes('-') && d.moveType === 'h') return false;
  if (d.world.superPause?.owner === d && d.world.superPause.unhittable) return false;
  if (d.immuneTo(hd)) return false;
  // Juggle limit for opponents being hit in the air (cns.html "Juggling").
  if (d.moveType === 'h' && d.stateType === 'a' && !a.special.has('nojugglecheck') && hd.airJuggle > d.juggleLeft) return false;
  // Falling opponents need "F".
  if (d.moveType === 'h' && d.ghv.fall && d.stateType === 'a') return f.includes('f');
  return stanceOk(f, d);
}

export function isGuarding(d: Player): boolean {
  return d.stateNo >= 120 && d.stateNo <= 155;
}

export interface PendingHit {
  attacker: Player;
  defender: Player;
  hd: HitDefData;
  guarded: boolean;
  /** Set when the hit comes from a projectile owned by `attacker`. */
  proj?: Projectile;
}

export function detectHits(players: Player[]): PendingHit[] {
  const hits: PendingHit[] = [];
  for (const a of players) {
    if (!a.hitDefActive || !a.hitDef || a.hitPause > 0) continue;
    const atk = worldBoxes(a, a.anim.current?.clsn1 ?? null);
    if (!atk.length) continue;
    for (const d of players) {
      if (d === a || d.side === a.side || (!d.alive && d.stateType === 'l')) continue;
      if (a.hitTargets.has(d)) continue;
      // ReversalDef: the defender's Clsn1 against the attacker's Clsn1.
      if (d.reversal && attrMatches(d.reversal.attrs, a.hitDef.attrState, a.hitDef.attrType)) {
        if (overlap(atk, worldBoxes(d, d.anim.current?.clsn1 ?? null))) {
          applyReversal(d, a);
          continue;
        }
      }
      const hurt = worldBoxes(d, d.anim.current?.clsn2 ?? null);
      if (!overlap(atk, hurt)) continue;
      if (!canHit(a, a.hitDef, d)) continue;
      const guarded = isGuarding(d) && stanceOk(a.hitDef.guardFlag, d) && !a.special.has('unguardable');
      hits.push({ attacker: a, defender: d, hd: a.hitDef, guarded });
    }
  }
  return resolvePriority(hits);
}

const PRIO_CLASS = { hit: 0, miss: 1, dodge: 2 };

/**
 * Two players hitting each other on the same tick: higher priority wins; on a
 * tie, Hit vs Hit trades, Hit vs Miss lets the Hit through, anything else misses
 * (sctrls.html HitDef "priority"). Losing HitDefs stay active.
 */
function resolvePriority(hits: PendingHit[]): PendingHit[] {
  const out: PendingHit[] = [];
  for (const h of hits) {
    const rev = hits.find((o) => o.attacker === h.defender && o.defender === h.attacker);
    if (!rev || h.guarded || rev.guarded) {
      out.push(h);
      continue;
    }
    if (h.hd.priority !== rev.hd.priority) {
      if (h.hd.priority > rev.hd.priority) out.push(h);
      continue;
    }
    const mine = PRIO_CLASS[h.hd.priorityType];
    const theirs = PRIO_CLASS[rev.hd.priorityType];
    if (mine === 0 && theirs <= 1) out.push(h);
  }
  return out;
}

function applyReversal(r: Player, a: Player): void {
  const rv = r.reversal!;
  r.reversal = undefined;
  a.hitDefActive = false;
  r.moveContact = r.moveHit = 1;
  r.hitPause = rv.hd.pause[0];
  a.hitPause = rv.hd.pause[1];
  r.targets.set(a, rv.hd.id);
  r.world.spawnSpark(r, a, rv.hd.spark, [(rv.hd.sparkXY[0] + (a.hitDef?.sparkXY[0] ?? 0)) * r.scale, (rv.hd.sparkXY[1] + (a.hitDef?.sparkXY[1] ?? 0)) * r.scale], { x: r.wx, y: r.wy });
  r.world.playHitSound(r, rv.hd.hitSound);
  if (rv.hd.p1StateNo >= 0) r.changeState(rv.hd.p1StateNo);
  if (rv.hd.p2StateNo >= 0) {
    if (rv.hd.p2GetP1State) a.stateOwner = r;
    a.changeState(rv.hd.p2StateNo);
  }
}

export function applyHits(hits: PendingHit[]): void {
  for (const h of hits) applyHit(h);
}

function projBoxes(pr: Projectile, which: 1 | 2): Box[] {
  const el = pr.anim.current;
  const boxes = which === 1 ? el?.clsn1 : el?.clsn2;
  if (!boxes) return [];
  return boxes.map((b) => {
    const xa = pr.x + pr.facing * b.x1 * pr.scale[0];
    const xb = pr.x + pr.facing * b.x2 * pr.scale[0];
    return { x1: Math.min(xa, xb), x2: Math.max(xa, xb), y1: pr.y + b.y1 * pr.scale[1], y2: pr.y + b.y2 * pr.scale[1] };
  });
}

/**
 * Projectile collisions: opposing projectiles cancel by priority (equal: both
 * cancel; otherwise the stronger loses one priority point), then projectiles
 * hit players' Clsn2 boxes.
 */
export function detectProjectileHits(projs: Projectile[], players: Player[]): PendingHit[] {
  const live = projs.filter((p) => p.phase === 'active' && p.hitPause === 0);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.phase !== 'active' || b.phase !== 'active' || a.owner.side === b.owner.side) continue;
      const ab = [...projBoxes(a, 1), ...projBoxes(a, 2)];
      const bb = [...projBoxes(b, 1), ...projBoxes(b, 2)];
      if (!overlap(ab, bb)) continue;
      if (a.priority === b.priority) {
        cancel(a);
        cancel(b);
      } else {
        const [hi, lo] = a.priority > b.priority ? [a, b] : [b, a];
        cancel(lo);
        hi.priority--;
      }
    }
  }
  const hits: PendingHit[] = [];
  for (const pr of live) {
    if (pr.phase !== 'active' || pr.hitsLeft <= 0 || pr.missTimer > 0) continue;
    const atk = projBoxes(pr, 1);
    if (!atk.length) continue;
    for (const d of players) {
      if (d.side === pr.owner.side || pr.hitTargets.has(d) || (!d.alive && d.stateType === 'l')) continue;
      if (!overlap(atk, worldBoxes(d, d.anim.current?.clsn2 ?? null))) continue;
      if (!canHit(pr.owner, pr.hd, d)) continue;
      const guarded = isGuarding(d) && stanceOk(pr.hd.guardFlag, d);
      hits.push({ attacker: pr.owner, defender: d, hd: pr.hd, guarded, proj: pr });
      break;
    }
  }
  return hits;
}

function cancel(pr: Projectile): void {
  projInfo(pr.owner, pr.projId).cancel = 0;
  endProjectile(pr, pr.cancelAnim);
}

function applyHit({ attacker: a, defender: d, hd, guarded, proj }: PendingHit): void {
  const world = a.world;
  a.targets.set(d, hd.id);
  // Explods flagged removeongethit disappear when their owner is hit.
  if (!guarded) world.explods = world.explods.filter((e) => !(e.owner === d && e.removeOnGetHit));
  if (proj) {
    // Projectiles pause themselves (p1 pausetime) and count their hits.
    proj.hitTargets.add(d);
    proj.hitPause = guarded ? hd.guardPause[0] : hd.pause[0];
    proj.hitsLeft--;
    proj.missTimer = proj.missTime;
    const info = projInfo(a, proj.projId);
    info.contact = 0;
    if (guarded) info.guarded = 0;
    else info.hit = 0;
    if (proj.hitsLeft <= 0 && proj.removeOnHit) endProjectile(proj, proj.hitAnim);
  } else {
    a.hitTargets.add(d);
    // A HitDef is valid for a single hit; triggering it again re-arms it.
    a.hitDefActive = false;
    a.moveContact = 1;
    if (guarded) a.moveGuarded = 1;
    else a.moveHit = 1;
    a.hitPause = guarded ? hd.guardPause[0] : hd.pause[0];
    // The pause starts counting next tick; this tick still advances (measured).
    a.hitPauseFresh = true;
  }
  const src = proj ? { x: proj.x, y: proj.y } : { x: a.wx, y: a.wy };
  const towardA = src.x >= d.wx ? 1 : -1;
  // HitDef values are in the attacker's units; the defender stores its own.
  const conv = a.scale / d.scale;
  const sparkXY: [number, number] = [hd.sparkXY[0] * a.scale, hd.sparkXY[1] * a.scale];
  const facesA = d.facing === towardA;
  const xdir = facesA ? 1 : -1; // converts "away from attacker" velocities into d's frame
  const airborne = d.stateType === 'a';
  const g = d.ghv;

  if (guarded) {
    const dmg = scaleDamage(a, d, hd.guardDamage);
    d.pendingDamage = { amount: dmg, kill: hd.guardKill, delay: 1 };
    d.shakeFresh = true;
    g.guarded = 1;
    g.damage = dmg;
    g.hitshaketime = hd.guardPause[1];
    g.hittime = hd.guardHitTime;
    g.slidetime = hd.guardSlideTime;
    g.ctrltime = airborne ? hd.airGuardCtrlTime : hd.guardCtrlTime;
    g.xvel = (airborne ? hd.airGuardVel[0] : hd.guardVel) * xdir * conv;
    g.yvel = (airborne ? hd.airGuardVel[1] : 0) * conv;
    g.yaccel = hd.yaccel * conv;
    a.addPower(hd.getPower[1]);
    d.addPower(hd.givePower[1]);
    d.returnToOwnStates();
    // Guarding a hit takes control away and keeps the previous prevstateno
    // (measured: 130 -> 150 reports prevstateno 120).
    const prev = d.prevStateNo;
    d.ctrl = false;
    d.changeState(d.stateType === 'a' ? 154 : d.stateType === 'c' ? 152 : 150);
    d.prevStateNo = prev;
    if (!proj) cornerPush(a, d, airborne ? hd.airGuardCornerPush : hd.guardCornerPush);
    world.spawnSpark(a, d, hd.guardSpark, sparkXY, src);
    world.playHitSound(a, hd.guardSound);
  } else {
    const dmg = scaleDamage(a, d, hd.damage);
    // Damage lands on the following tick (measured against MUGEN 1.1).
    d.pendingDamage = { amount: dmg, kill: hd.kill, delay: 1 };
    d.shakeFresh = true;
    if (d.stateType === 'c' && hd.forceStand) d.stateType = 's';
    const wasFalling = d.moveType === 'h' && g.fall !== 0;
    const override = d.hitOverrides.find((o) => o && o.time !== 0 && attrMatches(o.attrs, hd.attrState, hd.attrType) && hd.p1StateNo < 0 && !(hd.p2StateNo >= 0 && hd.p2GetP1State));
    const inAir = d.stateType === 'a' || !!override?.forceAir;
    // Juggle points: reset on a fresh hit, spent on air hits.
    if (d.moveType !== 'h' || d.stateType !== 'a') d.juggleLeft = d.const('data.airjuggle');
    else d.juggleLeft -= hd.airJuggle;
    const vel = inAir ? hd.airVel : hd.groundVel;
    g.guarded = 0;
    g.damage = dmg;
    // Knock-down hits use fall.animtype (MUGEN shows anim 5030 for KFM's palm).
    const willFall = (inAir ? hd.airFall : hd.fall) || (wasFalling && !hd.forceNoFall);
    g.animtype = wasFalling || willFall ? hd.fallAnimType : inAir ? hd.airAnimType : hd.animType;
    g.groundtype = hd.groundType;
    g.airtype = hd.airType;
    g.type = inAir ? hd.airType : hd.groundType;
    g.hitshaketime = hd.pause[1];
    g.hittime = inAir || vel[1] !== 0 ? hd.airHitTime : hd.groundHitTime;
    g.slidetime = hd.groundSlideTime;
    g.xvel = vel[0] * xdir * conv;
    g.yvel = vel[1] * conv;
    g.yaccel = hd.yaccel * conv;
    g.fall = (inAir ? hd.airFall : hd.fall) || (wasFalling && !hd.forceNoFall) ? 1 : 0;
    g['fall.damage'] = hd.fallDamage;
    g['fall.xvel'] = hd.fallXVel === undefined ? Number.NaN : hd.fallXVel * conv;
    g['fall.yvel'] = hd.fallYVel * conv;
    g['fall.recover'] = hd.fallRecover ? 1 : 0;
    g['fall.recovertime'] = hd.fallRecoverTime;
    g['fall.kill'] = hd.fallKill ? 1 : 0;
    if (hd.fallEnvShake) {
      g['fall.envshake.time'] = hd.fallEnvShake.time;
      g['fall.envshake.freq'] = hd.fallEnvShake.freq;
      g['fall.envshake.ampl'] = hd.fallEnvShake.ampl;
      g['fall.envshake.phase'] = hd.fallEnvShake.phase;
    }
    if (hd.envShake) world.envShake = { ...hd.envShake };
    if (hd.palFx) d.palFx = { time: hd.palFx.time, elapsed: 0, add: hd.palFx.add, mul: hd.palFx.mul, sinAdd: [0, 0, 0], sinPeriod: 0, invertAll: hd.palFx.invertAll, color: hd.palFx.color };
    g.chainid = hd.id;
    g.hitcount = d.moveType === 'h' ? g.hitcount + 1 : 1;
    if (d.life - dmg <= 0 && hd.kill) g.fall = 1;
    if (!proj) a.hitCount += hd.numHits;
    a.addPower(hd.getPower[0]);
    d.addPower(hd.givePower[0]);
    const aFacing = proj ? proj.facing : a.facing;
    if (hd.p2Facing === 1) d.facing = aFacing;
    else if (hd.p2Facing === -1) d.facing = -aFacing;
    d.ctrl = false;
    if (hd.p2StateNo >= 0) {
      if (hd.p2GetP1State) d.stateOwner = a;
      else d.returnToOwnStates();
      d.changeState(hd.p2StateNo);
    } else {
      d.returnToOwnStates();
      const oldType = d.stateType;
      if (override && override.stateNo >= 0) d.changeState(override.stateNo);
      // A grounded defender hit by ground.type = Trip goes to 5070 (HITTRIP).
      else if (!inAir && hd.groundType === 3) d.changeState(5070);
      // By statetype only: common1's 5000/5010 switch to air themselves when yvel != 0.
      else d.changeState(inAir ? 5020 : d.stateType === 'c' ? 5010 : 5000);
      // The new statetype shows once the hit state first runs (measured: 5070).
      if (d.stateType !== oldType) {
        d.pendingStateType = d.stateType;
        d.stateType = oldType;
      }
    }
    d.moveType = 'h';
    if (!proj && !inAir && vel[1] === 0) cornerPush(a, d, hd.groundCornerPush);
    else if (!proj && inAir) cornerPush(a, d, hd.airCornerPush);
    world.spawnSpark(a, d, hd.spark, sparkXY, src);
    world.playHitSound(a, hd.hitSound);
  }
  d.sprPriority = hd.p2SprPriority;
  if (proj) return;
  a.sprPriority = hd.p1SprPriority;
  if (hd.p1GetP2Facing) a.facing = hd.p1GetP2Facing > 0 ? d.facing : -d.facing;
  else if (hd.p1Facing === -1) a.facing = -a.facing;
  if (!guarded && hd.p1StateNo >= 0) a.changeState(hd.p1StateNo);
}

/**
 * When the defender is pinned against a screen edge, the attacker is pushed
 * back instead (cornerpush.veloff, negative = away from the defender).
 */
function cornerPush(a: Player, d: Player, veloff: number): void {
  if (!veloff || a.stateType === 'a') return;
  const w = a.world;
  const awayFromA = d.wx >= a.wx ? 1 : -1;
  const edge = awayFromA > 0 ? w.camera.x + w.screenWidth / 2 : w.camera.x - w.screenWidth / 2;
  const room = Math.abs(edge - d.wx) - (awayFromA > 0 ? w.screenRight : w.screenLeft);
  if (room > 1) return;
  a.vel.x = Math.fround(veloff < 0 ? veloff : -veloff);
}

function scaleDamage(a: Player, d: Player, dmg: number): number {
  const att = a.const('data.attack') / 100;
  const def = 100 / Math.max(1, d.const('data.defence'));
  return Math.trunc(dmg * att * def * d.defenceMul);
}
