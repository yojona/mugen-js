// State controllers (sctrls.html). Parameters are compiled once and evaluated
// when the controller fires, left to right, as MUGEN does.

import { checkControllerParams, specKeys } from './sctrl-params';
import { soundPan } from './world';
import { varTarget } from './var-line';
import { parseHitDefAttr } from '../expr/mugen-parse';
import { BOTTOM, compileExpr, compileExprList, R, toInt, type Fn, type TriggerEnv } from '../expr/compile';
import type { ControllerDef } from './cns';
import { compileHitDef, parseAttrList } from './hitdef';
import { attrBits } from './ai-learn';
import { compileExplod, compileExplodBindTime, compileGameMakeAnim, compileMakeDust, compileModifyExplod, compileRemoveExplod, simpleExplod, transBlend } from './explod';
import { makeEnvShake, newAfterImage, startAfterImage, type PalFxState } from './fx';
import { compileBindTo, compileDestroySelf, compileHelper, compileParentVar } from './helper';
import { compileProjectile } from './projectile';
import type { MoveType, Physics, Player, StateType } from './player';

type P = Player;

export interface CompiledController {
  def: ControllerDef;
  triggerAll: Fn<P>[];
  triggers: Fn<P>[][];
  persistent: number;
  ignoreHitPause: boolean;
  run(p: P): void;
}

/** Parameter accessor for one controller. */
class Params {
  private cache = new Map<string, Fn<P>[] | null>();
  /** The keys mugen.exe reads for this type: any other key is ignored. */
  private keys: Set<string> | undefined;
  constructor(
    private def: ControllerDef,
    private env: TriggerEnv<P>,
  ) {
    this.keys = specKeys(def.type);
  }

  has(k: string): boolean {
    return this.def.params.has(k);
  }
  raw(k: string): string | undefined {
    return this.def.params.get(k);
  }
  list(k: string): Fn<P>[] | null {
    let v = this.cache.get(k);
    if (v === undefined) {
      const src = this.keys && !this.keys.has(k) ? undefined : this.def.params.get(k);
      try {
        v = src === undefined ? null : compileExprList(src, this.env);
      } catch {
        // Checked at load time (sctrl-params.ts); what is left are texts
        // mugen.exe reads in its own way, never as a list here.
        v = null;
      }
      this.cache.set(k, v);
    }
    return v;
  }
  /** Value of component `i` of param `k`; undefined if absent or bottom. */
  num(p: P, k: string, i = 0): number | undefined {
    const fn = this.list(k)?.[i];
    if (!fn) return undefined;
    const v = fn(p);
    return R.t === BOTTOM ? undefined : v;
  }
  int(p: P, k: string, i = 0): number | undefined {
    const fn = this.list(k)?.[i];
    if (!fn) return undefined;
    const v = fn(p);
    if (R.t === BOTTOM) return undefined;
    return R.t === 1 ? toInt(v) : v;
  }
}

type Impl = (c: ControllerDef, prm: Params, env: TriggerEnv<P>) => (p: P) => void;

/** AssertSpecial flags kept in GameVars instead of the player. */
const GLOBAL_ASSERTS = new Set(['intro', 'roundnotover', 'noko', 'nokosnd', 'nokoslow', 'nomusic', 'globalnoshadow', 'timerfreeze', 'nobardisplay', 'nobg', 'nofg']);

