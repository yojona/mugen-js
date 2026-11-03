// Compiles expression ASTs into closures.
//
// Values are plain JS numbers; the type of the last evaluated value is kept in
// the shared register `R.t` (int / float / bottom) so evaluation never
// allocates. Semantics follow cns.html "Expressions":
//  - ints are 32-bit two's complement, floats are IEEE single precision;
//  - mixed int/float operands promote to float;
//  - bottom propagates through everything except the unused branch of
//    IfElse/Cond; condition-type triggers read bottom as 0.

import { parseExpr, parseExprList, type CallNode, type ClauseNode, type Node, type RelOp } from './parser';

export const INT = 0;
export const FLOAT = 1;
export const BOTTOM = 2;
export type Ty = typeof INT | typeof FLOAT | typeof BOTTOM;

/** Type register of the most recent evaluation. */
export const R: { t: Ty; from?: unknown } = { t: INT };

export type Fn<C> = (c: C) => number;

export const INT_MAX = 2147483647;
export const INT_MIN = -2147483648;
const f32 = Math.fround;

/** C-style float -> int32 conversion (truncation; x86 yields INT_MIN when out of range). */
export function toInt(v: number): number {
  if (!Number.isFinite(v) || v >= 2147483648 || v <= -2147483649) return INT_MIN;
  return Math.trunc(v) | 0;
}

export type VarKind = 'var' | 'fvar' | 'sysvar' | 'sysfvar';

