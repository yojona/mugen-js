// HitDef (sctrls.html) evaluation and hit application.

import { BOTTOM, compileExprList, R, toInt, type Fn, type TriggerEnv } from '../expr/compile';
import type { ControllerDef } from './cns';
import type { Player } from './player';

type P = Player;

export const ANIM_TYPES = ['light', 'medium', 'hard', 'back', 'up', 'diagup'];
/** 0 none, 1 high, 2 low, 3 trip */
const HIT_TYPES = ['none', 'high', 'low', 'trip'];

export interface SoundRef {
  /** true = player's own .snd ("S" prefix), false = common sounds. */
  own: boolean;
  group: number;
  number: number;
}

export interface SparkRef {
  /** true = player's own .air ("S" prefix), false = fightfx. */
  own: boolean;
  action: number;
}

export interface HitDefData {
  attrState: string; // 's' | 'c' | 'a'
  attrType: string; // 'na', 'sa', 'ht', ...
  hitFlag: string;
  guardFlag: string;
  animType: number;
  airAnimType: number;
  fallAnimType: number;
  priority: number;
  priorityType: 'hit' | 'miss' | 'dodge';
  damage: number;
  guardDamage: number;
  pause: [number, number];
  guardPause: [number, number];
  spark: SparkRef;
  guardSpark: SparkRef;
  sparkXY: [number, number];
  hitSound?: SoundRef;
  guardSound?: SoundRef;
  groundType: number;
  airType: number;
  groundSlideTime: number;
  guardSlideTime: number;
  groundHitTime: number;
  guardHitTime: number;
  airHitTime: number;
  guardCtrlTime: number;
  airGuardCtrlTime: number;
  guardDist: number;
  yaccel: number;
  groundVel: [number, number];
  guardVel: number;
  airVel: [number, number];
  airGuardVel: [number, number];
  downVel: [number, number];
  downHitTime: number;
  downBounce: boolean;
  p1SprPriority: number;
  p2SprPriority: number;
  p1Facing: number;
  p1GetP2Facing: number;
  p2Facing: number;
  p1StateNo: number;
  p2StateNo: number;
  p2GetP1State: boolean;
  forceStand: boolean;
  fall: boolean;
  airFall: boolean;
  forceNoFall: boolean;
  fallXVel: number | undefined;
  fallYVel: number;
  fallRecover: boolean;
  fallRecoverTime: number;
  fallDamage: number;
  id: number;
  chainId: number;
  hitOnce: boolean;
  kill: boolean;
  guardKill: boolean;
  fallKill: boolean;
  numHits: number;
  getPower: [number, number];
  givePower: [number, number];
}

/** Values exposed through GetHitVar() on the player that was hit. */
export interface GetHitVars {
  type: number;
  animtype: number;
  airtype: number;
  groundtype: number;
  damage: number;
  hitcount: number;
  fallcount: number;
  hitshaketime: number;
  hittime: number;
  slidetime: number;
  ctrltime: number;
  recovertime: number;
  xvel: number;
  yvel: number;
  yaccel: number;
  chainid: number;
  guarded: number;
  fall: number;
  'fall.damage': number;
  'fall.xvel': number;
  'fall.yvel': number;
  'fall.recover': number;
  'fall.recovertime': number;
  'fall.kill': number;
  xveladd: number;
  yveladd: number;
  xoff: number;
  yoff: number;
  isbound: number;
}

export function emptyGetHitVars(): GetHitVars {
  return {
    type: 0, animtype: 0, airtype: 0, groundtype: 0, damage: 0, hitcount: 0, fallcount: 0, hitshaketime: 0, hittime: 0, slidetime: 0, ctrltime: 0, recovertime: 0,
    xvel: 0, yvel: 0, yaccel: 0, chainid: 0, guarded: 0, fall: 0, 'fall.damage': 0, 'fall.xvel': 0, 'fall.yvel': 0, 'fall.recover': 1, 'fall.recovertime': 4, 'fall.kill': 1,
    xveladd: 0, yveladd: 0, xoff: 0, yoff: 0, isbound: 0,
  };
}

/** Floats among GetHitVar names (trigger.html). */
export const GETHITVAR_FLOATS = new Set(['xvel', 'yvel', 'yaccel', 'fall.xvel', 'fall.yvel', 'xveladd', 'yveladd']);

// ---------------------------------------------------------------------------
// Compilation of the HitDef controller

