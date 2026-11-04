// Hit detection and resolution between players.
//
// Each tick, after states and physics, every active HitDef is tested:
// attacker Clsn1 boxes against defender Clsn2 boxes. Hits found in the same
// tick are applied together (so trades are possible). Exact ordering and timer
// alignment still need to be verified against the reference binary.

import type { Clsn } from '../formats/air';
import { clsnTouchInternal, guardFlagBits } from './ai-learn';
import { attrMatches, hitDefAttrBits, type HitDefData } from './hitdef';
import { endProjectile, noteProjContact, type Projectile } from './projectile';
import { makeEnvShake } from './fx';
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
function hitFlagMatches(d: Player, flags: string, guard = false): boolean {
  // A guardflag that is not given is 0 (hitflag defaults to its letters' 2).
  const b = guard ? guardFlagBits(flags) : hitFlagBits(flags);
  const st = d.stateType;
  if (st === 'l' && !(b & 0x40)) return false;
  let checkPlus = true;
  if (d.moveType === 'h') {
    if (!(b & 2)) return false;
    if (!d.guardFlag) checkPlus = false;
  }
  if (checkPlus && b & 0x100) return false;
  if (d.ghv.fall && !(b & 0x20)) return false;
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

function canHit(a: Player, hd: HitDefData, d: Player, cost: number, proj = false): boolean {
  if (d.nohitTime > 0) return false;
  // Player_CanHit: chainID needs the target's last hit to be that ID from
  // this attacker; nochainID refuses it. (A chainID equal to a nochainID
  // clears all three, HitDef_SetFromParams.)
  if (!proj) {
    const [n0, n1] = hd.noChainId;
    const clear = hd.chainId !== -1 && (hd.chainId === n0 || hd.chainId === n1);
    const by = d.ghvAttacker === a;
    if (!clear && hd.chainId !== -1 && (d.ghv.chainid !== hd.chainId || !by)) return false;
    if (!clear && n0 !== -1 && by && (d.ghv.chainid === n0 || (n1 !== -1 && d.ghv.chainid === n1))) return false;
  }
  if (!juggleOk(a, d, cost)) return false;
  // Player_CanHit: past the juggle test the attacker's hitdef_juggle takes
  // the HitDef's juggle (only without nojugglecheck): every hit of this tick
  // spends that, even after the first one zeroes the HitDef's.
  if (!proj && !a.special.has('nojugglecheck')) a.hitdefJuggle = cost;
  if (!hitFlagMatches(d, hd.hitFlag)) return false;
  // HitDef_SetStateAttr: the attacker's HitDef takes its current state type
  // (S/C/A bits) before the HitBy test.
  if (!proj) hd.attrState = a.stateType === 's' || a.stateType === 'c' || a.stateType === 'a' ? a.stateType : '';
  return !d.immuneTo(hd);
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
    // Player_CanHit: an active HitDef of a player not idle; its own hit
    // pause does not stop it from hitting someone else.
    if (!a.hitDefActive || !a.hitDef || a.moveType === 'i') continue;
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
      // Player_Hit: guarding needs the guardflag to match like a hitflag.
      const guarded = isGuarding(d) && hitFlagMatches(d, a.hitDef.guardFlag, true) && !a.special.has('unguardable');
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
    // Players_CheckHits: guarding plays no part in it.
    if (!rev) {
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
  a.hitDefSet = false;
  // move_contact is one value: the reverser hit, the attacker was reversed.
  r.moveContact = r.moveHit = 1;
  r.moveGuarded = r.moveReversed = 0;
  a.moveReversed = 1;
  a.moveContact = a.moveHit = a.moveGuarded = 0;
  // Player_Reverse: the reversed player cannot be hit for the pause (nor the
  // reverser after a throw reversal).
  a.nohitTime = rv.hd.pause[0] + 1;
  if (hitDefAttrBits(rv.hd.attrState, rv.hd.attrType) & 0x1c0) r.nohitTime = rv.hd.pause[0] + 1;
  // Player_Reverse: the reverser counts the hits and gets its power.
  r.hitCount += rv.hd.numHits;
  r.uniqHitCount += rv.hd.numHits;
  r.world.comboAdded[r.side]! += rv.hd.numHits;
  r.addPower(rv.hd.getPower[0]);
  // hitpause_next on both sides: the pause starts counting next tick.
  r.hitPause = rv.hd.pause[0];
  a.hitPause = rv.hd.pause[1];
  r.hitPauseFresh = a.hitPauseFresh = true;
  r.targets.set(a, rv.hd.id);
  r.world.spawnSpark(r, a, rv.hd.spark, [(rv.hd.sparkXY[0] + (a.hitDef?.sparkXY[0] ?? 0)) * r.scale, (rv.hd.sparkXY[1] + (a.hitDef?.sparkXY[1] ?? 0)) * r.scale], { x: r.wx, y: r.wy });
  r.world.playHitSound(r, rv.hd.hitSound);
  if (rv.hd.p1StateNo >= 0) r.changeState(rv.hd.p1StateNo);
  // Player_Reverse: p2getp1state makes the attacker a hit player right away
  // (its new statedef only applies after the hit pause).
  if (rv.hd.p2GetP1State) {
    a.stateOwner = r;
    a.moveType = 'h';
  }
  if (rv.hd.p2StateNo >= 0) {
    a.changeState(rv.hd.p2StateNo);
    a.ctrl = false;
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
    const xa = pr.x + pr.facing * b.x1 * pr.clsnScale[0];
    const xb = pr.x + pr.facing * b.x2 * pr.clsnScale[0];
    return { x1: Math.min(xa, xb), x2: Math.max(xa, xb), y1: pr.y + b.y1 * pr.clsnScale[1], y2: pr.y + b.y2 * pr.clsnScale[1] };
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
 * Projectiles hitting players' Clsn2 boxes: Players_CheckHits calls
 * Projectiles_HitPlayer for each pair of players in list order (the first's
 * projectiles against the second, then the other way). A projectile may hit
 * several players in one tick: its hit count and pause only change
 * afterwards (hit_pending, Projectiles_ApplyHits).
 */
export function detectProjectileHits(projs: Projectile[], players: Player[]): PendingHit[] {
  const hits: PendingHit[] = [];
  const hitPlayer = (owner: Player, d: Player) => {
    if (d.side === owner.side || (!d.alive && d.stateType === 'l')) return;
    for (const pr of projs) {
      if (pr.owner !== owner || pr.phase !== 'active' || pr.hitPause > 0) continue;
      if (pr.hitsLeft <= 0 || pr.missTimer > 0) continue;
      const atk = projBoxes(pr, 1);
      if (!atk.length) continue;
      const k = d.world.gameWidth / d.world.screenWidth;
      const hitBox = intCollide(
        { x: pr.x, y: pr.y, facing: pr.facing, sx: pr.clsnScale[0], sy: pr.clsnScale[1], boxes: pr.anim.current?.clsn1 },
        { x: d.clsnX, y: d.clsnY, facing: d.facing, sx: d.const('size.xscale') * d.scale, sy: d.const('size.yscale') * d.scale, boxes: d.anim.current?.clsn2 },
        k,
      );
      if (!hitBox) continue;
      if (!canHit(pr.owner, pr.hd, d, pr.hd.airJuggle)) continue;
      const guarded = isGuarding(d) && hitFlagMatches(d, pr.hd.guardFlag, true) && !pr.owner.special.has('unguardable');
      hits.push({ attacker: pr.owner, defender: d, hd: pr.hd, guarded, proj: pr });
    }
  };
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      hitPlayer(players[i]!, players[j]!);
      hitPlayer(players[j]!, players[i]!);
    }
  }
  return hits;
}

/** Projectiles_ApplyHits: each projectile that hit this tick loses one hit and takes its pause. */
export function applyProjectileHits(projs: Projectile[]): void {
  for (const pr of projs) {
    if (!pr.hitPending) continue;
    pr.hitPending = false;
    pr.hitsLeft--;
    // The last hit of a removeonhit projectile sets no pause or miss time.
    const last = pr.hitsLeft <= 0 && pr.removeOnHit;
    pr.hitPause = last ? 0 : pr.hd.pause[0];
    pr.missTimer = last ? 0 : pr.missTime;
    if (last) endProjectile(pr, pr.hitAnim);
  }
}

/**
 * Player_HitProjectiles, for each pair of players both ways: an attacking
 * player's active HitDef with the P hitflag hits the other's projectiles
 * (Clsn1 against their Clsn2): the HitDef goes off, its p1stateno runs, the
 * projectile loses a hit and is removed at none left (removeonhit), else
 * pauses for its p1 pausetime.
 */
export function hitProjectilesByHitDefs(projs: Projectile[], order: Player[]): void {
  const one = (p: Player, owner: Player) => {
    const hd = p.hitDef;
    if (!hd || !(hitFlagBits(hd.hitFlag) & 0x80) || p.moveType === 'i' || !p.hitDefActive) return;
    for (const pr of projs) {
      if (pr.owner !== owner || pr.phase !== 'active' || owner.side === p.side) continue;
      if (pr.hitPause > 0 || pr.missTimer > 0 || pr.hitsLeft <= 0) continue;
      const k = p.world.gameWidth / p.world.screenWidth;
      const touch = intCollide(
        { x: pr.x, y: pr.y, facing: pr.facing, sx: pr.clsnScale[0], sy: pr.clsnScale[1], boxes: pr.anim.current?.clsn2 },
        { x: p.clsnX, y: p.clsnY, facing: p.facing, sx: p.const('size.xscale') * p.scale, sy: p.const('size.yscale') * p.scale, boxes: p.anim.current?.clsn1 },
        k,
      );
      if (!touch) continue;
      p.hitDefActive = false;
      if (hd.p1StateNo >= 0) p.changeState(hd.p1StateNo);
      pr.hitsLeft--;
      if (pr.hitsLeft <= 0 && pr.removeOnHit) endProjectile(pr, pr.remAnim, pr.remVel);
      else pr.hitPause = pr.hd.pause[0];
    }
  };
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      one(order[i]!, order[j]!);
      one(order[j]!, order[i]!);
    }
  }
}