/** What the engine provides to the compiler (function-type triggers, redirects, variables). */
export interface TriggerEnv<C> {
  /** Compile a regular trigger; return undefined if the name is unknown. Must set R.t. */
  call(node: CallNode, args: Fn<C>[]): Fn<C> | undefined;
  /** Compile an old-style clause (animelem, command, statetype...). Result is a boolean int. */
  clause(node: ClauseNode, nums: Fn<C>[]): Fn<C> | undefined;
  /** Resolve a redirection target; undefined -> bottom. */
  redirect(c: C, to: string, id: number | undefined): C | undefined;
  getVar(c: C, kind: VarKind, index: number): number;
  /** Returns false if the index is out of range (-> bottom). */
  setVar(c: C, kind: VarKind, index: number, value: number): boolean;
  /** Warnings (MUGEN prints these to its debug console). */
  warn?(msg: string): void;
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

export function compileExpr<C>(src: string, env: TriggerEnv<C>): Fn<C> {
  return compileNode(parseExpr(src), env);
}

export function compileExprList<C>(src: string, env: TriggerEnv<C>): Fn<C>[] {
  return parseExprList(src).map((n) => compileNode(n, env));
}

/** Condition-type trigger: bottom counts as false. */
export function truthy<C>(fn: Fn<C>, c: C): boolean {
  const v = fn(c);
  return R.t !== BOTTOM && v !== 0;
}

const bottom = (): number => {
  R.t = BOTTOM;
  return 0;
};

export function compileNode<C>(n: Node, env: TriggerEnv<C>): Fn<C> {
  switch (n.kind) {
    case 'num': {
      if (n.isFloat) {
        const v = f32(n.value);
        return () => ((R.t = FLOAT), v);
      }
      const v = n.value | 0;
      return () => ((R.t = INT), v);
    }
    case 'unary':
      return unary(n.op, compileNode(n.arg, env));
    case 'binary':
      return binary(n.op, compileNode(n.l, env), compileNode(n.r, env));
    case 'interval':
      return interval(n.negate, compileNode(n.x, env), compileNode(n.lo, env), compileNode(n.hi, env), n.loOpen, n.hiOpen);
    case 'assign':
      return assign(n.target, compileNode(n.value, env), env);
    case 'redirect': {
      const inner = compileNode(n.expr, env);
      const id = n.id ? compileNode(n.id, env) : null;
      const to = n.to;
      return (c) => {
        let idv: number | undefined;
        if (id) {
          idv = id(c);
          if (R.t === BOTTOM) return 0;
          if (R.t === FLOAT) idv = toInt(idv);
        }
        const target = env.redirect(c, to, idv);
        if (target === undefined) return bottom();
        // R.from: the player evaluating the whole expression (some triggers
        // are resolved against its tables, e.g. command names).
        const prev = R.from;
        if (prev === undefined) R.from = c;
        try {
          return inner(target);
        } finally {
          R.from = prev;
        }
      };
    }
    case 'call': {
      const args = n.args.map((a) => compileNode(a, env));
      const vk = n.name as VarKind;
      if (vk === 'var' || vk === 'fvar' || vk === 'sysvar' || vk === 'sysfvar') {
        if (args.length !== 1) throw new CompileError(`${n.name} necesita 1 argumento`);
        const idx = args[0]!;
        return (c) => {
          let i = idx(c);
          if (R.t === BOTTOM) return 0;
          if (R.t === FLOAT) i = toInt(i);
          return env.getVar(c, vk, i);
        };
      }
      const m = mathTrigger(n, args);
      if (m) return m;
      const fn = env.call(n, args);
      if (!fn) throw new CompileError(`Trigger desconocido: ${n.name}${n.axis ? ' ' + n.axis : ''}`);
      return fn;
    }
    case 'clause': {
      const fn = env.clause(
        n,
        n.nums.map((a) => compileNode(a, env)),
      );
      if (!fn) throw new CompileError(`Trigger desconocido: ${n.name}`);
      if (n.second && n.name !== 'animelem' && n.name !== 'projcontact' && n.name !== 'projguarded' && n.name !== 'projhit') {
        throw new CompileError(`${n.name} no admite segunda comparación`);
      }
      return fn;
    }
  }
}

// ---------------------------------------------------------------------------
// Operators

function unary<C>(op: '!' | '~' | '-', a: Fn<C>): Fn<C> {
  switch (op) {
    // A bottom operand counts as the int it carries (Expr_Eval).
    case '!':
      return (c) => {
        const v = a(c);
        const t = R.t;
        R.t = INT;
        return (t === BOTTOM ? v | 0 : v) === 0 ? 1 : 0;
      };
    case '~':
      return (c) => {
        const v = a(c);
        if (R.t === FLOAT) return bottom();
        R.t = INT;
        return ~v;
      };
    case '-':
      return (c) => {
        const v = a(c);
        if (R.t === FLOAT) return f32(-v);
        R.t = INT;
        return -v | 0;
      };
  }
}

/**
 * Evaluate both operands. mugen.exe's postfix evaluator (Expr_Eval) does not
 * propagate bottom through operators: a bottom operand is read as the int it
 * carries (0), and the result is an ordinary value. Always true.
 */
function both<C>(a: Fn<C>, b: Fn<C>, c: C, out: { x: number; y: number; float: boolean }): boolean {
  out.x = a(c);
  const ta = R.t;
  out.y = b(c);
  const tb = R.t;
  if (ta === BOTTOM) out.x |= 0;
  if (tb === BOTTOM) out.y |= 0;
  out.float = ta === FLOAT || tb === FLOAT;
  return true;
}

function binary<C>(op: string, a: Fn<C>, b: Fn<C>): Fn<C> {
  const o = { x: 0, y: 0, float: false };
  switch (op) {
    case '+':
      return (c) => (!both(a, b, c, o) ? 0 : o.float ? ((R.t = FLOAT), f32(o.x + o.y)) : ((R.t = INT), (o.x + o.y) | 0));
    case '-':
      return (c) => (!both(a, b, c, o) ? 0 : o.float ? ((R.t = FLOAT), f32(o.x - o.y)) : ((R.t = INT), (o.x - o.y) | 0));
    case '*':
      return (c) => (!both(a, b, c, o) ? 0 : o.float ? ((R.t = FLOAT), f32(o.x * o.y)) : ((R.t = INT), Math.imul(o.x, o.y)));
    case '/':
      return (c) => {
        if (!both(a, b, c, o)) return 0;
        if (o.y === 0) return bottom();
        if (o.float) return (R.t = FLOAT), f32(o.x / o.y);
        R.t = INT;
        return Math.trunc(o.x / o.y) | 0;
      };
    case '%':
      return (c) => {
        if (!both(a, b, c, o)) return 0;
        if (o.float || o.y === 0) return bottom();
        R.t = INT;
        return o.x % o.y | 0;
      };
    case '**':
      return (c) => {
        if (!both(a, b, c, o)) return 0;
        if (!o.float && o.x >= 0 && o.y >= 0) {
          R.t = INT;
          const p = Math.pow(o.x, o.y);
          return p > INT_MAX ? INT_MAX : p;
        }
        const p = Math.pow(o.x, o.y);
        if (Number.isNaN(p)) return bottom();
        R.t = FLOAT;
        return f32(p);
      };
    case '=':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const cmp = relFn(op as RelOp);
      return (c) => {
        if (!both(a, b, c, o)) return 0;
        R.t = INT;
        return o.float ? (cmp(f32(o.x), f32(o.y)) ? 1 : 0) : cmp(o.x, o.y) ? 1 : 0;
      };
    }
    case '&&':
      return (c) => (!both(a, b, c, o) ? 0 : ((R.t = INT), o.x !== 0 && o.y !== 0 ? 1 : 0));
    case '||':
      return (c) => (!both(a, b, c, o) ? 0 : ((R.t = INT), o.x !== 0 || o.y !== 0 ? 1 : 0));
    case '^^':
      return (c) => (!both(a, b, c, o) ? 0 : ((R.t = INT), (o.x !== 0) !== (o.y !== 0) ? 1 : 0));
    case '&':
      return (c) => (!both(a, b, c, o) ? 0 : o.float ? bottom() : ((R.t = INT), o.x & o.y));
    case '|':
      return (c) => (!both(a, b, c, o) ? 0 : o.float ? bottom() : ((R.t = INT), o.x | o.y));
    case '^':
      return (c) => (!both(a, b, c, o) ? 0 : o.float ? bottom() : ((R.t = INT), o.x ^ o.y));
  }
  throw new CompileError(`Operador desconocido ${op}`);
}