const IMPLS: Record<string, Impl> = {
  null: () => () => {},

  changestate: (_c, prm) => (p) => {
    let v = prm.int(p, 'value');
    if (v === undefined) return;
    if (v < 0) v = 0;
    // SCTRL_CHANGESTATE: with control, standing or crouching, a player turns
    // towards the enemy if the stage has autoturn (mugen.exe 0x4490fd: before
    // the new statedef applies, so its anim wins over the turn's).
    if (p.world.autoTurn && p.ctrl && !p.isHelper && (p.stateType === 's' || p.stateType === 'c')) p.world.turnCheck(p);
    p.changeState(v, ...ctrlAnim(p, prm));
  },
  selfstate: (_c, prm) => (p) => {
    let v = prm.int(p, 'value');
    if (v === undefined) return;
    if (v < 0) v = 0;
    p.returnToOwnStates();
    p.changeState(v, ...ctrlAnim(p, prm));
  },

  changeanim: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v === undefined) return;
    // run_change_anim: elem 0, absent or negative starts at the first element; negative anims are 0.
    const elem = prm.int(p, 'elem') ?? 0;
    p.changeAnim(Math.max(0, v), elem > 0 ? elem - 1 : 0);
  },
  changeanim2: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v === undefined) return;
    // run_change_anim: elem 0, absent or negative starts at the first element; negative anims are 0.
    const elem = prm.int(p, 'elem') ?? 0;
    p.changeAnim(Math.max(0, v), elem > 0 ? elem - 1 : 0, true);
  },

  // Values in the units of the states running (Player_FromLocalCoord: a
  // custom state owner's localcoord converts).
  velset: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    const c = p.localConv;
    if (x !== undefined) p.vel.x = Math.fround(x) * c;
    if (y !== undefined) p.vel.y = Math.fround(y) * c;
  },
  veladd: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    const c = p.localConv;
    if (x !== undefined) p.vel.x = p.vel.x + Math.fround(x) * c;
    if (y !== undefined) p.vel.y = p.vel.y + Math.fround(y) * c;
  },
  velmul: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    if (x !== undefined) p.vel.x = p.vel.x * Math.fround(x);
    if (y !== undefined) p.vel.y = p.vel.y * Math.fround(y);
  },
  posset: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    const c = p.localConv;
    if (x !== undefined) p.pos.x = p.world.camera.x / p.scale + Math.fround(x) * c;
    if (y !== undefined) p.pos.y = Math.fround(y) * c;
  },
  posadd: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    const c = p.localConv;
    if (x !== undefined) p.pos.x = p.pos.x + Math.fround(x) * c * p.facing;
    if (y !== undefined) p.pos.y = p.pos.y + Math.fround(y) * c;
  },
  posfreeze: (_c, prm) => (p) => {
    p.posFreeze = (prm.int(p, 'value') ?? 1) !== 0;
  },
  ctrlset: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) p.ctrl = v !== 0;
  },
  // Turning keeps the world velocity (the facing setter flips vel x;
  // measured: KFM's 1028 shows vel x -1.6 after its VelSet 1.6 and Turn).
  turn: () => (p) => {
    p.facing = -p.facing;
  },
  statetypeset: (_c, prm) => (p) => {
    // `value` is the old name of statetype, read when statetype is absent.
    const st = (prm.raw('statetype') ?? prm.raw('value'))?.trim().toLowerCase()[0];
    const mt = prm.raw('movetype')?.trim().toLowerCase()[0];
    const ph = prm.raw('physics')?.trim().toLowerCase()[0];
    if (st && 'scal'.includes(st)) p.stateType = st as StateType;
    if (mt && 'iah'.includes(mt)) p.moveType = mt as MoveType;
    if (ph && 'scan'.includes(ph)) p.physics = ph as Physics;
  },
  sprpriority: (_c, prm) => (p) => {
    p.sprPriority = prm.int(p, 'value') ?? 0;
  },

  lifeadd: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v === undefined) return;
    p.applyLifeAdd(v, (prm.int(p, 'kill') ?? 1) !== 0, (prm.int(p, 'absolute') ?? 0) !== 0);
  },
  lifeset: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) p.setLife(v);
  },
  poweradd: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) p.addPower(v);
  },
  powerset: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) p.setPower(v);
  },

  varset: (c, prm, env) => varController(c, prm, env, 'set'),
  varadd: (c, prm, env) => varController(c, prm, env, 'add'),
  // VarRandom (mugen.exe SCTRL_VARRANDOM): var(v) = Match_Random() % (hi - lo + 1) + lo;
  // range = hi alone means 0..hi; the default is 0..1000.
  varrandom: (_c, prm) => (p) => {
    const idx = prm.int(p, 'v');
    if (idx === undefined || idx < 0 || idx >= p.vars.length) return;
    const r = prm.list('range');
    let lo = 0;
    let hi = 1000;
    if (r && r.length === 1) hi = prm.int(p, 'range', 0) ?? 0;
    else if (r) {
      lo = prm.int(p, 'range', 0) ?? 0;
      hi = prm.int(p, 'range', 1) ?? 0;
    }
    if (hi < lo) [lo, hi] = [hi, lo];
    p.vars[idx] = (p.world.random(hi - lo + 1) + lo) | 0;
  },
  varrangeset: (_c, prm) => (p) => {
    const iv = prm.int(p, 'value');
    const fv = prm.num(p, 'fvalue');
    const first = prm.int(p, 'first') ?? 0;
    // An out-of-range range does nothing (warning) in mugen.exe.
    if (iv !== undefined) {
      const last = prm.int(p, 'last') ?? 59;
      if (first < 0 || last > 59 || first > last) return;
      for (let i = first; i <= last; i++) p.vars[i] = iv;
    } else if (fv !== undefined) {
      const last = prm.int(p, 'last') ?? 39;
      if (first < 0 || last > 39 || first > last) return;
      for (let i = first; i <= last; i++) p.fvars[i] = fv;
    }
  },

  hitdef: (c, _prm, env) => {
    const build = compileHitDef(c, env);
    return (p) => {
      p.hitDef = build(p);
      // guard.dist -1 keeps the previous distance (SCTRL_HITDEF).
      if (p.hitDef.guardDist === -1) p.hitDef.guardDist = p.guardDist;
      p.guardDist = p.hitDef.guardDist;
      // The attr's state part is the player's statetype when the HitDef runs
      // (measured: KFM's 1060 "attr = A, SA" reads back as S, SA in mugen.exe,
      // so its HitDefAttr = SC super cancel works).
      if (p.stateType === 's' || p.stateType === 'c' || p.stateType === 'a') p.hitDef.attrState = p.stateType;
      p.hitDefActive = true;
      p.hitDefSet = true;
      p.hitDefAttrOn = true;
      p.hitTargets.clear();
      // HitDef and ReversalDef share the player's one HitDef in mugen.exe:
      // a HitDef replaces a ReversalDef (reversal_attr back to 0).
      p.reversal = undefined;
    };
  },
  hitvelset: (_c, prm) => (p) => {
    // SCTRL_HITVELSET: x and y default to 0 (no change); the get-hit
    // velocity plus its xveladd / yveladd.
    if ((prm.int(p, 'x') ?? 0) !== 0) p.vel.x = Math.fround((p.ghv.xveladd + p.ghv.xvel) * p.facing);
    if ((prm.int(p, 'y') ?? 0) !== 0) p.vel.y = Math.fround(p.ghv.yveladd + p.ghv.yvel);
  },
  hitfallvel: () => (p) => {
    const xv = p.ghv['fall.xvel'];
    if (!Number.isNaN(xv)) p.vel.x = Math.fround(xv);
    p.vel.y = Math.fround(p.ghv['fall.yvel']);
  },
  hitfallset: (_c, prm) => (p) => {
    const v = prm.int(p, 'value') ?? -1;
    if (v !== -1) p.ghv.fall = v ? 1 : 0;
    // mugen.exe reads velocity = x, y (not xvel / yvel), takes both from x
    // (original bug) and stores them unconverted in internal units.
    const x = prm.num(p, 'velocity', 0);
    if (x !== undefined) {
      const u = p.scale * (p.world.gameWidth / p.world.screenWidth);
      p.ghv['fall.xvel'] = Math.fround(x) / u;
      p.ghv['fall.yvel'] = Math.fround(x) / u;
    }
  },
  hitfalldamage: () => (p) => {
    const dmg = p.ghv['fall.damage'];
    if (!dmg) return;
    // SetLife only clamps to 0..max (fall.kill is not read here).
    p.setLife(p.life - dmg);
    p.ghv['fall.damage'] = 0;
  },
  // mugen.exe: attack_mul = value * data.attack / 100.
  attackmulset: (_c, prm) => (p) => {
    const v = prm.num(p, 'value');
    if (v !== undefined) p.attackMul = Math.fround((v * p.const('data.attack')) / 100);
  },
  gravity: () => (p) => {
    p.vel.y = p.vel.y + Math.fround(p.const('movement.yaccel'));
  },
  attackdist: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) p.guardDist = v;
  },
  hitadd: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) {
      p.hitCount += v;
      p.uniqHitCount += v;
      // SCTRL_HITADD: the HUD's combo counter too.
      p.world.comboAdded[p.side]! += v;
      p.world.comboTouched[p.side] = true;
    }
  },
  defencemulset: (_c, prm) => (p) => {
    const v = prm.num(p, 'value');
    if (v !== undefined) p.defMul = Math.fround((v * 100) / Math.max(1, p.const('data.defence')));
  },
  nothitby: (c, prm) => hitByController(c, prm, true),
  hitby: (c, prm) => hitByController(c, prm, false),
  movehitreset: () => (p) => {
    p.moveContact = p.moveHit = p.moveGuarded = p.moveReversed = 0;
  },

  playsnd: (_c, prm) => {
    // value = [F|S]group, number   (F = common sound file, S = own; Cns_ParseSoundRef)
    const raw = (prm.raw('value') ?? '').trim();
    const common = /^f/i.test(raw);
    const fns = compileExprList(/^[fs]/i.test(raw) ? raw.slice(1) : raw, playerEnvRef!);
    const [groupFn, numFn] = fns;
    return (p) => {
      if (!groupFn) return;
      let g = groupFn(p);
      if (R.t === BOTTOM) return;
      // "S5" alone: number 0.
      let n = numFn ? numFn(p) : 0;
      if ((R.t as number) === BOTTOM) return;
      // PlaySnd_Run: channel -1..31 (else no channel), groups/numbers below
      // -1 are -1 and group -1 plays nothing; volumescale (and the
      // character's [Data] volumescale for its own sounds) sets the volume;
      // pan is relative to the player unless abspan. freqmul is ignored.
      const ch = prm.int(p, 'channel') ?? -1;
      g = Math.max(-1, g | 0);
      n = Math.max(-1, n | 0);
      if (g === -1) return;
      let volume = prm.num(p, 'volumescale') ?? 100;
      if (!common) volume *= (p.prog.consts.get('data.volumescale') ?? 100) / 100;
      const abs = prm.has('abspan');
      let x = p.facing * (abs ? (prm.int(p, 'abspan') ?? 0) : (prm.int(p, 'pan') ?? 0));
      const k = p.world.gameWidth / p.world.screenWidth;
      if (!abs) x = Math.trunc(p.wx * k - p.world.camera.x * k + x);
      p.events.push({
        owner: common ? null : p,
        group: g,
        number: n,
        key: ch >= 0 && ch <= 31 ? soundKey(p, ch) : undefined,
        lowPriority: (prm.int(p, 'lowpriority') ?? 0) !== 0,
        volume,
        loop: (prm.int(p, 'loop') ?? 0) !== 0,
        pan: soundPan(p.world, x),
      });
    };
  },
  stopsnd: (_c, prm) => (p) => {
    // SCTRL_STOPSND: channel -1 stops every sound.
    const ch = prm.int(p, 'channel') ?? -1;
    if (ch < -1 || ch > 31) return;
    p.events.push({ kind: 'stop', key: ch === -1 ? undefined : soundKey(p, ch) });
  },
  sndpan: (_c, prm) => (p) => {
    const ch = prm.int(p, 'channel') ?? 0;
    if (ch < 0 || ch > 31) return;
    const k = p.world.gameWidth / p.world.screenWidth;
    const abs = prm.has('abspan');
    // pan wins over abspan for the value; abspan still makes it absolute.
    let x = Math.trunc((prm.int(p, 'pan') ?? prm.int(p, 'abspan') ?? 0) * p.scale * k * p.facing);
    if (!abs) x = Math.trunc(p.wx * k - p.world.camera.x * k + x);
    p.events.push({ kind: 'pan', key: soundKey(p, ch), pan: soundPan(p.world, x) });
  },
};


