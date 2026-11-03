import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOTTOM, FLOAT, INT, R, compileExpr, truthy, type TriggerEnv } from '../src/expr/compile';
import { parseExpr } from '../src/expr/parser';
import { parseIni } from '../src/formats/text';

interface Mock {
  time: number;
  vars: number[];
  fvars: number[];
  parent?: Mock;
  helpers: Map<number, Mock>;
  stateType: string;
  commands: Set<string>;
}

const mock = (over: Partial<Mock> = {}): Mock => ({
  time: 0,
  vars: new Array(60).fill(0),
  fvars: new Array(40).fill(0),
  helpers: new Map(),
  stateType: 's',
  commands: new Set(),
  ...over,
});

const env: TriggerEnv<Mock> = {
  call(node) {
    if (node.name === 'time') return (c) => ((R.t = INT), c.time);
    if (node.name === 'pos' && node.axis) return () => ((R.t = FLOAT), 1.5);
    return undefined;
  },
  clause(node) {
    const eq = node.op === '=';
    if (node.name === 'statetype') return (c) => ((R.t = INT), (c.stateType === node.words[0]) === eq ? 1 : 0);
    if (node.name === 'command') return (c) => ((R.t = INT), c.commands.has(node.words[0]!) === eq ? 1 : 0);
    return undefined;
  },
  redirect(c, to, id) {
    if (to === 'parent') return c.parent;
    if (to === 'helper') return id === undefined ? c.helpers.values().next().value : c.helpers.get(id);
    return undefined;
  },
  getVar(c, kind, i) {
    const arr = kind === 'fvar' ? c.fvars : c.vars;
    if (i < 0 || i >= arr.length) {
      R.t = BOTTOM;
      return 0;
    }
    R.t = kind === 'fvar' ? FLOAT : INT;
    return arr[i]!;
  },
  setVar(c, kind, i, v) {
    const arr = kind === 'fvar' ? c.fvars : c.vars;
    if (i < 0 || i >= arr.length) return false;
    arr[i] = v;
    return true;
  },
};

function ev(src: string, c: Mock = mock()): { v: number; t: number } {
  const v = compileExpr(src, env)(c);
  return { v, t: R.t };
}
const I = (v: number) => ({ v, t: INT });
const F = (v: number) => ({ v: Math.fround(v), t: FLOAT });
const B = { v: 0, t: BOTTOM };

describe('arithmetic (cns.html examples)', () => {
  it('types and promotion', () => {
    expect(ev('7')).toEqual(I(7));
    expect(ev('7.0')).toEqual(F(7));
    expect(ev('7/2')).toEqual(I(3));
    expect(ev('7.0/2.0')).toEqual(F(3.5));
    expect(ev('-7/2')).toEqual(I(-3));
    expect(ev('-7%3')).toEqual(I(-1));
    expect(ev('5.0*5/6')).toEqual(F(25 / 6));
    expect(ev('5/6*5.0')).toEqual(F(0));
    expect(ev('3+2*5')).toEqual(I(13));
    expect(ev('(3+2)*5')).toEqual(I(25));
    expect(ev('-!0')).toEqual(I(-1));
  });
  it('int overflow wraps at 32 bits', () => {
    expect(ev('2147483647 + 1')).toEqual(I(-2147483648));
    expect(ev('65536 * 65536')).toEqual(I(0));
    expect(ev('-2147483648')).toEqual(I(-2147483648));
  });
  it('exponentiation', () => {
    expect(ev('2**10')).toEqual(I(1024));
    expect(ev('0**0')).toEqual(I(1));
    expect(ev('2**40')).toEqual(I(2147483647));
    expect(ev('2**-1')).toEqual(F(0.5));
    expect(ev('-1 ** .5')).toEqual(B);
  });
  it('bottom', () => {
    expect(ev('1/0')).toEqual(B);
    // mugen.exe does not propagate bottom through operators: a bottom
    // operand reads as 0 and the result is an ordinary value (Expr_Eval).
    expect(ev('5 + 1/0')).toEqual(I(5));
    expect(ev('!(1/0)')).toEqual(I(1));
    expect(ev('5.0 % 2')).toEqual(B);
    expect(ev('1.5 & 1')).toEqual(B);
    expect(ev('0 && 1/0')).toEqual(I(0));
    expect(truthy(compileExpr('1/0', env), mock())).toBe(false);
  });
  it('logic and comparisons', () => {
    // cns.html claims this is 1, but its own walkthrough misreads 0 < 1 as 0.
    expect(ev('1.0 = (2 = (1 > 0) + !(0 < 1))')).toEqual(I(0));
    expect(ev('1.0 = (2 = (1 > 0) + !(1 < 0))')).toEqual(I(1));
    expect(ev('3 ^^ 0')).toEqual(I(1));
    expect(ev('3 ^^ 4')).toEqual(I(0));
    expect(ev('6 & 3 | 8')).toEqual(I(10));
    expect(ev('~0')).toEqual(I(-1));
    expect(ev('1 = 1.0')).toEqual(I(1));
    expect(ev('0.1 = 0.1')).toEqual(I(1));
  });
});

