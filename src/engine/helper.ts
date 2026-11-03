// Helper controller and helper-related controllers (sctrls.html Helper,
// DestroySelf, ParentVarSet/Add, BindToParent/BindToRoot).

import { varTarget } from './var-line';
import { BOTTOM, compileExpr, compileExprList, R, toInt, type Fn, type TriggerEnv } from '../expr/compile';
import { unquote } from '../formats/text';
import type { ControllerDef } from './cns';
import { Player } from './player';

type P = Player;

function paramFns(c: ControllerDef, env: TriggerEnv<P>) {
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
  for (const k of ['id', 'pos', 'facing', 'stateno', 'keyctrl', 'ownpal', 'supermovetime', 'pausemovetime']) if (c.params.has(k)) list(k);
  return { num, int, raw: (k: string) => c.params.get(k)?.trim() };
}

export function compileHelper(c: ControllerDef, env: TriggerEnv<P>): (p: P) => void {
  const prm = paramFns(c, env);
  return (p) => {
    const w = p.world;
    const h = new Player(p.prog, w, p.side);
    h.isHelper = true;
    h.parent = p;
    h.root = p.root;
    h.helperId = prm.int(p, 'id') ?? 0;
    h.helperName = prm.raw('name') ? unquote(prm.raw('name')!) : `${p.root.name}'s helper`;
    h.keyCtrl = (prm.int(p, 'keyctrl') ?? 0) !== 0;
    if (h.keyCtrl) h.input = p.root.input;
    h.palNo = p.palNo;
    h.superMoveTime = prm.int(p, 'supermovetime') ?? 0;
    h.pauseMoveTime = prm.int(p, 'pausemovetime') ?? 0;
    h.screenBound = false;
    h.moveCamera = [false, false];
    h.life = p.root.const('data.life');
    h.ctrl = false;

    const off: [number, number] = [prm.num(p, 'pos', 0) ?? 0, prm.num(p, 'pos', 1) ?? 0];
    const facingParam = (prm.int(p, 'facing') ?? 1) < 0 ? -1 : 1;
    const postype = (prm.raw('postype') ?? 'p1').toLowerCase();
    // Screen edges in the helper's (= parent's) units.
    const left = (w.camera.x - w.screenWidth / 2) / p.scale;
    const right = (w.camera.x + w.screenWidth / 2) / p.scale;
    h.pos.y = p.pos.y + off[1];
    switch (postype) {
      case 'p2': {
        const e = w.enemyOf(p) ?? p;
        h.pos.x = e.wx / p.scale + off[0] * e.facing;
        h.pos.y = e.wy / p.scale + off[1];
        h.facing = facingParam * e.facing;
        break;
      }
      case 'front':
        h.pos.x = (p.facing > 0 ? right : left) + off[0] * p.facing;
        h.facing = facingParam * p.facing;
        break;
      case 'back':
        h.pos.x = (p.facing > 0 ? left : right) + off[0] * p.facing;
        h.facing = facingParam * p.facing;
        break;
      case 'left':
        h.pos.x = left + off[0];
        h.facing = facingParam;
        break;
      case 'right':
        h.pos.x = right + off[0];
        h.facing = facingParam;
        break;
      default:
        h.pos.x = p.pos.x + off[0] * p.facing;
        h.facing = facingParam * p.facing;
    }
    w.addHelper(h);
    h.changeState(prm.int(p, 'stateno') ?? 0);
  };
}

export function compileDestroySelf(): (p: P) => void {
  return (p) => {
    if (p.isHelper) p.destroyed = true;
  };
}

/** ParentVarSet / ParentVarAdd: like VarSet on the parent. */
export function compileParentVar(c: ControllerDef, env: TriggerEnv<P>, add: boolean): (p: P) => void {
  const op = varTarget(c, env, false);
  if (!op) return () => {};
  return (p) => {
    const parent = p.parent;
    if (!parent) return;
    let i = op.index(p);
    if (R.t === BOTTOM) return;
    i = toInt(i);
    const val = op.value(p);
    if ((R.t as number) === BOTTOM) return;
    const arr = op.kind === 'var' ? parent.vars : op.kind === 'fvar' ? parent.fvars : op.kind === 'sysvar' ? parent.sysVars : parent.sysFvars;
    if (i < 0 || i >= arr.length) return;
    const n = arr instanceof Float32Array ? val : R.t === 1 ? toInt(val) : val;
    arr[i] = add ? arr[i]! + n : n;
  };
}

/** BindToParent / BindToRoot. */
export function compileBindTo(c: ControllerDef, env: TriggerEnv<P>, toRoot: boolean): (p: P) => void {
  const prm = paramFns(c, env);
  return (p) => {
    const to = toRoot ? p.root : p.parent;
    if (!to || to === p) return;
    const off: [number, number] = [prm.num(p, 'pos', 0) ?? 0, prm.num(p, 'pos', 1) ?? 0];
    const facing = prm.int(p, 'facing') ?? 0;
    if (facing) p.facing = facing > 0 ? to.facing : -to.facing;
    p.bind = { to, offset: [off[0] * to.facing * p.scale, off[1] * p.scale], time: prm.int(p, 'time') ?? 1 };
  };
}