function enumIndex(list: string[], v: string | undefined, def: number): number {
  if (!v) return def;
  const i = list.indexOf(v.trim().toLowerCase());
  return i < 0 ? def : i;
}

/** "S5,0" / "5,0" sound refs and "S10" / "10" spark refs. */
function parseRef(raw: string | undefined): { own: boolean; rest: string } | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  const own = /^s/i.test(t);
  return { own, rest: own ? t.slice(1) : t };
}

export function compileHitDef(c: ControllerDef, env: TriggerEnv<P>): (p: P) => HitDefData {
  const lists = new Map<string, Fn<P>[]>();
  const get = (k: string) => {
    if (!lists.has(k)) {
      const src = c.params.get(k);
      lists.set(k, src === undefined ? [] : compileExprList(src, env));
    }
    return lists.get(k)!;
  };
  const refLists = new Map<string, { own: boolean; fns: Fn<P>[] } | undefined>();
  const ref = (k: string) => {
    if (!refLists.has(k)) {
      const r = parseRef(c.params.get(k));
      refLists.set(k, r && { own: r.own, fns: compileExprList(r.rest, env) });
    }
    return refLists.get(k);
  };
  const raw = (k: string) => c.params.get(k)?.trim();
  const has = (k: string) => c.params.has(k);

  // Pre-validate expression params now so errors show at load time.
  for (const k of c.params.keys()) {
    if (['attr', 'hitflag', 'guardflag', 'animtype', 'air.animtype', 'fall.animtype', 'ground.type', 'air.type', 'priority', 'hitsound', 'guardsound', 'sparkno', 'guard.sparkno', 'persistent', 'ignorehitpause'].includes(k)) continue;
    get(k);
  }

  const attr = (raw('attr') ?? 's, na').toLowerCase().split(',').map((s) => s.trim());
  const attrState = attr[0] ?? 's';
  const attrType = attr[1] ?? 'na';
  const animType = enumIndex(ANIM_TYPES, raw('animtype'), 0);
  const airAnimType = enumIndex(ANIM_TYPES, raw('air.animtype'), animType);
  const fallAnimType = enumIndex(ANIM_TYPES, raw('fall.animtype'), airAnimType === 4 ? 4 : 3);
  const groundType = enumIndex(HIT_TYPES, raw('ground.type'), 1);
  const airType = enumIndex(HIT_TYPES, raw('air.type'), groundType);
  const prio = (raw('priority') ?? '4').split(',').map((s) => s.trim().toLowerCase());
  const priorityType = (['hit', 'miss', 'dodge'].includes(prio[1] ?? '') ? prio[1] : 'hit') as HitDefData['priorityType'];

  return (p) => {
    const n = (k: string, i = 0): number | undefined => {
      const fn = get(k)[i];
      if (!fn) return undefined;
      const v = fn(p);
      return R.t === BOTTOM ? undefined : v;
    };
    const ni = (k: string, i = 0): number | undefined => {
      const v = n(k, i);
      return v === undefined ? undefined : toInt(v);
    };
    const rv = (k: string, i: number): number | undefined => {
      const r = ref(k);
      const fn = r?.fns[i];
      if (!fn) return undefined;
      const v = fn(p);
      return R.t === BOTTOM ? undefined : toInt(v);
    };
    const local = (v: number) => v * (p.prog.data.def.localCoord[0] / 320);

    const damage = ni('damage', 0) ?? 0;
    const pause: [number, number] = [ni('pausetime', 0) ?? 0, ni('pausetime', 1) ?? 0];
    const groundVel: [number, number] = [n('ground.velocity', 0) ?? 0, n('ground.velocity', 1) ?? 0];
    const airVel: [number, number] = [n('air.velocity', 0) ?? 0, n('air.velocity', 1) ?? 0];
    const guardVel = n('guard.velocity', 0) ?? groundVel[0];
    const groundSlideTime = ni('ground.slidetime') ?? 0;
    const groundHitTime = ni('ground.hittime') ?? 0;
    const guardHitTime = ni('guard.hittime') ?? groundHitTime;
    const guardSlideTime = ni('guard.slidetime') ?? guardHitTime;
    const guardCtrlTime = ni('guard.ctrltime') ?? guardSlideTime;
    const fall = (ni('fall') ?? 0) !== 0;
    const getPowerHit = ni('getpower', 0) ?? Math.trunc(damage * 0.7);
    const givePowerHit = ni('givepower', 0) ?? Math.trunc(damage * 0.6);
    const isThrow = attrType[1] === 't';
    const spark = rv('sparkno', 0);
    const gspark = rv('guard.sparkno', 0);
    const hs = ref('hitsound');
    const gs = ref('guardsound');

    return {
      attrState,
      attrType,
      hitFlag: (raw('hitflag') ?? 'MAF').toLowerCase(),
      guardFlag: (raw('guardflag') ?? '').toLowerCase(),
      animType,
      airAnimType,
      fallAnimType,
      priority: parseInt(prio[0] ?? '4', 10) || 4,
      priorityType,
      damage,
      guardDamage: ni('damage', 1) ?? 0,
      pause,
      guardPause: [ni('guard.pausetime', 0) ?? pause[0], ni('guard.pausetime', 1) ?? pause[1]],
      spark: { own: !!ref('sparkno')?.own, action: spark ?? p.const('data.sparkno') },
      guardSpark: { own: !!ref('guard.sparkno')?.own, action: gspark ?? p.const('data.guard.sparkno') },
      sparkXY: [n('sparkxy', 0) ?? 0, n('sparkxy', 1) ?? 0],
      hitSound: hs ? { own: hs.own, group: rv('hitsound', 0) ?? 5, number: rv('hitsound', 1) ?? 0 } : { own: false, group: 5, number: 0 },
      guardSound: gs ? { own: gs.own, group: rv('guardsound', 0) ?? 6, number: rv('guardsound', 1) ?? 0 } : { own: false, group: 6, number: 0 },
      groundType,
      airType,
      groundSlideTime,
      guardSlideTime,
      groundHitTime,
      guardHitTime,
      airHitTime: ni('air.hittime') ?? 20,
      guardCtrlTime,
      airGuardCtrlTime: ni('airguard.ctrltime') ?? guardCtrlTime,
      guardDist: ni('guard.dist') ?? p.const('size.attack.dist'),
      yaccel: n('yaccel') ?? local(0.35),
      groundVel,
      guardVel,
      airVel,
      airGuardVel: [n('airguard.velocity', 0) ?? airVel[0] * 1.5, n('airguard.velocity', 1) ?? airVel[1] / 2],
      downVel: [n('down.velocity', 0) ?? airVel[0], n('down.velocity', 1) ?? airVel[1]],
      downHitTime: ni('down.hittime') ?? 0,
      downBounce: (ni('down.bounce') ?? 0) !== 0,
      p1SprPriority: ni('p1sprpriority') ?? 1,
      p2SprPriority: ni('p2sprpriority') ?? 0,
      p1Facing: ni('p1facing') ?? 0,
      p1GetP2Facing: ni('p1getp2facing') ?? 0,
      p2Facing: ni('p2facing') ?? 0,
      p1StateNo: ni('p1stateno') ?? -1,
      p2StateNo: ni('p2stateno') ?? -1,
      p2GetP1State: (ni('p2getp1state') ?? 1) !== 0,
      forceStand: (ni('forcestand') ?? (groundVel[1] !== 0 ? 1 : 0)) !== 0,
      fall,
      airFall: (ni('air.fall') ?? (fall ? 1 : 0)) !== 0,
      forceNoFall: (ni('forcenofall') ?? 0) !== 0,
      fallXVel: n('fall.xvelocity'),
      fallYVel: n('fall.yvelocity') ?? local(-4.5),
      fallRecover: (ni('fall.recover') ?? 1) !== 0,
      fallRecoverTime: ni('fall.recovertime') ?? 4,
      fallDamage: ni('fall.damage') ?? 0,
      id: ni('id') ?? 0,
      chainId: ni('chainid') ?? -1,
      hitOnce: (ni('hitonce') ?? (isThrow ? 1 : 0)) !== 0,
      kill: (ni('kill') ?? 1) !== 0,
      guardKill: (ni('guard.kill') ?? 1) !== 0,
      fallKill: (ni('fall.kill') ?? 1) !== 0,
      numHits: ni('numhits') ?? 1,
      getPower: [getPowerHit, ni('getpower', 1) ?? Math.trunc(getPowerHit / 2)],
      givePower: [givePowerHit, ni('givepower', 1) ?? Math.trunc(givePowerHit / 2)],
    };
  };
  void has;
}