// ---------------------------------------------------------------------------
// Effects, pauses, targets and misc controllers.

const v3 = (prm: Params, p: P, k: string, def: [number, number, number]): [number, number, number] => [prm.num(p, k, 0) ?? def[0], prm.num(p, k, 1) ?? def[1], prm.num(p, k, 2) ?? def[2]];

function palFxFrom(prm: Params, p: P): PalFxState {
  return {
    time: prm.int(p, 'time') ?? 0,
    elapsed: 0,
    add: v3(prm, p, 'add', [0, 0, 0]),
    mul: v3(prm, p, 'mul', [256, 256, 256]),
    sinAdd: v3(prm, p, 'sinadd', [0, 0, 0]),
    sinPeriod: prm.int(p, 'sinadd', 3) ?? 0,
    invertAll: (prm.int(p, 'invertall') ?? 0) !== 0,
    color: prm.num(p, 'color') ?? 256,
  };
}

function eachTarget(p: P, prm: Params, f: (t: P) => void): void {
  // run_targets: the ID is evaluated for each target in turn (draws of
  // Random inside it are per target).
  for (const t of [...p.targets.keys()]) if (targetMatches(t, prm.int(p, 'id') ?? -1)) f(t);
}

/** target_matches: not guarding, hit by a HitDef of the ID (the target's current gethit_id). */
function targetMatches(t: P, id: number): boolean {
  return !t.guardFlag && (id === -1 || t.ghv.chainid === id);
}

