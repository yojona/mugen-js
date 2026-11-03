// Hit detection and resolution between players.
//
// Each tick, after states and physics, every active HitDef is tested:
// attacker Clsn1 boxes against defender Clsn2 boxes. Hits found in the same
// tick are applied together (so trades are possible). Exact ordering and timer
// alignment still need to be verified against the reference binary.

import type { Clsn } from '../formats/air';
import { clsnTouchInternal } from './ai-learn';
import { attrMatches, hitDefAttrBits, type HitDefData } from './hitdef';
import { endProjectile, noteProjContact, type Projectile } from './projectile';
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

/** HitFlags_Parse: hitflag / guardflag letters to mugen.exe's bits. */
function hitFlagBits(flags: string): number {
  let b = 2;
  for (const ch of flags.toLowerCase()) {
    if (ch === '+') b |= 0x100;
    else if (ch === '-') b &= ~2;
    else if (ch === 'a') b |= 0x10;
    else if (ch === 'd') b |= 0x40;
    else if (ch === 'f') b |= 0x20;
    else if (ch === 'h') b |= 4;
    else if (ch === 'l') b |= 8;
    else if (ch === 'm') b |= 0xc;
    else if (ch === 'p') b |= 0x80;
  }
  return b;
}

/**
 * Player_HitFlagMatches: lying down needs D; in a get-hit state the flag
 * must allow it (not "-"), and "+" only matches players in one (unless
 * guarding); a falling player needs F; then H, L or A by state type.
 */
function hitFlagMatches(d: Player, flags: string): boolean {
  const b = hitFlagBits(flags);
  const st = d.stateType;
  if (st === 'l' && !(b & 0x40)) return false;
  let checkPlus = true;
  if (d.moveType === 'h') {
    if (!(b & 2)) return false;
    if (!d.guardFlag) checkPlus = false;
  }
  if (checkPlus && b & 0x100) return false;
  if (d.moveType === 'h' && d.ghv.fall && !(b & 0x20)) return false;
  switch (st) {
    case 's':
      return (b & 4) !== 0;
    case 'c':
      return (b & 8) !== 0;
    case 'a':
      return (b & 0x10) !== 0;
    case 'l':
      return (b & 0x40) !== 0;
  }
  return false;
}

/**
 * Player_CanHit's juggle test: the attacker's target entry keeps the juggle
 * points left (its airjuggle when first hit); a HitDef costing more than
 * that does not hit. `cost` -1: no test.
 */
function juggleOk(a: Player, d: Player, cost: number): boolean {
  if (a.special.has('nojugglecheck') || cost === -1) return true;
  const left = a.targetJuggle.get(d);
  return left === undefined || left - cost >= 0;
}

function canHit(a: Player, hd: HitDefData, d: Player, cost: number): boolean {
  if (d.world.superPause?.owner === d && d.world.superPause.unhittable) return false;
  if (d.immuneTo(hd)) return false;
  if (!juggleOk(a, d, cost)) return false;
  return hitFlagMatches(d, hd.hitFlag);
}

/**
 * mugen.exe 0x43e4f3: a hit is guarded when the defender's guard flag
 * (p+0xee8) is up, set by this tick's built-in transitions or a guard state,
 * whatever state its controllers moved it to since (measured: a CPU holding
 * guard that starts a jab in the same tick still guards).
 */
export function isGuarding(d: Player): boolean {
  return d.guardFlag;
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
        if (clsnTouchInternal(d, 1, a, 1)) {
          applyReversal(d, a);
          continue;
        }
      }
      // Whole internal units, distance truncated, as for push (measured: a
      // KFM 1400 kick connecting at the edge of its reach).
      if (!clsnTouchInternal(d, 2, a, 1)) continue;
      if (!canHit(a, a.hitDef, d, a.juggleCost)) continue;
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

/**
 * Players_CheckHits applies the hits target by target, in player order on
 * odd frames and in reverse order on even ones (each target's attackers in
 * player order); `order` is that player list, `frame` g->frames.
 */