/**
 * Projectiles_Collide, for each pair of players in list order: each active
 * projectile of the first meets at most one of the second (Clsn2 against
 * Clsn2); one with priority lower or equal loses a hit (and the other a
 * priority point), at no hits left it is cancelled, else it pauses for its
 * p1 pausetime.
 */
export function collideProjectiles(projs: Projectile[], order: Player[]): void {
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const A = order[i]!;
      const B = order[j]!;
      const lb = projs.filter((q) => q.owner === B);
      if (!lb.length) continue;
      for (const pa of projs.filter((q) => q.owner === A)) {
        if (pa.phase !== 'active' || !pa.anim.current?.clsn2?.length) continue;
        for (const pb of lb) {
          if (pb.phase !== 'active' || pa.owner.side === pb.owner.side) continue;
          const k = A.world.gameWidth / A.world.screenWidth;
          const touch = intCollide(
            { x: pa.x, y: pa.y, facing: pa.facing, sx: pa.clsnScale[0], sy: pa.clsnScale[1], boxes: pa.anim.current.clsn2 },
            { x: pb.x, y: pb.y, facing: pb.facing, sx: pb.clsnScale[0], sy: pb.clsnScale[1], boxes: pb.anim.current?.clsn2 },
            k,
          );
          if (!touch) continue;
          let decA = false;
          if (pa.priority <= pb.priority) {
            pa.hitsLeft--;
            decA = true;
          }
          if (pa.hitsLeft <= 0) cancel(pa);
          else pa.hitPause = pa.hd.pause[0];
          if (pb.priority <= pa.priority) {
            pa.priority--;
            pb.hitsLeft--;
          }
          if (pb.hitsLeft <= 0) cancel(pb);
          else pb.hitPause = pb.hd.pause[0];
          if (decA) pb.priority--;
          break;
        }
      }
    }
  }
}