export function relFn(op: RelOp): (x: number, y: number) => boolean {
  switch (op) {
    case '=':
      return (x, y) => x === y;
    case '!=':
      return (x, y) => x !== y;
    case '<':
      return (x, y) => x < y;
    case '<=':
      return (x, y) => x <= y;
    case '>':
      return (x, y) => x > y;
    case '>=':
      return (x, y) => x >= y;
  }
}

function interval<C>(negate: boolean, x: Fn<C>, lo: Fn<C>, hi: Fn<C>, loOpen: boolean, hiOpen: boolean): Fn<C> {
  return (c) => {
    let xv = x(c);
    const tx = R.t;
    let l = lo(c);
    const tl = R.t;
    let h = hi(c);
    const th = R.t;
    // Only a bottom x makes the interval bottom (Expr_Eval); bounds count as ints.
    if (tx === BOTTOM) return bottom();
    if (tl === BOTTOM) l |= 0;
    if (th === BOTTOM) h |= 0;
    if (tx === FLOAT || tl === FLOAT || th === FLOAT) {
      xv = f32(xv);
      l = f32(l);
      h = f32(h);
    }
    const inside = (loOpen ? xv > l : xv >= l) && (hiOpen ? xv < h : xv <= h);
    R.t = INT;
    return inside !== negate ? 1 : 0;
  };
}

function assign<C>(target: CallNode, value: Fn<C>, env: TriggerEnv<C>): Fn<C> {
  const kind = target.name as VarKind;
  const idx = target.args[0] ? compileNode(target.args[0], env) : null;
  if (!idx || target.args.length !== 1) throw new CompileError(`${kind} necesita 1 argumento`);
  const isFloatVar = kind === 'fvar' || kind === 'sysfvar';
  return (c) => {
    // Bottom index or value: read as the int it carries (Expr_Eval).
    let i = idx(c);
    if (R.t === FLOAT) i = toInt(i);
    else i |= 0;
    let v = value(c);
    if ((R.t as Ty) === BOTTOM) v |= 0;
    if (isFloatVar) v = f32(v);
    else if (R.t === FLOAT) v = toInt(v);
    if (!env.setVar(c, kind, i, v)) return bottom();
    R.t = isFloatVar ? FLOAT : INT;
    return v;
  };
}