export function applyHits(hits: PendingHit[], order?: Player[], frame = 1): void {
  if (order && hits.length > 1) {
    const idx = (p: Player) => order.indexOf(p);
    const dir = frame & 1 ? 1 : -1;
    hits = [...hits].sort((x, y) => dir * (idx(x.defender) - idx(y.defender)) || idx(x.attacker) - idx(y.attacker));
  }
  for (const h of hits) {
    if (h.proj) {
      // Projectiles_HitPlayer checks and applies projectile hits one by one:
      // the juggle points left now, and a target just hit by a projectile
      // takes no other projectile this tick (nothitby 0x1FF).
      if (h.defender.projHitBlock && hitDefAttrBits(h.hd.attrState, h.hd.attrType) & ~0x1ff) continue;
      if (!juggleOk(h.attacker, h.defender, h.hd.airJuggle)) continue;
    }
    applyHit(h);
  }
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
 * Clsn_Collide (0x479B80) as mugen.exe computes it: boxes truncated to
 * internal (GameWidth) units relative to each origin, mirrored by facing,
 * the target offset by the truncated distance between origins; touching
 * edges collide.
 */
function intCollide(
  a: { x: number; y: number; facing: number; sx: number; sy: number; boxes: Clsn[] | null | undefined },
  t: { x: number; y: number; facing: number; sx: number; sy: number; boxes: Clsn[] | null | undefined },
  k: number,
): boolean {
  if (!a.boxes?.length || !t.boxes?.length) return false;
  const rel = (o: typeof a) =>
    o.boxes!.map((b) => {
      const x1 = Math.trunc(b.x1 * o.sx * k);
      const x2 = Math.trunc(b.x2 * o.sx * k);
      const y1 = Math.trunc(b.y1 * o.sy * k);
      const y2 = Math.trunc(b.y2 * o.sy * k);
      return o.facing < 0 ? { x1: -x2, x2: -x1, y1, y2 } : { x1, x2, y1, y2 };
    });
  const dx = Math.trunc((t.x - a.x) * k);
  const dy = Math.trunc((t.y - a.y) * k);
  for (const p of rel(a)) for (const q of rel(t)) if (q.x2 + dx >= p.x1 && q.x1 + dx <= p.x2 && q.y2 + dy >= p.y1 && q.y1 + dy <= p.y2) return true;
  return false;
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
      // Projectiles_HitPlayer: a projectile with hits left may hit the same
      // target again once its hit pause and miss time are over.
      if (d.side === pr.owner.side || (!d.alive && d.stateType === 'l')) continue;
      const k = d.world.gameWidth / d.world.screenWidth;
      const hitBox = intCollide(
        { x: pr.x, y: pr.y, facing: pr.facing, sx: pr.scale[0], sy: pr.scale[1], boxes: pr.anim.current?.clsn1 },
        { x: d.clsnX, y: d.clsnY, facing: d.facing, sx: d.const('size.xscale') * d.scale, sy: d.const('size.yscale') * d.scale, boxes: d.anim.current?.clsn2 },
        k,
      );
      if (!hitBox) continue;
      if (!canHit(pr.owner, pr.hd, d, pr.hd.airJuggle)) continue;
      const guarded = isGuarding(d) && stanceOk(pr.hd.guardFlag, d);
      hits.push({ attacker: pr.owner, defender: d, hd: pr.hd, guarded, proj: pr });
      break;
    }
  }
  return hits;
}

function cancel(pr: Projectile): void {
  noteProjContact(pr.owner, 3, pr.projId);
  endProjectile(pr, pr.cancelAnim);
}