const EXTRA: Record<string, Impl> = {
  explod: (c, _prm, env) => compileExplod(c, env),
  modifyexplod: (c, _prm, env) => compileModifyExplod(c, env),
  removeexplod: (c, _prm, env) => compileRemoveExplod(c, env),
  explodbindtime: (c, _prm, env) => compileExplodBindTime(c, env),
  gamemakeanim: (c, _prm, env) => compileGameMakeAnim(c, env),
  makedust: (c, _prm, env) => compileMakeDust(c, env),

  palfx: (_c, prm) => (p) => {
    p.palFx = palFxFrom(prm, p);
  },
  allpalfx: (_c, prm) => (p) => {
    p.world.allPalFx = palFxFrom(prm, p);
  },
  victoryquote: (_c, prm) => (p) => {
    // SCTRL_VICTORYQUOTE: helpers are ignored; default -1 (random).
    if (p.isHelper) return;
    p.victoryQuote = prm.int(p, 'value') ?? -1;
  },
  zoom: (_c, prm) => (p) => {
    // run_zoom (MUGEN 1.1): pos (default 1,1, in the player's units), scale
    // >= 1, lag 0..1; it lasts this tick only.
    const k = p.world.gameWidth / p.world.screenWidth;
    const x = (prm.num(p, 'pos', 0) ?? 1) * p.scale * k;
    const y = (prm.num(p, 'pos', 1) ?? 1) * p.scale * k;
    const scale = Math.max(1, prm.num(p, 'scale') ?? 1);
    const lag = Math.max(0, Math.min(1, prm.num(p, 'lag') ?? 0));
    p.world.zoom = { x: Math.fround(x), y: Math.fround(y), scale: Math.fround(scale), lag: Math.fround(lag) };
  },
  envcolor: (_c, prm) => (p) => {
    // SCTRL_ENVCOLOR: value r,g,b (default white), time +1 unless -1
    // (below -1 is 1), under.
    const rgb: [number, number, number] = [prm.int(p, 'value', 0) ?? 255, prm.int(p, 'value', 1) ?? 255, prm.int(p, 'value', 2) ?? 255];
    let time = prm.int(p, 'time') ?? 1;
    if (time !== -1) time += 1;
    if (time < -1) time = 1;
    p.world.envColor = { rgb, time, under: (prm.int(p, 'under') ?? 0) !== 0 };
  },
  bgpalfx: (_c, prm) => (p) => {
    p.world.bgPalFx = palFxFrom(prm, p);
  },
  afterimage: (_c, prm) => (p) => {
    const a = newAfterImage();
    a.time = prm.int(p, 'time') ?? 1;
    a.length = prm.int(p, 'length') ?? 20;
    a.timeGap = prm.int(p, 'timegap') ?? 1;
    a.frameGap = prm.int(p, 'framegap') ?? 4;
    const tr = prm.raw('trans');
    a.blend = tr ? transBlend(tr) : { kind: 'none' };
    a.palColor = prm.num(p, 'palcolor') ?? 256;
    a.palInvertAll = (prm.int(p, 'palinvertall') ?? 0) !== 0;
    // Original bug: palbright's first two values both go to its green (red keeps 30).
    const b0 = prm.num(p, 'palbright', 0);
    const b1 = prm.num(p, 'palbright', 1);
    const b2 = prm.num(p, 'palbright', 2);
    a.palBright = [a.palBright[0], b1 ?? b0 ?? a.palBright[1], b2 ?? a.palBright[2]];
    a.palContrast = v3(prm, p, 'palcontrast', a.palContrast);
    a.palPostBright = v3(prm, p, 'palpostbright', a.palPostBright);
    a.palAdd = v3(prm, p, 'paladd', a.palAdd);
    a.palMul = v3(prm, p, 'palmul', a.palMul);
    if (a.time < -1) a.time = 1;
    if (a.length <= 0) a.length = 20;
    if (a.timeGap < 1) a.timeGap = 1;
    if (a.frameGap < 1) a.frameGap = 4;
    startAfterImage(a);
    p.afterImage = a;
  },
  afterimagetime: (_c, prm) => (p) => {
    // SCTRL_AFTERIMAGETIME: the tick count restarts with the new time.
    if (!p.afterImage.running) return;
    const t = prm.int(p, 'time') ?? prm.int(p, 'value') ?? 1;
    p.afterImage.ticks = 0;
    p.afterImage.time = t < -1 ? 1 : t;
  },
  envshake: (_c, prm) => (p) => {
    const unit = p.scale * (p.world.gameWidth / p.world.screenWidth);
    p.world.envShake = makeEnvShake(prm.int(p, 'time') ?? 0, prm.num(p, 'freq') ?? 60, prm.num(p, 'ampl') ?? Math.trunc((-4 * p.prog.data.def.localCoord[0]) / 320), prm.num(p, 'phase'), unit);
  },
  fallenvshake: () => (p) => {
    const g = p.ghv;
    if (g['fall.envshake.time'] <= 0) return;
    const unit = (p.ghvAttacker ?? p).scale * (p.world.gameWidth / p.world.screenWidth);
    p.world.envShake = makeEnvShake(g['fall.envshake.time'], g['fall.envshake.freq'], g['fall.envshake.ampl'], g['fall.envshake.phase'], unit);
    g['fall.envshake.time'] = 0;
  },
  pause: (_c, prm) => (p) => {
    p.world.startPause(p, prm.int(p, 'time') ?? 0, prm.int(p, 'movetime') ?? 0, false, { endCmdBufTime: prm.int(p, 'endcmdbuftime') ?? 0 });
  },
  superpause: (c, prm) => {
    const animRaw = prm.raw('anim') ?? '30';
    const ownAnim = /^s/i.test(animRaw);
    const sndRaw = prm.raw('sound');
    const ownSnd = !!sndRaw && /^s/i.test(sndRaw);
    return (p) => {
      const w = p.world;
      const pa = prm.int(p, 'poweradd');
      if (pa) p.addPower(pa);
      w.startPause(p, prm.int(p, 'time') ?? 30, prm.int(p, 'movetime') ?? 0, true, {
        darken: (prm.int(p, 'darken') ?? 1) !== 0,
        unhittable: (prm.int(p, 'unhittable') ?? 1) !== 0,
        p2defmul: prm.num(p, 'p2defmul') ?? 1.5,
        endCmdBufTime: prm.int(p, 'endcmdbuftime') ?? 0,
      });
      // unhittable: nohit_time of at least the pause time + 1 (counting
      // down in Players_CheckHits like any nohit time).
      if ((prm.int(p, 'unhittable') ?? 1) !== 0) p.nohitTime = Math.max(p.nohitTime, Math.max(0, prm.int(p, 'time') ?? 30) + 1);
      // The super's current targets take less damage until they recover
      // (Super.TargetDefenceMul; measured: KFM's 155-damage super does 103).
      const mul = prm.num(p, 'p2defmul') ?? 1.5;
      const m = mul > 0 ? mul : 1.5;
      // Targets not guarding (in_guard_dist, p+0xee8) take less damage until they recover.
      if (m !== 1) for (const t of p.targets.keys()) if (!t.guardFlag) t.defMul = Math.fround(t.defenceFactor / m);
      const animNo = prm.int(p, 'anim') ?? parseInt(animRaw.replace(/^s/i, ''), 10);
      if (animNo !== -1 && !Number.isNaN(animNo)) {
        const a = ownAnim ? p.prog.data.anims.get(animNo) : w.fightFx?.anims.get(animNo);
        if (a) {
          const k = p.scale;
          const e = simpleExplod(p, a, !ownAnim, p.wx + (prm.num(p, 'pos', 0) ?? 0) * p.facing * k, p.wy + (prm.num(p, 'pos', 1) ?? 0) * k, 5);
          e.superMoveTime = -1;
          w.explods.push(e);
        }
      }
      if (sndRaw) {
        const g = prm.int(p, 'sound', 0);
        const n = prm.int(p, 'sound', 1);
        if (g !== undefined && n !== undefined) w.sounds.push({ owner: ownSnd ? p : null, group: g, number: n });
      }
      void c;
    };
  },
  trans: (_c, prm) => (p) => {
    const t = prm.raw('trans');
    if (!t) return;
    let b = transBlend(t);
    if (b.kind === 'add' && prm.has('alpha')) b = { kind: 'add', src: prm.int(p, 'alpha', 0) ?? 256, dst: prm.int(p, 'alpha', 1) ?? 256 };
    p.trans = b;
  },
  angledraw: (_c, prm) => (p) => {
    p.angleDraw = true;
    const v = prm.num(p, 'value');
    if (v !== undefined) p.angle = v;
    if (prm.has('scale')) p.drawScale = [prm.num(p, 'scale', 0) ?? 1, prm.num(p, 'scale', 1) ?? 1];
  },
  angleset: (_c, prm) => (p) => {
    p.angle = prm.num(p, 'value') ?? p.angle;
  },
  angleadd: (_c, prm) => (p) => {
    p.angle += prm.num(p, 'value') ?? 0;
  },
  anglemul: (_c, prm) => (p) => {
    p.angle *= prm.num(p, 'value') ?? 1;
  },
  offset: (_c, prm) => (p) => {
    // sctrl.c Offset: only the given axes are written.
    const c = p.localConv;
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    p.drawOffset = [x !== undefined ? x * c : p.drawOffset[0], y !== undefined ? y * c : p.drawOffset[1]];
  },
  assertspecial: (c) => (p) => {
    for (const k of ['flag', 'flag2', 'flag3']) {
      const f = c.params.get(k)?.trim().toLowerCase();
      if (f) (GLOBAL_ASSERTS.has(f) ? p.world.assertFlags : p.special).add(f);
    }
  },
  width: (_c, prm) => (p) => {
    // SCTRL_WIDTH sets all four (ints, missing ones 0); value only counts
    // when neither edge nor player is given.
    const i = (k: string, n: number) => Math.trunc(prm.num(p, k, n) ?? 0);
    if (!prm.has('edge') && !prm.has('player')) {
      const v: [number, number] = [i('value', 0), i('value', 1)];
      p.width = { edge: v, player: [v[0], v[1]] };
    } else p.width = { edge: [i('edge', 0), i('edge', 1)], player: [i('player', 0), i('player', 1)] };
  },
  screenbound: (_c, prm) => (p) => {
    p.screenBound = (prm.int(p, 'value') ?? 0) !== 0;
    p.moveCamera = [(prm.int(p, 'movecamera', 0) ?? 0) !== 0, (prm.int(p, 'movecamera', 1) ?? 0) !== 0];
  },
  playerpush: (_c, prm) => (p) => {
    p.pushEnabled = (prm.int(p, 'value') ?? 1) !== 0;
  },
  remappal: (_c, prm) => (p) => {
    // Only remaps of the character's main palette group (1,n) are supported.
    const dg = prm.int(p, 'dest', 0);
    const dn = prm.int(p, 'dest', 1);
    if (dg === 1 && dn !== undefined) p.palRemap = dn;
    else if (dg === -1) p.palRemap = undefined;
  },

  // Targets
  targetbind: (_c, prm) => (p) => {
    // sctrl.c TargetBind: bind_x/y = Ftol(FromLocal(pos)), whole internal units.
    const k = p.world.gameWidth / p.world.screenWidth;
    const iu = (v: number) => Math.trunc(v * p.scale * k) / k;
    eachTarget(p, prm, (t) => {
      let time = prm.int(p, 'time') ?? 1;
      if (time < -1) time = 1;
      const off: [number, number] = [iu(prm.num(p, 'pos', 0) ?? 0), iu(prm.num(p, 'pos', 1) ?? 0)];
      // Binds are stored in world units. x follows the binder's facing when
      // placed (end of its update, after a Turn).
      t.bind = { to: p, offset: off, time, byTarget: true };
    });
  },
  bindtotarget: (c, prm, env) => {
    // pos = x, y, postype (foot/mid/head): the word is not an expression.
    let src = c.params.get('pos') ?? '';
    let postype = 0;
    // sctrl.c: after the numbers only the word's first letter counts
    // (f foot, m mid, h head: Leona's "20,0,food" is foot).
    const m = /,\s*([a-z][a-z0-9_]*)\s*$/i.exec(src);
    if (m) {
      const c = m[1]!.toLowerCase()[0];
      if (c === 'm') postype = 1;
      else if (c === 'h') postype = 2;
      src = src.slice(0, m.index);
    }
    let pos: Fn<P>[] = [];
    try {
      pos = src.trim() ? compileExprList(src, env) : [];
    } catch {
      pos = [];
    }
    const comp = (p: P, i: number): number | undefined => {
      const fn = pos[i];
      if (!fn) return undefined;
      const v = fn(p);
      return R.t === BOTTOM ? undefined : v;
    };
    return (p) => {
      // run_bindtotarget: the first target matching the ID. The player moves
      // to it now, and the target is bound back to the player (placed at the
      // end of the player's update like a TargetBind target).
      const id = prm.int(p, 'id') ?? -1;
      let t: P | undefined;
      for (const q of p.targets.keys()) {
        if (!q.guardFlag && (id === -1 || q.ghv.chainid === id)) {
          t = q;
          break;
        }
      }
      if (!t) return;
      const w = p.world;
      const k = w.gameWidth / w.screenWidth;
      // Foot / mid / head offsets in internal units, truncated.
      const tk = t.scale * k;
      const ox = postype === 1 ? Math.trunc(t.const('size.mid.pos.x') * tk) : postype === 2 ? Math.trunc(t.const('size.head.pos.x') * tk) : 0;
      const oy = postype === 1 ? Math.trunc(t.const('size.mid.pos.y') * tk) : postype === 2 ? Math.trunc(t.const('size.head.pos.y') * tk) : 0;
      let time = prm.int(p, 'time') ?? 1;
      if (time < -1) time = 1;
      const pk = p.scale * k;
      const prev = t.bind?.byTarget && t.bind.to === p ? t.bind : undefined;
      const b = prev ?? { to: p, offset: [0, 0] as [number, number], time, byTarget: true };
      b.time = time;
      const x = comp(p, 0);
      if (x !== undefined) {
        const X = Math.fround(x) * pk + ox;
        p.setWorldPos((X * t.facing + t.wx * k) / k);
        b.offset[0] = Math.trunc(-(X * t.facing * p.facing)) / k;
      }
      const y = comp(p, 1);
      if (y !== undefined) {
        const Y = Math.fround(y) * pk + oy;
        p.pos.y = (Y + t.wy * k) / k / p.scale;
        b.offset[1] = Math.trunc(-Y) / k;
      }
      t.bind = b;
    };
  },
  // run_targets: every Target* controller evaluates its parameters for each
  // target, in the original's order (a Random in the value is drawn per
  // target: Kim's 2060 sends its two targets to 2020+random%2 each).
  targetstate: (_c, prm) => (p) => {
    eachTarget(p, prm, (t) => {
      let v = prm.int(p, 'value');
      if (v === undefined) return;
      if (v < 0) v = 0;
      t.stateOwner = p;
      // Like p1stateno: the statedef (poweradd, anim...) applies when the
      // state first runs (measured: KFM's 821 adds its power a tick later).
      t.enterLater(v);
    });
  },
  targetfacing: (_c, prm) => (p) => {
    // Every target (no ID): > 0 faces like p, < 0 away from it, 0 nothing.
    for (const t of [...p.targets.keys()]) {
      const v = prm.int(p, 'value') ?? 0;
      if (v > 0) t.facing = p.facing;
      else if (v < 0) t.facing = -p.facing;
    }
  },
  targetlifeadd: (_c, prm) => (p) => {
    // No attack multiplier: only the target's defence (Player_ApplyDamage).
    eachTarget(p, prm, (t) => {
      const abs = (prm.int(p, 'absolute') ?? 0) !== 0;
      const kill = (prm.int(p, 'kill') ?? 1) !== 0;
      const v = prm.int(p, 'value') ?? 0;
      t.applyLifeAdd(v, kill, abs);
    });
  },
  targetpoweradd: (_c, prm) => (p) => {
    for (const t of [...p.targets.keys()]) {
      const v = prm.int(p, 'value') ?? 0;
      if (targetMatches(t, prm.int(p, 'id') ?? -1)) t.addPower(v);
    }
  },
  targetvelset: (_c, prm) => (p) => {
    eachTarget(p, prm, (t) => {
      const x = prm.num(p, 'x');
      const y = prm.num(p, 'y');
      const k = p.scale / t.scale;
      if (x !== undefined) t.vel.x = x * k;
      if (y !== undefined) t.vel.y = y * k;
    });
  },
  targetveladd: (_c, prm) => (p) => {
    eachTarget(p, prm, (t) => {
      const x = prm.num(p, 'x');
      const y = prm.num(p, 'y');
      const k = p.scale / t.scale;
      if (x !== undefined) t.vel.x += x * k;
      if (y !== undefined) t.vel.y += y * k;
    });
  },
  targetdrop: (_c, prm) => (p) => {
    // A target hit by the excluded ID stays (only the first one with
    // keepone); every other target is dropped.
    let kept = false;
    for (const t of [...p.targets.keys()]) {
      const keep = prm.int(p, 'excludeid') ?? -1;
      const keepOne = (prm.int(p, 'keepone') ?? 1) !== 0;
      if (keep === t.ghv.chainid && !kept) {
        if (keepOne) kept = true;
        continue;
      }
      p.targets.delete(t);
    }
  },

  helper: (c, _prm, env) => compileHelper(c, env),
  destroyself: (c, _prm, env) => compileDestroySelf(c, env),
  parentvarset: (c, _prm, env) => compileParentVar(c, env, false),
  parentvaradd: (c, _prm, env) => compileParentVar(c, env, true),
  bindtoparent: (c, _prm, env) => compileBindTo(c, env, false),
  bindtoroot: (c, _prm, env) => compileBindTo(c, env, true),
  projectile: (c, _prm, env) => compileProjectile(c, env),

  reversaldef: (c, _prm, env) => {
    const build = compileHitDef(c, env);
    const attrs = parseAttrList(c.params.get('reversal.attr'));
    return (p) => {
      const hd = build(p);
      p.reversal = { attrs, hd };
      // ...and a ReversalDef replaces a HitDef: it is the player's HitDef
      // (SCTRL_REVERSALDEF shares SCTRL_HITDEF's code: attr, guard.dist and
      // active, which the AI and HitDefAttr read), though it never hits.
      if (hd.guardDist === -1) hd.guardDist = p.guardDist;
      p.guardDist = hd.guardDist;
      if (p.stateType === 's' || p.stateType === 'c' || p.stateType === 'a') hd.attrState = p.stateType;
      p.hitDef = hd;
      p.hitDefActive = false;
      p.hitDefSet = true;
      p.hitDefAttrOn = true;
      p.hitTargets.clear();
    };
  },
  hitoverride: (c, prm) => {
    // HitOverride_ParseParams: attr stays 0 (never matches) when not given.
    const raw = c.params.get('attr');
    const attr = raw === undefined ? 0 : attrBits(parseAttrList(raw));
    return (p) => {
      let slot = prm.int(p, 'slot') ?? 0;
      if (slot < 0 || slot > 7) slot = 0;
      let stateNo = prm.int(p, 'stateno') ?? -1;
      if (stateNo < -1) stateNo = -1;
      let time = prm.int(p, 'time') ?? 1;
      if (time < -1) time = 1;
      p.hitOverrides[slot] = { attr, stateNo, time, forceAir: (prm.int(p, 'forceair') ?? 0) !== 0, active: true };
    };
  },
};
Object.assign(IMPLS, EXTRA);