// ---------------------------------------------------------------------------
// Math triggers (trigger.html, marked "(math)")

function floatFn<C>(a: Fn<C>, f: (x: number) => number, valid: (x: number) => boolean = () => true): Fn<C> {
  return (c) => {
    const x = a(c);
    if (R.t === BOTTOM) return 0;
    if (!valid(x)) return bottom();
    const r = f(x);
    if (Number.isNaN(r)) return bottom();
    R.t = FLOAT;
    return f32(r);
  };
}

function mathTrigger<C>(n: CallNode, args: Fn<C>[]): Fn<C> | undefined {
  const arity = (k: number) => {
    if (args.length !== k) throw new CompileError(`${n.name} necesita ${k} argumento(s)`);
  };
  const a = args[0]!;
  switch (n.name) {
    case 'e':
      arity(0);
      return () => ((R.t = FLOAT), f32(Math.E));
    case 'pi':
      arity(0);
      return () => ((R.t = FLOAT), f32(Math.PI));
    case 'abs':
      arity(1);
      return (c) => {
        const x = a(c);
        if (R.t === INT) return Math.abs(x) | 0;
        if (R.t === FLOAT) return f32(Math.abs(x));
        return 0;
      };
    case 'floor':
    case 'ceil': {
      arity(1);
      const f = n.name === 'floor' ? Math.floor : Math.ceil;
      return (c) => {
        const x = a(c);
        if (R.t === BOTTOM) return 0;
        if (R.t === FLOAT) {
          R.t = INT;
          return toInt(f(x));
        }
        return x;
      };
    }
    case 'sin':
      arity(1);
      return floatFn(a, Math.sin);
    case 'cos':
      arity(1);
      return floatFn(a, Math.cos);
    case 'tan':
      arity(1);
      return floatFn(a, Math.tan);
    case 'asin':
      arity(1);
      return floatFn(a, Math.asin, (x) => x >= -1 && x <= 1);
    case 'acos':
      arity(1);
      return floatFn(a, Math.acos, (x) => x >= -1 && x <= 1);
    case 'atan':
      arity(1);
      return floatFn(a, Math.atan);
    case 'exp':
      arity(1);
      return floatFn(a, Math.exp);
    case 'ln':
      arity(1);
      return floatFn(a, Math.log, (x) => x > 0);
    case 'log': {
      arity(2);
      const b = args[1]!;
      return (c) => {
        const base = a(c);
        const tb = R.t;
        const x = b(c);
        if (tb === BOTTOM || R.t === BOTTOM) return bottom();
        if (base <= 0 || x <= 0 || base === 1) return bottom();
        R.t = FLOAT;
        return f32(Math.log(x) / Math.log(base));
      };
    }
    case 'ifelse': {
      // All three arguments are evaluated; bottom in the unused one is dropped.
      arity(3);
      const [cond, t, f] = args as [Fn<C>, Fn<C>, Fn<C>];
      return (c) => {
        const cv = cond(c);
        if (R.t === BOTTOM) {
          t(c);
          f(c);
          return bottom();
        }
        const tv = t(c);
        const tt = R.t;
        const fv = f(c);
        const ft = R.t;
        if (cv !== 0) {
          R.t = tt;
          return tv;
        }
        R.t = ft;
        return fv;
      };
    }
    case 'cond': {
      // Only the selected branch is evaluated.
      arity(3);
      const [cond, t, f] = args as [Fn<C>, Fn<C>, Fn<C>];
      return (c) => {
        const cv = cond(c);
        if (R.t === BOTTOM) return 0;
        return cv !== 0 ? t(c) : f(c);
      };
    }
  }
  return undefined;
}