function applyHit({ attacker: a, defender: d, hd, guarded, proj }: PendingHit): void {
  const world = a.world;
  a.targets.set(d, hd.id);
  // Player_AddTarget: a new entry starts with the attacker's airjuggle.
  if (!a.targetJuggle.has(d)) a.targetJuggle.set(d, a.const('data.airjuggle'));
  // Explods flagged removeongethit disappear when their owner is hit.
  if (!guarded) world.explods = world.explods.filter((e) => !(e.owner === d && !e.system && e.removeOnGetHit));
  if (proj) {
    // Projectiles pause themselves (p1 pausetime) and count their hits.
    proj.hitTargets.add(d);
    proj.hitPause = guarded ? hd.guardPause[0] : hd.pause[0];
    proj.hitsLeft--;
    proj.missTimer = proj.missTime;
    noteProjContact(a, guarded ? 1 : 2, proj.projId);
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
  // HitDef_Apply / Player_Guard: the target loses any hit pause of its own
  // (a trade: the hit taken cancels the pause of the hit given).
  d.hitPause = 0;
  d.hitPauseFresh = false;
  const src = proj ? { x: proj.x, y: proj.y } : { x: a.wx, y: a.wy };
  const towardA = src.x >= d.wx ? 1 : -1;
  // HitDef values are in the attacker's units; the defender stores its own.
  const conv = a.scale / d.scale;
  const sparkXY: [number, number] = [hd.sparkXY[0] * a.scale, hd.sparkXY[1] * a.scale];
  const facesA = d.facing === towardA;
  // Hit and guard velocities push along the attacker's facing (the
  // projectile's for projectiles; p1facing = -1 turns it), whichever side
  // the defender is on (mugen.exe HitDef_Apply / Player_Guard: vel x times
  // -dir, dir = attacker facing). xdir turns that into d's own frame.
  const dir = (proj ? proj.facing : a.facing) * (!proj && hd.p1Facing === -1 ? -1 : 1);
  const xdir = -dir * d.facing === 1 ? 1 : -1;
  const airborne = d.stateType === 'a';
  const g = d.ghv;

  if (guarded) {
    const dmg = scaleDamage(a, d, hd.guardDamage);
    d.pendingDamage = { amount: dmg, kill: hd.guardKill, tick: world.gameTime };
    d.shakeTick = world.gameTime;
    g.guarded = 1;
    g.damage = dmg;
    // A guarded hit never falls (measured: the CPU skips its air-recovery
    // roll in 151 after an earlier knock-down).
    g.fall = 0;
    g.hitshaketime = hd.guardPause[1];
    // An air guard has no hit time: HitOver is 1 at once (measured: 154).
    g.hittime = airborne ? -1 : hd.guardHitTime;
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
    const oldVel = { x: d.vel.x, y: d.vel.y };
    d.changeState(d.stateType === 'a' ? 154 : d.stateType === 'c' ? 152 : 150);
    // As with hits, the guard statedef's velset shows once it runs (measured: 154).
    if (d.vel.x !== oldVel.x || d.vel.y !== oldVel.y) {
      d.pendingVel = { x: d.vel.x, y: d.vel.y };
      d.vel.x = oldVel.x;
      d.vel.y = oldVel.y;
    }
    // Guarding a hit marks the defender as guarding (mugen.exe 0x43fad3).
    d.guardFlag = true;
    d.prevStateNo = prev;
    if (!proj) cornerPush(a, d, airborne ? hd.airGuardCornerPush : hd.guardCornerPush);
    world.spawnSpark(a, d, hd.guardSpark, sparkXY, src);
    world.playHitSound(a, hd.guardSound);
  } else {
    const dmg = scaleDamage(a, d, hd.damage);
    // HitDef_Apply: a player hit is not guarding any more.
    d.guardFlag = false;
    // Damage lands on the following tick (measured against MUGEN 1.1).
    d.pendingDamage = { amount: dmg, kill: hd.kill, tick: world.gameTime };
    d.shakeTick = world.gameTime;
    // A crouching defender stands for a forcestand HitDef or a killing hit
    // (mugen.exe 0x43f1bb: the kill flag also selects 5000 over 5010).
    const killsNow = hd.kill && d.life - dmg <= 0;
    if (d.stateType === 'c' && (hd.forceStand || killsNow)) d.stateType = 's';
    const wasFalling = d.moveType === 'h' && g.fall !== 0;
    const override = d.hitOverrides.find((o) => o && o.time !== 0 && attrMatches(o.attrs, hd.attrState, hd.attrType) && hd.p1StateNo < 0 && !(hd.p2StateNo >= 0 && hd.p2GetP1State));
    const inAir = d.stateType === 'a' || !!override?.forceAir;
    // Juggle points (Player_Hit): a hit on a falling target, a fall = 1 hit or an air.fall
    // hit in the air, spends the HitDef's juggle from the attacker's target
    // entry; the HitDef then costs nothing more until a state sets it.
    if (!proj && !override && (wasFalling || hd.fall || (hd.airFall && d.stateType === 'a'))) {
      a.targetJuggle.set(d, (a.targetJuggle.get(d) ?? a.const('data.airjuggle')) - Math.max(0, a.juggleCost));
      a.juggleCost = 0;
    }
    const vel = inAir ? hd.airVel : hd.groundVel;
    g.guarded = 0;
    g.damage = dmg;
    // Knock-down hits use fall.animtype (MUGEN shows anim 5030 for KFM's palm).
    // A killing hit always knocks down (measured: KFM's 1410 KO plays the
    // fall animtype, anim 5030).
    const kills = hd.kill && d.life - dmg <= 0;
    const willFall = (inAir ? hd.airFall : hd.fall) || (wasFalling && !hd.forceNoFall) || kills;
    g.animtype = wasFalling || willFall ? hd.fallAnimType : inAir ? hd.airAnimType : hd.animType;
    g.groundtype = hd.groundType;
    g.airtype = hd.airType;
    g.type = inAir ? hd.airType : hd.groundType;
    g.hitshaketime = hd.pause[1];
    // A hit during a Pause / SuperPause lets the target move for its shake
    // (HitDef_Apply: pause_movetime = max(pause_movetime, p2 pausetime)).
    // (pause_kind is set from the frame after a pause starts.)
    if (world.superPause && !world.superPause.fresh) d.superMoveTime = Math.max(d.superMoveTime, hd.pause[1]);
    else if (!world.superPause && world.pause && !world.pause.fresh) d.pauseMoveTime = Math.max(d.pauseMoveTime, hd.pause[1]);
    // Falling hits use air.hittime too (measured: KFM's throw, fall = 1 and
    // no hittime given, sets 20).
    g.hittime = inAir || vel[1] !== 0 || willFall ? hd.airHitTime : hd.groundHitTime;
    g.slidetime = hd.groundSlideTime;
    let [vx, vy] = vel;
    // A killing hit throws the defender (mugen.exe 0x43f29a): ground hits
    // with no y velocity keep 0.66 of x; x gains 2.5 outwards, y loses 2 and
    // is at most -6 (measured: KFM's 1410 KO sends P2 at -8.44, -6).
    if (kills) {
      if (vy === 0) vx = Math.fround(vx * 0.66);
      if (vx !== 0) vx = Math.fround(vx + Math.sign(vx) * 2.5);
      if (vy <= 0) vy = Math.min(Math.fround(vy - 2), -6);
    }
    g.xvel = vx * xdir * conv;
    g.yvel = vy * conv;
    g.yaccel = hd.yaccel * conv;
    g.fall = willFall ? 1 : 0;
    if (proj) {
      // A projectile spends its juggle on a target it leaves falling.
      if (!override && g.fall && hd.airJuggle !== -1) {
        a.targetJuggle.set(d, (a.targetJuggle.get(d) ?? a.const('data.airjuggle')) - hd.airJuggle);
        hd.airJuggle = 0;
      }
      d.projHitBlock = true;
    }    d.airJumpsLeft = 0;
    d.recoverFresh = true;
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
    // Applied when P2 next updates (measured: one tick after the hit).
    if (!proj) {
      // HitDef_Apply works out mindist/maxdist (and snap) as offsets from the
      // positions at the hit; the target moves by them in its next update.
      const [xoff, yoff] = placementOffsets(a, d, hd, dir);
      if (xoff || yoff) {
        d.pendingPlacement = () => {
          d.setWorldPos(d.wx + xoff, d.wy + yoff);
          // Not past the screen edge (measured: a cornered P2 stays put).
          world.clampToScreenOne(d);
        };
      }
    }
    // p2facing = 1 turns P2 to face P1, -1 away from it (measured: KFM's
    // Smash Kung Fu Upper).
    if (hd.p2Facing === 1) d.facing = -aFacing;
    else if (hd.p2Facing === -1) d.facing = aFacing;
    // A light/medium/hard hit from behind swaps High and Low in the hit
    // types (mugen.exe 0x43f3e1; measured: KFM's jump kick into a crossed-up
    // P2 shows anim 5010).
    if (g.animtype >= 0 && g.animtype <= 2 && d.facing !== (hd.p2Facing === -1 ? aFacing : -aFacing)) {
      const swap = (t: number) => (t === 1 ? 2 : t === 2 ? 1 : t);
      g.groundtype = swap(g.groundtype);
      g.airtype = swap(g.airtype);
    }
    d.ctrl = false;
    {
      d.returnToOwnStates();
      const oldType = d.stateType;
      const oldVel = { x: d.vel.x, y: d.vel.y };
      if (override && override.stateNo >= 0) d.changeState(override.stateNo);
      // A grounded defender hit by ground.type = Trip goes to 5070 (HITTRIP).
      else if (!inAir && hd.groundType === 3) d.changeState(5070);
      // By statetype only: common1's 5000/5010 switch to air themselves when yvel != 0.
      else d.changeState(inAir ? 5020 : d.stateType === 'c' ? 5010 : 5000);
      // p2stateno passes through the common hit state first (measured: KFM's
      // Fast Kung Fu Palm shows 1025 with prevstateno 5000).
      if (hd.p2StateNo >= 0) {
        if (hd.p2GetP1State) d.stateOwner = a;
        d.changeState(hd.p2StateNo);
      }
      // The new statetype shows once the hit state first runs (measured: 5070).
      if (d.stateType !== oldType) {
        d.pendingStateType = d.stateType;
        d.stateType = oldType;
      }
      // So does the statedef's velset (measured: a walking P2 hit into 5000
      // still shows its walk speed that tick).
      if (d.vel.x !== oldVel.x || d.vel.y !== oldVel.y) {
        d.pendingVel = { x: d.vel.x, y: d.vel.y };
        d.vel.x = oldVel.x;
        d.vel.y = oldVel.y;
      }
    }
    d.moveType = 'h';
    if (!proj) cornerPush(a, d, inAir ? hd.airCornerPush : hd.groundCornerPush);
    world.spawnSpark(a, d, hd.spark, sparkXY, src);
    world.playHitSound(a, hd.hitSound);
  }
  d.sprPriority = hd.p2SprPriority;
  if (proj) return;
  a.sprPriority = hd.p1SprPriority;
  if (hd.p1GetP2Facing) a.facing = hd.p1GetP2Facing > 0 ? d.facing : -d.facing;
  else if (hd.p1Facing === -1) a.facing = -a.facing;
  // p1stateno: the statedef applies when the state first runs (measured: a
  // KFM throw keeps anim 800 and its MoveContact on the hit tick).
  if (!guarded && hd.p1StateNo >= 0) a.enterLater(hd.p1StateNo);
}

/**
 * When the defender is pinned against a screen edge, the attacker is pushed
 * back instead (cornerpush.veloff, negative = away from the defender).
 */
function cornerPush(a: Player, d: Player, veloff: number): void {
  // (A cornerpush of 0 still replaces, i.e. stops, any push going on.)
  // mugen.exe 0x4342f0: the defender is cornered within 5 internal units
  // of either of its screen limits (measured: 2.4 stage units still push).
  const w = a.world;
  const [lo, hi] = w.screenLimits(d);
  const k = w.gameWidth / w.screenWidth;
  if (!(Math.abs(d.wx - lo) * k < 5 || Math.abs(d.wx - hi) * k < 5)) return;
  // A separate push, not vel x: it moves the attacker back after its hit
  // pause, decaying by 0.7 per tick (measured: 14.3, 10.01, 7.007, ... with
  // vel x staying 0).
  // Player_CornerPush: push_vel = cornerpush * facing, kept in world space.
  a.cornerPushVel = veloff * a.facing;
}

/**
 * HitDef snap / mindist / maxdist: P2's position relative to P1 (x along P1's
 * facing, y downwards), in P1's units (measured: KFM's Smash Kung Fu Upper
 * lifts a standing P2 to maxdist's y = -10).
 */
function placementOffsets(a: Player, d: Player, hd: HitDefData, dir: number): [number, number] {
  // In mugen.exe's internal units and precision: the attacker's position
  // comes in as floats, the offsets are floats (gethit_xoff / yoff).
  const f = Math.fround;
  const K = a.world.gameWidth / a.world.screenWidth;
  const k = a.scale * K;
  const minX = hd.snap[0] ?? hd.minDist[0];
  const maxX = hd.snap[0] ?? hd.maxDist[0];
  const minY = hd.snap[1] ?? hd.minDist[1];
  const maxY = hd.snap[1] ?? hd.maxDist[1];
  const ax = f(a.wx * K);
  const ay = f(a.wy * K);
  const tx = d.wx * K;
  const ty = d.wy * K;
  let xoff = 0;
  let yoff = 0;
  const dy = ty - ay;
  if (minX !== undefined && Math.abs(tx - ax) < minX * k) xoff = f(ax + dir * minX * k - tx + xoff);
  if (minY !== undefined && minY * k > dy) yoff = f(minY * k + ay - ty + yoff);
  if (maxX !== undefined && Math.abs(ax - tx) > maxX * k) xoff = f(ax + dir * maxX * k - tx + xoff);
  if (maxY !== undefined && maxY * k < dy) yoff = f(maxY * k + ay - ty + yoff);
  return [xoff / K, yoff / K];
}

/**
 * Player_HitDamage (0x43F930): the HitDef's damage (already scaled by the
 * attacker's attack when it ran) times the defender's defence multiplier,
 * rounded; at least 1 for a positive damage.
 */
function scaleDamage(_a: Player, d: Player, dmg: number): number {
  const n = Math.trunc(d.defenceFactor * dmg + 0.5);
  return dmg >= 1 && n === 0 ? 1 : n;
}