let playerEnvRef: TriggerEnv<P> | undefined;


/**
 * NotHitBy / HitBy (sctrl.c SCTRL_HITBY): value writes the first attribute
 * mask, value2 the second; HitBy stores the attributes it allows, NotHitBy
 * all the others (~attr & 0xFFF).
 */
function hitByController(c: ControllerDef, prm: Params, not: boolean): (p: P) => void {
  const key = c.params.has('value') ? 'value' : 'value2';
  const bits = parseHitDefAttr(c.params.get(key) ?? '', 0).bits;
  const mask = not ? ~bits & 0xfff : bits;
  const slot = key === 'value2' ? 1 : 0;
  return (p) => {
    const time = prm.int(p, 'time') ?? 1;
    p.hitBy[slot] = { mask, time };
  };
}

/** VarSet / VarAdd: one variable (sctrl.c parse_var_value / parse_var_line). */
function varController(c: ControllerDef, _prm: Params, env: TriggerEnv<P>, mode: 'set' | 'add'): (p: P) => void {
  const t = varTarget(c, env, true);
  if (!t) return () => {};
  return (p) => {
    const i = t.index(p);
    if (R.t === BOTTOM) return;
    applyVar(p, t.kind, R.t === 1 ? toInt(i) : i, t.value, mode);
  };
}