function cancel(pr: Projectile): void {
  noteProjContact(pr.owner, 3, pr.projId);
  endProjectile(pr, pr.cancelAnim);
}

function applyHit({ attacker: a, defender: d, hd, guarded: guardedIn, proj }: PendingHit): void {
  const world = a.world;
  // Player_Hit: a hitonce HitDef (the throws' default) goes off at its
  // first hit and lets go of every other target of the attacker.
  if (!proj && hd.hitOnce) {
    if (!a.hitDefActive) return;
    a.releaseTargets(d);
  }
  // Player_Hit / Projectiles_HitPlayer: a guard the defender would not
  // survive (life left after everything pending) is a KO hit instead
  // (guard_ko is always on).
  let guarded = guardedIn;
  let guardKo = false;
  if (guarded && d.life - previewDamage(d, hd.guardDamage, hd.guardKill) <= 0) {
    guarded = false;
    guardKo = true;
  }
  // Player_Hit: a HitOverride matching a HitDef with p1stateno or
  // p2getp1state (a throw) makes the hit do nothing at all.
  if (!proj && (hd.p1StateNo >= 0 || hd.p2GetP1State) && d.hitOverrides.some((o) => overrides(o, hd))) return;
  a.targets.set(d, hd.id);
  // Player_Hit / Projectiles_HitPlayer: unless a HitOverride takes the hit,
  // the attacker's target entry loses its TargetBind (a hit at the end of a
  // hold lets the target go).
  const overridden = d.hitOverrides.some((o) => overrides(o, hd));
  if (!overridden && d.bind?.byTarget && d.bind.to === a) d.bind.time = 0;
  // Player_AddTarget: a new entry starts with the attacker's airjuggle.
  if (!a.targetJuggle.has(d)) a.targetJuggle.set(d, a.const('data.airjuggle'));
  // HitDef_Apply: a HitDef with ground.type (air.type in the air) = None
  // has no get-hit state for the target: only the sound and the spark, no
  // pause, damage, power or contact (Player_Hit sees 0).
  if (!guarded && !proj && (d.stateType === 'a' ? hd.airType : hd.groundType) === 0 && !d.hitOverrides.some((o) => overrides(o, hd))) {
    a.hitTargets.add(d);
    d.ghv.chainid = hd.id;
    d.ghvAttacker = a;
    world.playHitSound(a, hd.hitSound);
    world.spawnSpark(a, d, hd.spark, [hd.sparkXY[0] * a.scale, hd.sparkXY[1] * a.scale], { x: a.wx, y: a.wy });
    return;
  }
  // HitDef_Apply: a hit player lets go of its own targets and loses its
  // removeongethit explods.
  if (!guarded) {
    d.releaseTargets();
    world.explods = world.explods.filter((e) => !(e.owner === d && !e.system && e.removeOnGetHit));
  }
  if (proj) {
    // Projectiles pause themselves (p1 pausetime) and count their hits.
    proj.hitTargets.add(d);
    // Projectiles_HitPlayer: the hit count and pause change once all hits
    // of the tick are in (applyProjectileHits).
    proj.hitPending = true;
    noteProjContact(a, guarded ? 1 : 2, proj.projId);
  } else {
    a.hitTargets.add(d);
    // Player_Hit: only a hitonce HitDef goes off; others stay active for
    // other targets (each target once per HitDef, hit_ids).
    if (hd.hitOnce) a.hitDefActive = false;
    // mugen.exe's hd->active (what the AI's learning sees) only goes off for
    // a hitonce HitDef (the default for throws).
    if (hd.hitOnce) a.hitDefSet = false;
    a.moveContact = 1;
    a.moveReversed = 0;
    if (guarded) {
      a.moveGuarded = 1;
      a.moveHit = 0;
    } else {
      a.moveHit = 1;
      a.moveGuarded = 0;
    }
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
  // -dir, dir = attacker facing), kept in world space.
  // (A guard keeps the attacker's facing; p1facing / p1getp2facing turn
  // dir for a hit, below.)
  let dir = proj ? proj.facing : a.facing;
  const airborne = d.stateType === 'a';
  const g = d.ghv;

  if (guarded) {
    const dmg = hitDamage(d, hd.guardDamage, hd.guardKill, world.gameTime);
    d.shakeTick = world.gameTime;
    g.guarded = 1;
    g.chainid = hd.id;
    d.ghvAttacker = a;
    g.damage = dmg;
    // A guarded hit never falls (measured: the CPU skips its air-recovery
    // roll in 151 after an earlier knock-down).
    g.fall = 0;
    g.hitshaketime = hd.guardPause[1];
    // An air guard has no hit time: HitOver is 1 at once (measured: 154).
    g.hittime = airborne ? -1 : hd.guardHitTime;
    g.slidetime = hd.guardSlideTime;
    g.ctrltime = airborne ? hd.airGuardCtrlTime : hd.guardCtrlTime;
    g.xvel = (airborne ? hd.airGuardVel[0] : hd.guardVel) * -dir * conv;
    g.yvel = (airborne ? hd.airGuardVel[1] : 0) * conv;
    g.yaccel = hd.yaccel * conv;
    a.addPower(hd.getPower[1]);
    d.addPower(hd.givePower[1]);
    d.returnToOwnStates();
    // Guarding a hit takes control away and keeps the previous prevstateno
    // (measured: 130 -> 150 reports prevstateno 120).
    const prev = d.prevStateNo;
    d.ctrl = false;
    // Velocities kept in world space across a turn by the new statedef.
    const oldFacing = d.facing;
    const oldVel = { x: d.vel.x * oldFacing, y: d.vel.y };
    d.changeState(d.stateType === 'a' ? 154 : d.stateType === 'c' ? 152 : 150);
    // As with hits, the guard statedef's velset shows once it runs (measured: 154).
    if (d.vel.x * d.facing !== oldVel.x || d.vel.y !== oldVel.y) {
      d.pendingVel = { x: d.vel.x * d.facing, y: d.vel.y };
      d.vel.x = oldVel.x * d.facing;
      d.vel.y = oldVel.y;
    }
    // Guarding a hit marks the defender as guarding (mugen.exe 0x43fad3).
    d.guardFlag = true;
    d.prevStateNo = prev;
    if (!proj) cornerPush(a, d, airborne ? hd.airGuardCornerPush : hd.guardCornerPush);
    world.spawnSpark(a, d, hd.guardSpark, sparkXY, src);
    world.playHitSound(a, hd.guardSound);
  } else {
    // Damage lands on the following tick (measured against MUGEN 1.1).
    const dmg = hitDamage(d, hd.damage, hd.kill, world.gameTime);
    // HitDef_Apply: a player hit is not guarding any more.
    d.guardFlag = false;
    d.shakeTick = world.gameTime;
    // A crouching defender stands for a forcestand HitDef or a killing hit
    // (mugen.exe 0x43f1bb: the kill flag also selects 5000 over 5010).
    const killsNow = guardKo || (d.life - (d.pendingDamage?.amount ?? 0) <= 0 && !d.isHelper);
    if (d.stateType === 'c' && (hd.forceStand || killsNow)) d.stateType = 's';
    const wasFalling = d.moveType === 'h' && g.fall !== 0;
    const override = d.hitOverrides.find((o) => overrides(o, hd));
    // HitDef_Apply: lying on the floor takes the down.* values (5080); lying
    // above it counts as in the air.
    const lying = d.stateType === 'l' && d.wy === 0 && !override?.forceAir;
    const inAir = d.stateType === 'a' || !!override?.forceAir || (d.stateType === 'l' && d.wy !== 0);
    // Player_Hit: p1facing (< 0) turns the attacker, p1getp2facing makes it
    // face as P2 does (1) or the other way (-1); dir follows the turn and
    // the attacker turns in its next update.
    if (!proj && !override) {
      if (hd.p1Facing < 0 && !hd.p1GetP2Facing) {
        dir = -a.facing;
        a.nextFacing = dir;
      }
      if (hd.p1GetP2Facing && (hd.p1GetP2Facing > 0 ? dir !== d.facing : dir === d.facing)) {
        dir = -a.facing;
        a.nextFacing = dir;
      }
    }
    // Juggle points (Player_Hit): a hit on a falling target, a fall = 1 hit or an air.fall
    // hit in the air, spends the HitDef's juggle from the attacker's target
    // entry; the HitDef then costs nothing more until a state sets it.
    if (!proj && !override && (wasFalling || hd.fall || (hd.airFall && d.stateType === 'a'))) {
      // The amount is hitdef_juggle, which Player_CanHit only sets without
      // AssertSpecial nojugglecheck (else it stays 0 from the tick start).
      a.targetJuggle.set(d, (a.targetJuggle.get(d) ?? a.const('data.airjuggle')) - a.hitdefJuggle);
      a.juggleCost = 0;
    }
    const vel = lying ? hd.downVel : inAir ? hd.airVel : hd.groundVel;
    g.guarded = 0;
    g.damage = dmg;
    // Knock-down hits use fall.animtype (MUGEN shows anim 5030 for KFM's palm).
    // A killing hit always knocks down (measured: KFM's 1410 KO plays the
    // fall animtype, anim 5030).
    // Player_Hit: a KO when the life left after everything pending is out
    // (kill = 0 damage was limited already); never for helpers.
    const kills = guardKo || (d.life - (d.pendingDamage?.amount ?? 0) <= 0 && !d.isHelper);
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
    g.hittime = lying ? (vel[1] !== 0 ? hd.airHitTime : hd.downHitTime) : inAir || vel[1] !== 0 || willFall ? hd.airHitTime : hd.groundHitTime;
    g.slidetime = hd.groundSlideTime;
    let [vx, vy] = vel;
    // A killing hit throws the defender (mugen.exe 0x43f29a): ground hits
    // with no y velocity keep 0.66 of x; x gains 2.5 outwards, y loses 2 and
    // is at most -6 (measured: KFM's 1410 KO sends P2 at -8.44, -6).
    // Player_KoVelocity: at most -6 up on the ground, -3 in the air.
    if (kills) {
      if (!inAir && vy === 0) vx = Math.fround(vx * 0.66);
      if (vx !== 0) vx = Math.fround(vx + Math.sign(vx) * 2.5);
      if (vy <= 0) vy = Math.min(Math.fround(vy - 2), inAir ? -3 : -6);
    }
    g.xvel = vx * -dir * conv;
    g.yvel = vy * conv;
    // HitDef_Apply: a falling ground hit with no y velocity gets -0.001
    // (internal units), so the hit state sends it into the air.
    if (!inAir && !lying && willFall && g.yvel === 0) g.yvel = Math.fround(-0.001) / (d.scale * (world.gameWidth / world.screenWidth));
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
    // A down hit with y velocity and down.bounce = 0 does not bounce.
    if (lying && vel[1] !== 0 && !hd.downBounce) {
      g['fall.xvel'] = Number.NaN;
      g['fall.yvel'] = 0;
    }
    g['fall.recover'] = hd.fallRecover ? 1 : 0;
    g['fall.recovertime'] = hd.fallRecoverTime;
    g['fall.time'] = 0;
    g['fall.kill'] = hd.fallKill ? 1 : 0;
    if (hd.fallEnvShake) {
      g['fall.envshake.time'] = hd.fallEnvShake.time;
      g['fall.envshake.freq'] = hd.fallEnvShake.freq;
      g['fall.envshake.ampl'] = hd.fallEnvShake.ampl;
      g['fall.envshake.phase'] = hd.fallEnvShake.phase;
    }
    if (hd.envShake) world.envShake = makeEnvShake(hd.envShake.time, hd.envShake.freq, hd.envShake.ampl, hd.envShake.phase, a.scale * (world.gameWidth / world.screenWidth));
    if (hd.palFx) d.palFx = { time: hd.palFx.time, elapsed: 0, add: hd.palFx.add, mul: hd.palFx.mul, sinAdd: [0, 0, 0], sinPeriod: 0, invertAll: hd.palFx.invertAll, color: hd.palFx.color };
    g.chainid = hd.id;
    d.ghvAttacker = a;
    // Player_Hit: the count restarts only once the target has been out of
    // movetype H for more than one update.
    g.hitcount = d.moveType !== 'h' && d.hitFreeTime > 1 ? 1 : g.hitcount + 1;
    if (kills) g.fall = 1;
    // Combo_AddHits: the attacker's side (a projectile's owner's too).
    world.comboAdded[a.side]! += hd.numHits;
    // HitCount once per frame, UniqHitCount per target.
    if (!proj) {
      if (a.hitFrame < world.frames) a.hitCount += hd.numHits;
      a.hitFrame = world.frames;
      a.uniqHitCount += hd.numHits;
    }
    // Player_Hit: after a throw neither player can be hit for the pause.
    if (!proj && !override && hitDefAttrBits(hd.attrState, hd.attrType) & 0x1c0) d.nohitTime = a.nohitTime = hd.pause[0] + 1;
    a.addPower(hd.getPower[0]);
    d.addPower(hd.givePower[0]);
    const aFacing = dir;
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
    // The turn waits for P2's next update (next_facing).
    if (hd.p2Facing === 1 && d.facing !== -aFacing) d.nextFacing = -aFacing;
    else if (hd.p2Facing === -1 && d.facing !== aFacing) d.nextFacing = aFacing;
    // A light/medium/hard hit from behind swaps High and Low in the hit
    // types (mugen.exe 0x43f3e1; measured: KFM's jump kick into a crossed-up
    // P2 shows anim 5010).
    const dFacing = d.nextFacing || d.facing;
    if (g.animtype >= 0 && g.animtype <= 2 && dFacing !== (hd.p2Facing === -1 ? aFacing : -aFacing)) {
      const swap = (t: number) => (t === 1 ? 2 : t === 2 ? 1 : t);
      g.groundtype = swap(g.groundtype);
      g.airtype = swap(g.airtype);
    }
    d.ctrl = false;
    {
      d.returnToOwnStates();
      const oldType = d.stateType;
      // World-space velocity (the statedef may turn the player).
      const oldVel = { x: d.vel.x * d.facing, y: d.vel.y };
      d.entryVelSet = false;
      // A grounded defender hit by ground.type = Trip goes to 5070 (HITTRIP);
      // by statetype only: common1's 5000/5010 switch to air themselves when yvel != 0.
      // air.type = Trip sends an airborne target to 5070 too (HitDef_Apply).
      const hitState = lying ? 5080 : (inAir ? hd.airType : hd.groundType) === 3 ? 5070 : inAir ? 5020 : d.stateType === 'c' ? 5010 : 5000;
      if (override && override.stateNo >= 0) d.changeState(override.stateNo);
      else if (hd.p2StateNo >= 0) {
        // HitDef_Apply sets only the number of the common hit state, then
        // p2stateno changes from it (measured: KFM's Fast Kung Fu Palm shows
        // 1025 with prevstateno 5000); that hit state's statedef never runs.
        d.stateNo = hitState;
        if (hd.p2GetP1State) d.stateOwner = a;
        d.changeState(hd.p2StateNo);
      } else d.changeState(hitState);
      // The new state's movetype too (HitDef_Apply sets H; a p2stateno into
      // an idle state only turns I when it runs).
      if (d.moveType !== 'h' && d.compiledState(d.stateNo)) d.pendingMoveType = d.moveType;
      // The new statetype shows once the hit state first runs (measured: 5070).
      if (d.stateType !== oldType) {
        d.pendingStateType = d.stateType;
        d.stateType = oldType;
      }
      // So does the statedef's velset (measured: a walking P2 hit into 5000
      // still shows its walk speed that tick; a TargetBind's velocity copy
      // the next tick is still reset by it).
      if (d.entryVelSet) {
        d.pendingVel = { x: d.vel.x * d.facing, y: d.vel.y };
        d.vel.x = oldVel.x * d.facing;
        d.vel.y = oldVel.y;
      }
    }
    d.moveType = 'h';
    if (!proj) cornerPush(a, d, lying ? hd.downCornerPush : inAir ? hd.airCornerPush : hd.groundCornerPush);
    world.spawnSpark(a, d, hd.spark, sparkXY, src);
    world.playHitSound(a, hd.hitSound);
  }
  d.sprPriority = hd.p2SprPriority;
  if (proj) {
    // Projectiles_HitPlayer: a projectile hit's p1stateno changes the owner's state.
    if (!guarded && hd.p1StateNo >= 0) a.changeState(hd.p1StateNo);
    return;
  }
  a.sprPriority = hd.p1SprPriority;
  // Player_Hit: a hit (not guarded or overridden) binds the target for
  // snap's time at the snap offset (bind_x/y = Ftol(FromLocal(snap))).
  if (!guarded && !overridden && hd.snapTime !== 0) {
    const k = world.gameWidth / world.screenWidth;
    const iu = (v: number | undefined) => (v === undefined ? 0 : Math.trunc(Math.trunc(v) * a.scale * k) / k);
    d.bind = { to: a, offset: [iu(hd.snap[0]), iu(hd.snap[1])], time: hd.snapTime, byTarget: true };
  }
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
  // Player_AtScreenEdge: within 5 internal units of screen_left/right
  // (the stage limits, without Width edges).
  const [lo, hi] = w.screenEdges();
  const k = w.gameWidth / w.screenWidth;
  if (!(Math.abs(d.wx - lo) * k < 5 || Math.abs(d.wx - hi) * k < 5)) return;
  // A separate push, not vel x: it moves the attacker back after its hit
  // pause, decaying by 0.7 per tick (measured: 14.3, 10.01, 7.007, ... with
  // vel x staying 0).
  // Player_CornerPush: push_vel = cornerpush * facing, kept in world space.
  // gethit_cornerpush is a float in internal units.
  const ku = a.scale * (w.gameWidth / w.screenWidth);
  a.cornerPushVel = (Math.fround(veloff * ku) / ku) * a.facing;
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
/**
 * Player_HitDamage: the damage is added to the target's pending damage
 * (gethit_damage, applied in its next update); kill = 0 keeps the life
 * left after everything pending at 1 or more. Returns the added damage.
 */
/** The pending damage total Player_HitDamage would leave (not applied). */
function previewDamage(d: Player, raw: number, kill: boolean): number {
  const pending = d.pendingDamage?.amount ?? 0;
  let x = Math.trunc(d.defenceFactor * raw + 0.5) + pending;
  if (raw >= 1 && x === 0) x = 1;
  if (!kill) {
    const left = d.life - pending;
    if (left - x < 1 && d.alive) x = left - 1;
  }
  return x;
}

function hitDamage(d: Player, raw: number, kill: boolean, tick: number): number {
  const pending = d.pendingDamage?.amount ?? 0;
  const x = previewDamage(d, raw, kill);
  d.pendingDamage = { amount: x, kill: true, tick };
  return x - pending;
}

/** Player_Hit: an active HitOverride whose attr shares a state bit and a type bit with the HitDef's. */
function overrides(o: Player['hitOverrides'][number], hd: HitDefData): boolean {
  if (!o?.active) return false;
  const m = o.attr & hitDefAttrBits(hd.attrState, hd.attrType);
  return (m & 7) !== 0 && (m & ~7) !== 0;
}
