// State controllers (sctrls.html). Parameters are compiled once and evaluated
// when the controller fires, left to right, as MUGEN does.

import { BOTTOM, compileExpr, compileExprList, R, toInt, type Fn, type TriggerEnv } from '../expr/compile';
import type { ControllerDef } from './cns';
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
  constructor(
    private def: ControllerDef,
    private env: TriggerEnv<P>,
  ) {}

  has(k: string): boolean {
    return this.def.params.has(k);
  }
  raw(k: string): string | undefined {
    return this.def.params.get(k);
  }
  list(k: string): Fn<P>[] | null {
    let v = this.cache.get(k);
    if (v === undefined) {
      const src = this.def.params.get(k);
      v = src === undefined ? null : compileExprList(src, this.env);
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
  /** Eagerly compile everything so syntax errors surface at load time. */
  validate(skip: Set<string>): void {
    for (const k of this.def.params.keys()) if (!skip.has(k)) this.list(k);
  }
}

type Impl = (c: ControllerDef, prm: Params, env: TriggerEnv<P>) => (p: P) => void;

/** Params that are not expressions (strings, flags). */
const STRING_PARAMS = new Set([
  'attr', 'hitflag', 'guardflag', 'animtype', 'air.animtype', 'fall.animtype', 'ground.type', 'air.type', 'p1sprpriority', 'priority', 'sparkno', 'guard.sparkno', 'hitsound', 'guardsound',
  'flag', 'flag2', 'flag3', 'flag4', 'flag5', 'flag6', 'flag7', 'flag8', 'reversal.attr', 'statetype', 'movetype', 'physics', 'postype', 'bindtime', 'trans', 'value', 'value2', 'name',
  'ownpal', 'removeongethit', 'space', 'helpertype', 'type', 'text', 'params', 'channel', 'sound', 'anim', 'facing', 'vfacing', 'pos', 'random', 'id', 'ignorehitpause', 'persistent',
]);

const IMPLS: Record<string, Impl> = {
  null: () => () => {},

  changestate: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v === undefined) return;
    const ctrl = prm.int(p, 'ctrl');
    const anim = prm.int(p, 'anim');
    p.changeState(v, ctrl === undefined ? undefined : ctrl !== 0, anim);
  },
  selfstate: (c, prm, env) => IMPLS.changestate!(c, prm, env),

  changeanim: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v === undefined) return;
    const elem = prm.int(p, 'elem');
    p.changeAnim(v, elem === undefined ? 0 : elem - 1);
  },
  changeanim2: (c, prm, env) => IMPLS.changeanim!(c, prm, env),

  velset: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    if (x !== undefined) p.vel.x = Math.fround(x);
    if (y !== undefined) p.vel.y = Math.fround(y);
  },
  veladd: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    if (x !== undefined) p.vel.x = Math.fround(p.vel.x + x);
    if (y !== undefined) p.vel.y = Math.fround(p.vel.y + y);
  },
  velmul: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    if (x !== undefined) p.vel.x = Math.fround(p.vel.x * x);
    if (y !== undefined) p.vel.y = Math.fround(p.vel.y * y);
  },
  posset: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    if (x !== undefined) p.pos.x = Math.fround(p.world.camera.x + x);
    if (y !== undefined) p.pos.y = Math.fround(y);
  },
  posadd: (_c, prm) => (p) => {
    const x = prm.num(p, 'x');
    const y = prm.num(p, 'y');
    if (x !== undefined) p.pos.x = Math.fround(p.pos.x + x * p.facing);
    if (y !== undefined) p.pos.y = Math.fround(p.pos.y + y);
  },
  posfreeze: (_c, prm) => (p) => {
    p.posFreeze = (prm.int(p, 'value') ?? 1) !== 0;
  },
  ctrlset: (_c, prm) => (p) => {
    const v = prm.int(p, 'value');
    if (v !== undefined) p.ctrl = v !== 0;
  },
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

  playsnd: (_c, prm) => {
    // value = [F]group, number   (F = common sound file)
    const raw = prm.raw('value') ?? '';
    const m = /^\s*(f?)\s*([^,]*),(.*)$/i.exec(raw);
    const common = !!m?.[1];
    const groupFn = m ? compileExpr(m[2]!, playerEnvRef!) : null;
    const numFn = m ? compileExpr(m[3]!, playerEnvRef!) : null;
    return (p) => {
      if (!groupFn || !numFn) return;
      const g = groupFn(p);
      if (R.t === BOTTOM) return;
      const n = numFn(p);
      if ((R.t as number) === BOTTOM) return;
      p.events.push({ kind: 'sound', group: g | 0, number: n | 0, common, channel: prm.int(p, 'channel') ?? -1 });
    };
  },
};