function applyVar(p: P, kind: 'var' | 'fvar' | 'sysvar' | 'sysfvar', i: number, fn: Fn<P>, mode: 'set' | 'add'): void {
  const v = fn(p);
  if (R.t === BOTTOM) return;
  const arr = kind === 'var' ? p.vars : kind === 'fvar' ? p.fvars : kind === 'sysvar' ? p.sysVars : p.sysFvars;
  if (i < 0 || i >= arr.length) return;
  const isF = arr instanceof Float32Array;
  const val = isF ? v : R.t === 1 ? toInt(v) : v;
  arr[i] = mode === 'add' ? arr[i]! + val : val;
}

export function compileController(c: ControllerDef, env: TriggerEnv<P>, mugenVersion?: string): CompiledController {
  playerEnvRef = env;
  const prm = new Params(c, env);
  const persistent = c.params.has('persistent') ? parseInt(c.params.get('persistent')!, 10) || 0 : 1;
  const ignoreHitPause = (parseInt(c.params.get('ignorehitpause') ?? '0', 10) || 0) !== 0;
  const triggerAll = c.triggerAll.map((t) => compileExpr(t, env));
  const triggers = c.triggers.map((g) => g.map((t) => compileExpr(t, env)));
  if (!c.type) throw new Error('falta type');
  // mugen.exe refuses the character on any parameter it cannot read.
  checkControllerParams(c, mugenVersion);
  const impl = IMPLS[c.type];
  const run: (p: P) => void = impl ? impl(c, prm, env) : () => {};
  return { def: c, triggerAll, triggers, persistent, ignoreHitPause, run };
}

/** run_ctrl_anim: ctrl and anim of ChangeState/SelfState, -1 = unchanged, other negative anims 0. */
function ctrlAnim(p: P, prm: Params): [boolean | undefined, number | undefined] {
  const c = prm.int(p, 'ctrl');
  let a = prm.int(p, 'anim');
  if (a === -1) a = undefined;
  else if (a !== undefined && a < 0) a = 0;
  return [c === undefined || c === -1 ? undefined : c !== 0, a];
}

/** Sound_PlayerChannel: one sound channel per player slot and channel number. */
function soundKey(p: P, ch: number): string {
  return `${p.id}:${ch}`;
}
