// Hit detection and resolution between players.
//
// Each tick, after states and physics, every active HitDef is tested:
// attacker Clsn1 boxes against defender Clsn2 boxes. Hits found in the same
// tick are applied together (so trades are possible). Exact ordering and timer
// alignment still need to be verified against the reference binary.

import type { Clsn } from '../formats/air';
import type { HitDefData } from './hitdef';
import type { Player } from './player';

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function worldBoxes(p: Player, boxes: Clsn[] | null): Box[] {
  if (!boxes) return [];
  const sx = p.const('size.xscale');
  const sy = p.const('size.yscale');
  return boxes.map((b) => {
    const xa = p.pos.x + p.facing * b.x1 * sx;
    const xb = p.pos.x + p.facing * b.x2 * sx;
    return { x1: Math.min(xa, xb), x2: Math.max(xa, xb), y1: p.pos.y + b.y1 * sy, y2: p.pos.y + b.y2 * sy };
  });
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

function canHit(hd: HitDefData, d: Player): boolean {
  const f = hd.hitFlag;
  if (f.includes('+') && d.moveType !== 'h') return false;
  if (f.includes('-') && d.moveType === 'h') return false;
  // Falling opponents (in the air or on the way down) need "F".
  if (d.moveType === 'h' && d.ghv.fall && d.stateType === 'a') return f.includes('f') || f.includes('a');
  if (!stanceOk(f, d)) return false;
  return !d.immuneTo(hd);
}

export function isGuarding(d: Player): boolean {
  return d.stateNo >= 120 && d.stateNo <= 155;
}

export interface PendingHit {
  attacker: Player;
  defender: Player;
  hd: HitDefData;
  guarded: boolean;
}

export function detectHits(players: Player[]): PendingHit[] {
  const hits: PendingHit[] = [];
  for (const a of players) {
    if (!a.hitDefActive || !a.hitDef || a.hitPause > 0) continue;
    const el = a.anim.current;
    const atk = worldBoxes(a, el?.clsn1 ?? null);
    if (!atk.length) continue;
    for (const d of players) {
      if (d === a || d.side === a.side || (!d.alive && d.stateType === 'l')) continue;
      if (a.hitTargets.has(d)) continue;
      const hurt = worldBoxes(d, d.anim.current?.clsn2 ?? null);
      if (!overlap(atk, hurt)) continue;
      if (!canHit(a.hitDef, d)) continue;
      const guarded = isGuarding(d) && stanceOk(a.hitDef.guardFlag, d);
      hits.push({ attacker: a, defender: d, hd: a.hitDef, guarded });
    }
  }
  return hits;
}

export function applyHits(hits: PendingHit[]): void {
  for (const h of hits) applyHit(h);
}

function applyHit({ attacker: a, defender: d, hd, guarded }: PendingHit): void {
  const world = a.world;
  a.hitTargets.add(d);
  // A HitDef is valid for a single hit; triggering it again re-arms it.
  a.hitDefActive = false;
  a.moveContact = 1;
  if (guarded) a.moveGuarded = 1;
  else a.moveHit = 1;
  a.hitPause = guarded ? hd.guardPause[0] : hd.pause[0];
  const towardA = a.pos.x >= d.pos.x ? 1 : -1;
  const facesA = d.facing === towardA;
  const xdir = facesA ? 1 : -1; // converts "away from attacker" velocities into d's frame
  const airborne = d.stateType === 'a';
  const g = d.ghv;

  if (guarded) {
    const dmg = scaleDamage(a, d, hd.guardDamage);
    d.life = Math.max(hd.guardKill ? 0 : Math.min(d.life, 1), d.life - dmg);
    g.guarded = 1;
    g.damage = dmg;
    g.hitshaketime = hd.guardPause[1];
    g.hittime = hd.guardHitTime;
    g.slidetime = hd.guardSlideTime;
    g.ctrltime = airborne ? hd.airGuardCtrlTime : hd.guardCtrlTime;
    g.xvel = (airborne ? hd.airGuardVel[0] : hd.guardVel) * xdir;
    g.yvel = airborne ? hd.airGuardVel[1] : 0;
    g.yaccel = hd.yaccel;
    a.addPower(hd.getPower[1]);
    d.addPower(hd.givePower[1]);
    d.changeState(d.stateType === 'a' ? 154 : d.stateType === 'c' ? 152 : 150);
    world.spawnSpark(a, d, hd.guardSpark, hd.sparkXY);
    world.playHitSound(a, hd.guardSound);
  } else {
    const dmg = scaleDamage(a, d, hd.damage);
    d.life = Math.max(hd.kill ? 0 : Math.min(d.life, 1), d.life - dmg);
    if (d.stateType === 'c' && hd.forceStand) d.stateType = 's';
    const wasFalling = d.moveType === 'h' && g.fall !== 0;
    const inAir = d.stateType === 'a';
    const vel = inAir ? hd.airVel : hd.groundVel;
    g.guarded = 0;
    g.damage = dmg;
    g.animtype = wasFalling ? hd.fallAnimType : inAir ? hd.airAnimType : hd.animType;
    g.groundtype = hd.groundType;
    g.airtype = hd.airType;
    g.type = inAir ? hd.airType : hd.groundType;
    g.hitshaketime = hd.pause[1];
    g.hittime = inAir || vel[1] !== 0 ? hd.airHitTime : hd.groundHitTime;
    g.slidetime = hd.groundSlideTime;
    g.xvel = vel[0] * xdir;
    g.yvel = vel[1];
    g.yaccel = hd.yaccel;
    g.fall = (inAir ? hd.airFall : hd.fall) || (wasFalling && !hd.forceNoFall) ? 1 : 0;
    g['fall.damage'] = hd.fallDamage;
    g['fall.xvel'] = hd.fallXVel ?? Number.NaN;
    g['fall.yvel'] = hd.fallYVel;
    g['fall.recover'] = hd.fallRecover ? 1 : 0;
    g['fall.recovertime'] = hd.fallRecoverTime;
    g['fall.kill'] = hd.fallKill ? 1 : 0;
    g.chainid = hd.id;
    g.hitcount = d.moveType === 'h' ? g.hitcount + 1 : 1;
    if (d.life <= 0) {
      d.alive = false;
      g.fall = 1;
    }
    a.hitCount += hd.numHits;
    a.addPower(hd.getPower[0]);
    d.addPower(hd.givePower[0]);
    if (hd.p2Facing === 1) d.facing = a.facing;
    else if (hd.p2Facing === -1) d.facing = -a.facing;
    d.ctrl = false;
    if (hd.p2StateNo >= 0) d.changeState(hd.p2StateNo);
    else d.changeState(d.stateType === 'a' || vel[1] !== 0 ? 5020 : d.stateType === 'c' ? 5010 : 5000);
    d.moveType = 'h';
    world.spawnSpark(a, d, hd.spark, hd.sparkXY);
    world.playHitSound(a, hd.hitSound);
  }
  a.sprPriority = hd.p1SprPriority;
  d.sprPriority = hd.p2SprPriority;
  if (hd.p1GetP2Facing) a.facing = hd.p1GetP2Facing > 0 ? d.facing : -d.facing;
  else if (hd.p1Facing === -1) a.facing = -a.facing;
  if (!guarded && hd.p1StateNo >= 0) a.changeState(hd.p1StateNo);
}

function scaleDamage(a: Player, d: Player, dmg: number): number {
  const att = a.const('data.attack') / 100;
  const def = 100 / Math.max(1, d.const('data.defence'));
  return Math.trunc(dmg * att * def * d.defenceMul);
}