describe('intervals', () => {
  it('closed / open / negated', () => {
    expect(ev('1 = [0,2]')).toEqual(I(1));
    expect(ev('(1 = [0,2]) = (0,1)')).toEqual(I(0));
    expect(ev('2 = [0,2)')).toEqual(I(0));
    expect(ev('2 != [0,2)')).toEqual(I(1));
    expect(ev('0 = (0,2]')).toEqual(I(0));
    expect(ev('1.5 = [1,2]')).toEqual(I(1));
    expect(ev('time = [3, 5]', mock({ time: 4 }))).toEqual(I(1));
    expect(ev('time = (1+2)', mock({ time: 3 }))).toEqual(I(1));
  });
});

describe('variables and assignment', () => {
  it('assigns with truncation and returns value', () => {
    const c = mock();
    expect(ev('var(3) := 7.9', c)).toEqual(I(7));
    expect(c.vars[3]).toBe(7);
    expect(ev('fvar(1) := 2', c)).toEqual(F(2));
    expect(ev('var(1) := var(2) := 5', c)).toEqual(I(5));
    expect(c.vars[1]).toBe(5);
    expect(ev('var(99)', c)).toEqual(B);
    expect(ev('var(1.9)', c)).toEqual(I(5));
  });
  it('rejects non-variable assignment', () => {
    expect(() => parseExpr('time := 3')).toThrow();
  });
});

describe('math triggers', () => {
  it('ifelse / cond bottom isolation', () => {
    expect(ev('ifelse(time > 0, 1.0/time, 2)')).toEqual(I(2));
    expect(ev('cond(time > 0, 1.0/time, 2)', mock({ time: 4 }))).toEqual(F(0.25));
    const c = mock();
    ev('ifelse(1, 0, var(5) := 9)', c);
    expect(c.vars[5]).toBe(9);
    ev('cond(1, 0, var(6) := 9)', c);
    expect(c.vars[6]).toBe(0);
  });
  it('functions', () => {
    expect(ev('floor(2.7)')).toEqual(I(2));
    expect(ev('ceil(-2.7)')).toEqual(I(-2));
    expect(ev('abs(-3)')).toEqual(I(3));
    expect(ev('ln(0)')).toEqual(B);
    expect(ev('log(2, 8)')).toEqual(F(3));
    expect(ev('acos(2)')).toEqual(B);
    expect(ev('pi')).toEqual(F(Math.PI));
  });
});

describe('redirection and clauses', () => {
  it('redirects to parent / helper', () => {
    const parent = mock({ time: 50 });
    const c = mock({ time: 1, parent });
    expect(ev('parent, time', c)).toEqual(I(50));
    expect(ev('5 + (parent, time)', c)).toEqual(I(55));
    // mugen.exe binds a redirection to the one trigger after it.
    expect(ev('parent, time + time', c)).toEqual(I(51));
    expect(ev('helper(3), time', c)).toEqual(B);
    c.helpers.set(3, mock({ time: 9 }));
    expect(ev('helper(3), time', c)).toEqual(I(9));
    expect(ev('time = (helper(3), time, 2)', c)).toEqual(I(0));
  });
  it('old-style clauses', () => {
    const c = mock({ stateType: 'a', commands: new Set(['fwd']) });
    expect(ev('statetype = A', c)).toEqual(I(1));
    expect(ev('statetype != A', c)).toEqual(I(0));
    expect(ev('command = "fwd" && statetype = A', c)).toEqual(I(1));
    expect(ev('command != "x"', c)).toEqual(I(1));
    expect(ev('pos x + 1', c)).toEqual(F(2.5));
  });
  it('animelem / timemod / hitdefattr shapes', () => {
    const a = parseExpr('animelem = 2, >= 3');
    expect(a).toMatchObject({ kind: 'clause', name: 'animelem', op: '=', second: { op: '>=' } });
    expect(parseExpr('timemod = 4, 2')).toMatchObject({ kind: 'clause', name: 'timemod' });
    expect(parseExpr('hitdefattr = SCA, NA, SA')).toMatchObject({ bits: 7 | 0x08 | 0x10 });
    expect(parseExpr('projhit1234 = 1, < 5')).toMatchObject({ name: 'projhit', id: 1234 });
    expect(parseExpr('animelem = 3, -1')).toMatchObject({ second: { op: '=' } });
    expect(parseExpr('animelem = 5 + 4')).toMatchObject({ kind: 'binary', op: '+' });
  });
});

describe('real character files', () => {
  const REF = join(__dirname, '..', 'ref', 'mugen-1.1b1');
  const files = ['chars/kfm/kfm.cns', 'chars/kfm/kfm.cmd', 'data/common1.cns', 'chars/kfm720/kfm720.cns'];
  for (const f of files) {
    it(`parses every trigger in ${f}`, () => {
      const doc = parseIni(readFileSync(join(REF, f), 'latin1'));
      let count = 0;
      const errors: string[] = [];
      for (const s of doc.sections) {
        for (const e of s.entries) {
          if (!/^trigger(all|\d+)$/.test(e.key)) continue;
          count++;
          try {
            parseExpr(e.value);
          } catch (err) {
            errors.push(`${f}:${e.line}: ${(err as Error).message}`);
          }
        }
      }
      expect(errors).toEqual([]);
      expect(count).toBeGreaterThan(10);
    });
  }
});
