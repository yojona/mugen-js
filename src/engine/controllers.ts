// State controllers (sctrls.html). Parameters are compiled once and evaluated
// when the controller fires, left to right, as MUGEN does.

import { checkControllerParams, specKeys } from './sctrl-params';
import { varTarget } from './var-line';
import { BOTTOM, compileExpr, compileExprList, R, toInt, type Fn, type TriggerEnv } from '../expr/compile';
import type { ControllerDef } from './cns';
import { compileHitDef, parseAttrList } from './hitdef';
import { compileExplod, compileExplodBindTime, compileGameMakeAnim, compileMakeDust, compileModifyExplod, compileRemoveExplod, simpleExplod, transBlend } from './explod';
import { newAfterImage, type PalFxState } from './fx';
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

const IMPLS: Record<string, Impl> = {
  null: () => () => {},

  changestate: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v === undefined) return;
    const ctrl = prm.int(p, 'ctrl');
    const anim = prm.int(p, 'anim');
    // A player with control may turn as it changes state (mugen.exe 0x4490fd,
    // before the new statedef applies, so its anim wins over the turn's).
    if (p.ctrl && !p.isHelper && (p.stateType === 's' || p.stateType === 'c')) p.world.turnCheck(p);
    p.changeState(v, ctrl === undefined ? undefined : ctrl !== 0, anim);
  },
  selfstate: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v === undefined) return;
    p.returnToOwnStates();
    const ctrl = prm.int(p, 'ctrl');
    const anim = prm.int(p, 'anim');
    p.changeState(v, ctrl === undefined ? undefined : ctrl !== 0, anim);
  },

  changeanim: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v === undefined) return;
    const elem = prm.int(p, 'elem');
    p.changeAnim(v, elem === undefined ? 0 : elem - 1);
  },
  changeanim2: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v === undefined) return;
    const elem = prm.int(p, 'elem');
    p.changeAnim(v, elem === undefined ? 0 : elem - 1, true);
  },

  velset: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    if (x !== undefined) p.vel.x = Math.fround(x);
    if (y !== undefined) p.vel.y = Math.fround(y);
  },
  veladd: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    if (x !== undefined) p.vel.x = p.vel.x + Math.fround(x);
    if (y !== undefined) p.vel.y = p.vel.y + Math.fround(y);
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
    if (x !== undefined) p.pos.x = p.world.camera.x / p.scale + Math.fround(x);
    if (y !== undefined) p.pos.y = Math.fround(y);
  },
  posadd: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    if (x !== undefined) p.pos.x = p.pos.x + Math.fround(x) * p.facing;
    if (y !== undefined) p.pos.y = p.pos.y + Math.fround(y);
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
    const st = prm.raw('statetype')?.trim().toLowerCase()[0];
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
    const max = p.const('data.life');
    const kill = (prm.int(p, 'kill') ?? 1) !== 0;
    p.life = Math.min(max, Math.max(kill ? 0 : 1, p.life + v));
  },
  lifeset: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) p.life = Math.min(p.const('data.life'), Math.max(0, v));
  },
  poweradd: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) p.addPower(v);
  },
  powerset: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) p.power = Math.max(0, Math.min(p.const('data.power'), v));
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
    if (iv !== undefined) {
      const last = prm.int(p, 'last') ?? 59;
      for (let i = Math.max(0, first); i <= Math.min(59, last); i++) p.vars[i] = iv;
    } else if (fv !== undefined) {
      const last = prm.int(p, 'last') ?? 39;
      for (let i = Math.max(0, first); i <= Math.min(39, last); i++) p.fvars[i] = fv;
    }
  },

  hitdef: (c, _prm, env) => {
    const build = compileHitDef(c, env);
    return (p) => {
      p.hitDef = build(p);
      // The attr's state part is the player's statetype when the HitDef runs
      // (measured: KFM's 1060 "attr = A, SA" reads back as S, SA in mugen.exe,
      // so its HitDefAttr = SC super cancel works).
      if (p.stateType === 's' || p.stateType === 'c' || p.stateType === 'a') p.hitDef.attrState = p.stateType;
      p.hitDefActive = true;
      p.hitDefSet = true;
      p.hitTargets.clear();
    };
  },
  hitvelset: (_c, prm) => (p) => {
    if ((prm.int(p, 'x') ?? 1) !== 0) p.vel.x = Math.fround(p.ghv.xvel);
    if ((prm.int(p, 'y') ?? 1) !== 0) p.vel.y = Math.fround(p.ghv.yvel);
  },
  hitfallvel: () => (p) => {
    const xv = p.ghv['fall.xvel'];
    if (!Number.isNaN(xv)) p.vel.x = Math.fround(xv);
    p.vel.y = Math.fround(p.ghv['fall.yvel']);
  },
  hitfallset: (_c, prm) => (p) => {
    const v = prm.int(p, 'value') ?? -1;
    if (v !== -1) p.ghv.fall = v ? 1 : 0;
    const x = prm.num(p, 'xvel');
    const y = prm.num(p, 'yvel');
    if (x !== undefined) p.ghv['fall.xvel'] = x;
    if (y !== undefined) p.ghv['fall.yvel'] = y;
  },
  hitfalldamage: () => (p) => {
    const dmg = p.ghv['fall.damage'];
    if (!dmg) return;
    p.life = Math.max(p.ghv['fall.kill'] ? 0 : Math.min(p.life, 1), p.life - dmg);
    p.ghv['fall.damage'] = 0;
    if (p.life <= 0) p.alive = false;
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
    if (v !== undefined && p.hitDef) p.hitDef.guardDist = v;
  },
  hitadd: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) p.hitCount += v;
  },
  defencemulset: (_c, prm) => (p) => {
    const v = prm.num(p, 'value');
    if (v !== undefined) p.defenceMul = v;
  },
  nothitby: (c, prm) => hitByController(c, prm, true),
  hitby: (c, prm) => hitByController(c, prm, false),
  movehitreset: () => (p) => {
    p.moveContact = p.moveHit = p.moveGuarded = 0;
  },

  playsnd: (_c, prm) => {
    // value = [F|S]group, number   (F = common sound file, S = own; Cns_ParseSoundRef)
    const raw = (prm.raw('value') ?? '').trim();
    const common = /^f/i.test(raw);
    const fns = compileExprList(/^[fs]/i.test(raw) ? raw.slice(1) : raw, playerEnvRef!);
    const [groupFn, numFn] = fns;
    return (p) => {
      if (!groupFn) return;
      const g = groupFn(p);
      if (R.t === BOTTOM) return;
      // "S5" alone: number 0.
      const n = numFn ? numFn(p) : 0;
      if ((R.t as number) === BOTTOM) return;
      p.events.push({ kind: 'sound', group: g | 0, number: n | 0, common, channel: prm.int(p, 'channel') ?? -1 });
    };
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
  const id = prm.int(p, 'id') ?? -1;
  for (const [t, tid] of p.targets) if (id === -1 || tid === id) f(t);
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
    for (const q of p.world.players) q.palFx = palFxFrom(prm, p);
    p.world.bgPalFx = palFxFrom(prm, p);
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
    a.palBright = v3(prm, p, 'palbright', a.palBright);
    a.palContrast = v3(prm, p, 'palcontrast', a.palContrast);
    a.palPostBright = v3(prm, p, 'palpostbright', a.palPostBright);
    a.palAdd = v3(prm, p, 'paladd', a.palAdd);
    a.palMul = v3(prm, p, 'palmul', a.palMul);
    p.afterImage = a;
  },
  afterimagetime: (_c, prm) => (p) => {
    const t = prm.int(p, 'time') ?? prm.int(p, 'value') ?? 1;
    p.afterImage.time = t;
  },
  envshake: (_c, prm) => (p) => {
    const freq = prm.num(p, 'freq') ?? 60;
    p.world.envShake = {
      time: prm.int(p, 'time') ?? 0,
      freq,
      ampl: prm.int(p, 'ampl') ?? Math.trunc((-4 * p.prog.data.def.localCoord[0]) / 320),
      phase: prm.num(p, 'phase') ?? (freq >= 90 ? 90 : 0),
    };
  },
  fallenvshake: () => (p) => {
    const g = p.ghv;
    if (g['fall.envshake.time'] <= 0) return;
    p.world.envShake = { time: g['fall.envshake.time'], freq: g['fall.envshake.freq'], ampl: g['fall.envshake.ampl'], phase: g['fall.envshake.phase'] };
    g['fall.envshake.time'] = 0;
  },
  pause: (_c, prm) => (p) => {
    p.world.startPause(p, prm.int(p, 'time') ?? 0, prm.int(p, 'movetime') ?? 0, false);
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
      });
      // The super's current targets take less damage until they recover
      // (Super.TargetDefenceMul; measured: KFM's 155-damage super does 103).
      const mul = prm.num(p, 'p2defmul') ?? 1.5;
      if (mul > 0) for (const t of p.targets.keys()) t.superDefMul = mul;
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
    p.drawOffset = [prm.num(p, 'x') ?? 0, prm.num(p, 'y') ?? 0];
  },
  assertspecial: (c) => (p) => {
    for (const k of ['flag', 'flag2', 'flag3']) {
      const f = c.params.get(k)?.trim().toLowerCase();
      if (f) p.special.add(f);
    }
  },
  width: (_c, prm) => (p) => {
    if (prm.has('value')) {
      const v: [number, number] = [prm.num(p, 'value', 0) ?? 0, prm.num(p, 'value', 1) ?? 0];
      p.width = { edge: v, player: v };
    }
    if (prm.has('edge')) p.width.edge = [prm.num(p, 'edge', 0) ?? 0, prm.num(p, 'edge', 1) ?? 0];
    if (prm.has('player')) p.width.player = [prm.num(p, 'player', 0) ?? 0, prm.num(p, 'player', 1) ?? 0];
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
    const time = prm.int(p, 'time') ?? 1;
    const off: [number, number] = [prm.num(p, 'pos', 0) ?? 0, prm.num(p, 'pos', 1) ?? 0];
    eachTarget(p, prm, (t) => {
      // Offsets are in the binder's units; binds are stored in world units.
      t.bind = { to: p, offset: [off[0] * p.facing * p.scale, off[1] * p.scale], time, byTarget: true };
    });
  },
  bindtotarget: (_c, prm) => (p) => {
    const time = prm.int(p, 'time') ?? 1;
    const off: [number, number] = [prm.num(p, 'pos', 0) ?? 0, prm.num(p, 'pos', 1) ?? 0];
    let done = false;
    eachTarget(p, prm, (t) => {
      if (done) return;
      done = true;
      p.bind = { to: t, offset: [off[0] * t.facing * p.scale, off[1] * p.scale], time };
    });
  },
  targetstate: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v === undefined) return;
    eachTarget(p, prm, (t) => {
      t.stateOwner = p;
      // Like p1stateno: the statedef (poweradd, anim...) applies when the
      // state first runs (measured: KFM's 821 adds its power a tick later).
      t.enterLater(v);
    });
  },
  targetfacing: (_c, prm) => (p) => {
    const v = prm.int(p, 'value') ?? 1;
    eachTarget(p, prm, (t) => {
      t.facing = v >= 0 ? p.facing : -p.facing;
    });
  },
  targetlifeadd: (_c, prm) => (p) => {
    const v = prm.int(p, 'value') ?? 0;
    const kill = (prm.int(p, 'kill') ?? 1) !== 0;
    const abs = (prm.int(p, 'absolute') ?? 0) !== 0;
    eachTarget(p, prm, (t) => {
      const amt = abs ? v : Math.trunc(v * p.attackFactor * (100 / Math.max(1, t.const('data.defence'))) * t.defenceMul);
      t.life = Math.min(t.const('data.life'), Math.max(kill ? 0 : Math.min(t.life, 1), t.life + amt));
      if (t.life <= 0) t.alive = false;
    });
  },
  targetpoweradd: (_c, prm) => (p) => {
    const v = prm.int(p, 'value') ?? 0;
    eachTarget(p, prm, (t) => t.addPower(v));
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
      const k = p.scale / t.scale;
      t.vel.x += (prm.num(p, 'x') ?? 0) * k;
      t.vel.y += (prm.num(p, 'y') ?? 0) * k;
    });
  },
  targetdrop: (_c, prm) => (p) => {
    const keep = prm.int(p, 'excludeid') ?? -1;
    const keepOne = (prm.int(p, 'keepone') ?? 1) !== 0;
    let kept = false;
    for (const [t, id] of p.targets) {
      if (keep !== -1 && id === keep && (!keepOne || !kept)) {
        kept = true;
        continue;
      }
      p.targets.delete(t);
    }
  },

  helper: (c, _prm, env) => compileHelper(c, env),
  destroyself: () => compileDestroySelf(),
  parentvarset: (c, _prm, env) => compileParentVar(c, env, false),
  parentvaradd: (c, _prm, env) => compileParentVar(c, env, true),
  bindtoparent: (c, _prm, env) => compileBindTo(c, env, false),
  bindtoroot: (c, _prm, env) => compileBindTo(c, env, true),
  projectile: (c, _prm, env) => compileProjectile(c, env),

  reversaldef: (c, _prm, env) => {
    const build = compileHitDef(c, env);
    const attrs = parseAttrList(c.params.get('reversal.attr'));
    return (p) => {
      p.reversal = { attrs, hd: build(p) };
    };
  },
  hitoverride: (c, prm) => {
    const attrs = parseAttrList(c.params.get('attr'));
    return (p) => {
      const slot = Math.max(0, Math.min(7, prm.int(p, 'slot') ?? 0));
      p.hitOverrides[slot] = { attrs, stateNo: prm.int(p, 'stateno') ?? -1, time: prm.int(p, 'time') ?? 1, forceAir: (prm.int(p, 'forceair') ?? 0) !== 0 };
    };
  },
};
Object.assign(IMPLS, EXTRA);

let playerEnvRef: TriggerEnv<P> | undefined;


/** NotHitBy / HitBy: value = SCA, NA, SA (value2 uses the second slot). */
function hitByController(c: ControllerDef, prm: Params, not: boolean): (p: P) => void {
  const key = c.params.has('value2') ? 'value2' : 'value';
  const attrs = (c.params.get(key) ?? '').toLowerCase().split(',').map((s) => s.trim());
  const slot = key === 'value2' ? 1 : 0;
  return (p) => {
    const time = prm.int(p, 'time') ?? 1;
    p.hitBy[slot] = { attrs, time, not };
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