let playerEnvRef: TriggerEnv<P> | undefined;

/** Controllers accepted but not simulated yet (no effect). */
const PENDING = [
  'hitdef', 'reversaldef', 'projectile', 'helper', 'explod', 'modifyexplod', 'removeexplod', 'explodbindtime', 'gamemakeanim', 'makedust',
  'nothitby', 'hitby', 'hitoverride', 'hitvelset', 'hitfallvel', 'hitfallset', 'hitfalldamage', 'fallenvshake', 'defencemulset', 'attackmulset',
  'width', 'playerpush', 'screenbound', 'assertspecial', 'pause', 'superpause', 'envshake', 'envcolor', 'forcefeedback', 'palfx', 'allpalfx', 'bgpalfx',
  'afterimage', 'afterimagetime', 'trans', 'angledraw', 'angleset', 'angleadd', 'anglemul', 'offset', 'remappal', 'stopsnd', 'sndpan',
  'targetbind', 'targetstate', 'targetvelset', 'targetveladd', 'targetfacing', 'targetlifeadd', 'targetpoweradd', 'targetdrop', 'bindtotarget', 'bindtoparent', 'bindtoroot',
  'destroyself', 'parentvarset', 'parentvaradd', 'displaytoclipboard', 'appendtoclipboard', 'clearclipboard', 'movehitreset', 'hitadd', 'attackdist', 'victoryquote', 'zoom', 'gravity',
];

/** Parse `var(5) = expr` style VarSet/VarAdd parameters. */
function varController(c: ControllerDef, prm: Params, env: TriggerEnv<P>, mode: 'set' | 'add'): (p: P) => void {
  type Target = { kind: 'var' | 'fvar' | 'sysvar' | 'sysfvar'; index: number; value: Fn<P> };
  const targets: Target[] = [];
  for (const [k, v] of c.params) {
    const m = /^(sys)?(f?)var\(\s*(\d+)\s*\)$/.exec(k);
    if (m) {
      const kind = `${m[1] ?? ''}${m[2] ? 'f' : ''}var` as Target['kind'];
      targets.push({ kind, index: parseInt(m[3]!, 10), value: compileExpr(v, env) });
    }
  }
  if (prm.has('v') || prm.has('fv')) {
    const isF = prm.has('fv');
    const idx = compileExpr(prm.raw(isF ? 'fv' : 'v')!, env);
    const val = prm.list('value')?.[0];
    if (val) {
      return (p) => {
        const i = idx(p);
        if (R.t === BOTTOM) return;
        applyVar(p, isF ? 'fvar' : 'var', R.t === 1 ? toInt(i) : i, val, mode);
      };
    }
  }
  return (p) => {
    for (const t of targets) applyVar(p, t.kind, t.index, t.value, mode);
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

export function compileController(c: ControllerDef, env: TriggerEnv<P>): CompiledController {
  playerEnvRef = env;
  const prm = new Params(c, env);
  const persistent = c.params.has('persistent') ? parseInt(c.params.get('persistent')!, 10) || 0 : 1;
  const ignoreHitPause = (parseInt(c.params.get('ignorehitpause') ?? '0', 10) || 0) !== 0;
  const triggerAll = c.triggerAll.map((t) => compileExpr(t, env));
  const triggers = c.triggers.map((g) => g.map((t) => compileExpr(t, env)));
  if (!c.type) throw new Error('falta type');
  let run: (p: P) => void;
  const impl = IMPLS[c.type];
  if (impl) {
    run = impl(c, prm, env);
    if (c.type !== 'playsnd' && c.type !== 'statetypeset') prm.validate(STRING_PARAMS);
  } else if (PENDING.includes(c.type)) {
    run = () => {};
  } else {
    throw new Error(`controller desconocido "${c.type}"`);
  }
  return { def: c, triggerAll, triggers, persistent, ignoreHitPause, run };
}
