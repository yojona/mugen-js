// MUGEN 1.1's own expression parser, reimplemented from mugen.exe:
// Expr_Parse (0x4019D0, a shunting-yard over the raw text), Trigger_Parse
// (0x4538C0: redirection, name lookup, arguments and the triggers that
// compare by themselves), Trigger_ParseCompare (0x455E60) and
// HitDefAttr_Parse (0x459AB0). It replaces the grammar of the Elecbyte docs:
// mugen.exe binds a redirection ("parent, var(1)") to the one trigger that
// follows, wherever it stands, and reads unusual text the way it does (e.g.
// "HitOver!" is !HitOver). The output is the AST the compiler consumes.

import { ExprError } from './lexer';
import type { CallNode, ClauseNode, Node, RelOp } from './parser';

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isAlpha = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c);
const isAlnum = (c: string | undefined) => isDigit(c) || isAlpha(c);
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';

// Operators: '-' read as 'neg' where an operand is expected.
type Op = '||' | '^^' | '&&' | '|' | '^' | '&' | ':=' | '=' | '!=' | '>' | '<' | '>=' | '<=' | '+' | '-' | '*' | '/' | '%' | '**' | '!' | '~' | 'neg' | '(' | 'in_oo' | 'in_oc' | 'in_co' | 'in_cc';

const PREC: Record<string, number> = {
  '||': 1, '^^': 2, '&&': 3, '|': 4, '^': 5, '&': 6, ':=': 7, '=': 8, '!=': 8,
  in_oo: 9, in_oc: 9, in_co: 9, in_cc: 9, '>': 10, '<': 10, '>=': 10, '<=': 10,
  '+': 11, '-': 11, '*': 12, '/': 12, '%': 12, '**': 13, '!': 14, neg: 14, '~': 14, '(': 15,
};
const RIGHT = new Set<string>([':=', '!', '~', 'neg']);
const UNARY = new Set<string>(['!', '~', 'neg']);

/** Expr_ReadOp (0x401840): the operator at i and its length, or undefined. */
function readOp(s: string, i: number): [Op, number] | undefined {
  const c = s[i];
  const n = s[i + 1];
  switch (c) {
    case '!': return n === '=' ? ['!=', 2] : ['!', 1];
    case '%': return ['%', 1];
    case '&': return n === '&' ? ['&&', 2] : ['&', 1];
    case '*': return n === '*' ? ['**', 2] : ['*', 1];
    case '+': return ['+', 1];
    case '-': return ['-', 1];
    case '/': return ['/', 1];
    case ':': return n === '=' ? [':=', 2] : undefined;
    case '<': return n === '=' ? ['<=', 2] : ['<', 1];
    case '=': return ['=', 1];
    case '>': return n === '=' ? ['>=', 2] : ['>', 1];
    case '^': return n === '^' ? ['^^', 2] : ['^', 1];
    case '|': return n === '|' ? ['||', 2] : ['|', 1];
    case '~': return ['~', 1];
  }
  return undefined;
}

type Item = { kind: 'node'; node: Node } | { kind: 'op'; op: Op };

class Fail extends Error {}

/**
 * Expr_Parse. With `stop`, parsing ends at a ',' or a closing bracket (the
 * returned end points at it); without, a closing bracket is an error and the
 * whole text must be read.
 */
export function parseAt(s: string, start: number, stop: boolean): { node: Node; end: number } {
  const out: Item[] = [];
  const ops: Op[] = [];
  let cur = start;
  let last: 'none' | 'number' | 'op' | 'interval' | 'trigger' | 'group' = 'none';
  let topPrec = 0;
  const fail = (msg = 'Expresión mal formada'): never => {
    throw new Fail(msg);
  };
  const pushOp = (op: Op) => {
    const right = RIGHT.has(op);
    let prec = topPrec;
    const opPrec = PREC[op]!;
    while (ops.length && !(right ? opPrec >= prec : opPrec > prec)) {
      out.push({ kind: 'op', op: ops.pop()! });
      prec = ops.length ? PREC[ops[ops.length - 1]!]! : 0;
    }
    ops.push(op);
    topPrec = opPrec;
  };
  if (cur >= s.length) fail();
  for (;;) {
    if (stop && s[cur] === ',') break;
    const c = s[cur];
    const c1 = s[cur + 1];
    const startsNumber = isDigit(c) || (c === '-' && isDigit(c1)) || (c === '.' && isDigit(c1)) || (c === '-' && c1 === '.' && isDigit(s[cur + 2]));
    if (startsNumber && last !== 'number' && last !== 'trigger' && last !== 'group') {
      last = 'number';
      const m = /^-?\d*/.exec(s.slice(cur))![0];
      let end = cur + m.length;
      if (s[end] === '.' || (c === '-' && c1 === '.')) {
        const f = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(s.slice(cur))![0];
        out.push({ kind: 'node', node: { kind: 'num', value: Math.fround(parseFloat(f)), isFloat: true } });
        end = cur + f.length;
      } else {
        out.push({ kind: 'node', node: { kind: 'num', value: clampInt(parseInt(m, 10)), isFloat: false } });
      }
      cur = end;
    } else {
      const r = readOp(s, cur);
      if (r && c !== '(' && c !== '[' && c !== ')' && c !== ']') {
        let [op, len] = r;
        if (op === '-' && (last === 'none' || last === 'op')) op = 'neg';
        // Only unary operators may follow an operator ('~' included, as the original tests the character).
        if (last === 'op' && !UNARY.has(op)) fail();
        if (op === ':=') {
          // var(n) := x / fvar(n) := x: the left side must be an unredirected var/fvar.
          const prev = out[out.length - 1];
          const ok = last === 'trigger' && prev?.kind === 'node' && prev.node.kind === 'call' && (prev.node.name === 'var' || prev.node.name === 'fvar');
          if (!ok) fail('El lado izquierdo de := debe ser var/fvar');
          if (PREC[':=']! < topPrec) {
            const top = ops[ops.length - 1];
            if (top !== '(' && top !== ':=') fail();
          }
        }
        last = 'op';
        pushOp(op);
        cur += len;
      } else if (c === '[') {
        // "= [a, b]" / "= [a, b)"
        const top = ops[ops.length - 1];
        if (last !== 'op' || (top !== '=' && top !== '!=')) fail();
        const a = parseAt(s, cur + 1, true);
        if (s[a.end] !== ',') fail();
        const b = parseAt(s, a.end + 1, true);
        const close = s[b.end];
        if (close !== ')' && close !== ']') fail();
        let p = b.end + 1;
        while (isSpace(s[p])) p++;
        if (p < s.length && s[p] !== ')') fail();
        interval(close === ']' ? 'in_cc' : 'in_co', a.node, b.node, b.end);
      } else if (c === '(') {
        if (last === 'number') fail();
        const a = parseAt(s, cur + 1, true);
        if (s[a.end] !== ',') {
          if (s[a.end] !== ')') fail();
          out.push({ kind: 'node', node: a.node });
          last = 'group';
          cur = a.end + 1;
        } else {
          // "= (a, b)" / "= (a, b]"
          const b = parseAt(s, a.end + 1, true);
          const close = s[b.end];
          if (close !== ')' && close !== ']') fail();
          let p = b.end + 1;
          while (isSpace(s[p])) p++;
          if (p < s.length && s[p] !== ')') fail();
          const top = ops[ops.length - 1];
          if (last === 'none' || last === 'group' || (top !== '=' && top !== '!=')) fail();
          interval(close === ')' ? 'in_oo' : 'in_oc', a.node, b.node, b.end);
        }
      } else if (c === ')' || c === ']') {
        if (!stop) fail();
        break;
      } else if (isAlnum(c) || c === '_') {
        const t = parseTrigger(s, cur);
        out.push({ kind: 'node', node: t.node });
        last = 'trigger';
        cur = t.end;
      } else if (isSpace(c)) {
        cur++;
      } else fail(`Texto inesperado "${c}"`);
    }
    if (cur >= s.length) break;
  }
  while (ops.length) out.push({ kind: 'op', op: ops.pop()! });
  return { node: build(out), end: cur };

  function interval(op: Op, lo: Node, hi: Node, closeAt: number) {
    last = 'interval';
    const prec = PREC[op]!;
    if (prec <= topPrec) {
      for (;;) {
        if (!ops.length) {
          topPrec = 0;
          break;
        }
        out.push({ kind: 'op', op: ops.pop()! });
        topPrec = ops.length ? PREC[ops[ops.length - 1]!]! : 0;
        if (prec > topPrec) break;
      }
    }
    out.push({ kind: 'node', node: lo }, { kind: 'node', node: hi }, { kind: 'op', op });
    cur = closeAt + 1;
  }
}

function clampInt(v: number): number {
  return Math.max(-2147483648, Math.min(2147483647, v));
}

/** Postfix to AST, with the stack-depth check of Expr_Parse. */
function build(items: Item[]): Node {
  const st: Node[] = [];
  const need = (n: number) => {
    if (st.length < n) throw new Fail('Expresión mal formada');
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === 'node') {
      st.push(it.node);
      continue;
    }
    const op = it.op;
    if (UNARY.has(op)) {
      need(1);
      st.push({ kind: 'unary', op: op === 'neg' ? '-' : (op as '!' | '~'), arg: st.pop()! });
    } else if (op.startsWith('in_')) {
      // x a b IN, then the = / != token.
      need(3);
      const hi = st.pop()!;
      const lo = st.pop()!;
      const x = st.pop()!;
      const eq = items[i + 1];
      const negate = eq?.kind === 'op' && eq.op === '!=';
      i++;
      st.push({ kind: 'interval', negate, x, lo, hi, loOpen: op === 'in_oo' || op === 'in_oc', hiOpen: op === 'in_oo' || op === 'in_co' });
    } else if (op === ':=') {
      need(2);
      const value = st.pop()!;
      const target = st.pop()! as CallNode;
      st.push({ kind: 'assign', target, value });
    } else if (op === '(') {
      throw new Fail('Expresión mal formada');
    } else {
      need(2);
      const r = st.pop()!;
      const l = st.pop()!;
      st.push({ kind: 'binary', op, l, r });
    }
  }
  if (st.length !== 1) throw new Fail('Expresión mal formada');
  return st[0]!;
}

// ---------------------------------------------------------------------------
// Triggers (Trigger_Parse)

type NameKind = 'exact' | 'prefix' | 'body';
/** mugen.exe's trigger name table, in the order it is searched (first match wins). */
const NAMES: [string, NameKind, string][] = [
  ['time', 'exact', 'time'], ['statetime', 'exact', 'time'], ['animtime', 'exact', 'animtime'], ['animelem', 'exact', 'animelem'],
  ['anim', 'exact', 'anim'], ['vel', 'exact', 'vel'], ['pos', 'exact', 'pos'], ['screenpos', 'exact', 'screenpos'],
  ['camerapos', 'exact', 'camerapos'], ['camerazoom', 'exact', 'camerazoom'], ['timemod', 'exact', 'timemod'], ['p2dist', 'exact', 'p2dist'],
  ['p2bodydist', 'exact', 'p2bodydist'], ['p2life', 'exact', 'p2life'], ['winperfect', 'exact', 'winperfect'], ['win', 'prefix', 'win'],
  ['lose', 'prefix', 'lose'], ['drawgame', 'exact', 'drawgame'], ['matchover', 'exact', 'matchover'], ['gametime', 'exact', 'gametime'],
  ['roundno', 'exact', 'roundno'], ['roundstate', 'exact', 'roundstate'], ['matchno', 'exact', 'matchno'], ['roundsexisted', 'exact', 'roundsexisted'],
  ['teamside', 'exact', 'teamside'], ['teammode', 'exact', 'teammode'], ['ishometeam', 'exact', 'ishometeam'], ['frontedgedist', 'exact', 'frontedgedist'],
  ['backedgedist', 'exact', 'backedgedist'], ['frontedgebodydist', 'body', 'frontedgebodydist'], ['backedgebodydist', 'body', 'backedgebodydist'],
  ['life', 'exact', 'life'], ['lifemax', 'exact', 'lifemax'], ['power', 'exact', 'power'], ['powermax', 'exact', 'powermax'], ['alive', 'exact', 'alive'],
  ['command', 'exact', 'command'], ['ailevel', 'exact', 'ailevel'], ['hitcount', 'exact', 'hitcount'], ['uniqhitcount', 'exact', 'uniqhitcount'],
  ['movehit', 'exact', 'movehit'], ['moveguarded', 'exact', 'moveguarded'], ['movecontact', 'exact', 'movecontact'], ['movereversed', 'exact', 'movereversed'],
  ['inguarddist', 'exact', 'inguarddist'], ['stateno', 'exact', 'stateno'], ['prevstateno', 'exact', 'prevstateno'], ['p2stateno', 'exact', 'p2stateno'],
  ['statetype', 'exact', 'statetype'], ['p2statetype', 'exact', 'p2statetype'], ['movetype', 'exact', 'movetype'], ['p2movetype', 'exact', 'p2movetype'],
  ['ctrl', 'exact', 'ctrl'], ['hitdefattr', 'exact', 'hitdefattr'], ['var', 'exact', 'var'], ['fvar', 'exact', 'fvar'], ['sysvar', 'exact', 'sysvar'],
  ['sysfvar', 'exact', 'sysfvar'], ['random', 'exact', 'random'], ['numproj', 'exact', 'numproj'], ['numprojid', 'exact', 'numprojid'],
  ['projcanceltime', 'exact', 'projcanceltime'], ['projhittime', 'exact', 'projhittime'], ['projhit', 'prefix', 'projhit'],
  ['projguardedtime', 'exact', 'projguardedtime'], ['projguarded', 'prefix', 'projguarded'], ['projcontacttime', 'exact', 'projcontacttime'],
  ['projcontact', 'prefix', 'projcontact'], ['p1name', 'exact', 'p1name'], ['name', 'exact', 'p1name'], ['p2name', 'exact', 'p2name'],
  ['p3name', 'exact', 'p3name'], ['p4name', 'exact', 'p4name'], ['authorname', 'exact', 'authorname'], ['numpartner', 'exact', 'numpartner'],
  ['numenemy', 'exact', 'numenemy'], ['id', 'exact', 'id'], ['facing', 'exact', 'facing'], ['hitfall', 'exact', 'hitfall'],
  ['hitshakeover', 'exact', 'hitshakeover'], ['hitover', 'exact', 'hitover'], ['hitvel', 'exact', 'hitvel'], ['hitpausetime', 'exact', 'hitpausetime'],
  ['canrecover', 'exact', 'canrecover'], ['animelemno', 'exact', 'animelemno'], ['animexist', 'exact', 'animexist'], ['selfanimexist', 'exact', 'selfanimexist'],
  ['playeridexist', 'exact', 'playeridexist'], ['palno', 'exact', 'palno'], ['numexplod', 'exact', 'numexplod'], ['numtarget', 'exact', 'numtarget'],
  ['gethitvar', 'exact', 'gethitvar'], ['const', 'exact', 'const'], ['const240p', 'exact', 'const240p'], ['const480p', 'exact', 'const480p'],
  ['const720p', 'exact', 'const720p'], ['stagevar', 'exact', 'stagevar'], ['tickspersecond', 'exact', 'tickspersecond'], ['ishelper', 'exact', 'ishelper'],
  ['numhelper', 'exact', 'numhelper'], ['parentdist', 'exact', 'parentdist'], ['rootdist', 'exact', 'rootdist'], ['standby', 'exact', 'standby'],
  ['gamewidth', 'exact', 'gamewidth'], ['gameheight', 'exact', 'gameheight'], ['screenwidth', 'exact', 'screenwidth'], ['screenheight', 'exact', 'screenheight'],
  ['backedge', 'exact', 'backedge'], ['frontedge', 'exact', 'frontedge'], ['leftedge', 'exact', 'leftedge'], ['rightedge', 'exact', 'rightedge'],
  ['topedge', 'exact', 'topedge'], ['bottomedge', 'exact', 'bottomedge'], ['pi', 'exact', 'pi'], ['e', 'exact', 'e'], ['ifelse', 'exact', 'ifelse'],
  ['log', 'exact', 'log'], ['sin', 'exact', 'sin'], ['cos', 'exact', 'cos'], ['tan', 'exact', 'tan'], ['asin', 'exact', 'asin'], ['acos', 'exact', 'acos'],
  ['atan', 'exact', 'atan'], ['exp', 'exact', 'exp'], ['ln', 'exact', 'ln'], ['abs', 'exact', 'abs'], ['floor', 'exact', 'floor'], ['ceil', 'exact', 'ceil'],
  ['animelemtime', 'exact', 'animelemtime'], ['cond', 'exact', 'cond'],
];

/** One-argument function triggers (ids 0x140-0x15F). */
const ONE_ARG = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'ln', 'abs', 'floor', 'ceil', 'animelemtime', 'animexist', 'selfanimexist', 'playeridexist', 'projhittime', 'projguardedtime', 'projcontacttime', 'numprojid', 'var', 'fvar', 'sysvar', 'sysfvar', 'projcanceltime', 'animelemno', 'const240p', 'const480p', 'const720p']);
/** Triggers whose (ID) is optional. */
const OPT_ARG = new Set(['ishelper', 'numhelper', 'numexplod', 'numtarget']);
const AXIS = new Set(['pos', 'screenpos', 'vel', 'p2dist', 'p2bodydist', 'camerapos', 'hitvel', 'parentdist', 'rootdist']);
const STRINGS = new Set(['p1name', 'p2name', 'p3name', 'p4name', 'authorname']);
const REDIRECTS = ['parent', 'root', 'helper', 'target', 'partner', 'enemy', 'enemynear', 'playerid'];

function readWord(s: string, i: number, withDot: boolean): [string, number] {
  let w = '';
  while (i < s.length && (isAlnum(s[i]) || s[i] === '_' || (withDot && s[i] === '.'))) w += s[i++];
  return [w, i];
}

function lookup(name: string): string | undefined {
  const n = name.toLowerCase();
  for (const [key, kind, id] of NAMES) {
    if (kind === 'prefix' ? n.startsWith(key) : n === key) return id;
  }
  return undefined;
}

/** Cns_ParseArgs: `count` comma-separated values up to the closing ')'. */
function parseArgs(s: string, i: number, count: number): { args: Node[]; end: number } {
  const args: Node[] = [];
  let cur = i;
  for (let k = 0; k < count; k++) {
    const r = parseAt(s, cur, true);
    args.push(r.node);
    if (s[r.end] === ',') {
      if (k < count - 1) {
        cur = r.end + 1;
        continue;
      }
    }
    cur = r.end;
    if (s[r.end] !== ',' && k < count - 1) throw new Fail('Faltan argumentos');
  }
  while (isSpace(s[cur])) cur++;
  if (s[cur] !== ')') throw new Fail('Se esperaba ")"');
  return { args, end: cur + 1 };
}

/** The "op" in front of a self-comparing trigger's value: '=' unless the char before '=' is '!'. */
function scanToValue(s: string, i: number): { op: RelOp; at: number } {
  let p = i;
  while (p < s.length && s[p] !== '=') p++;
  const op: RelOp = s[p - 1] === '!' ? '!=' : '=';
  if (p < s.length) p++;
  while (isSpace(s[p])) p++;
  return { op, at: p };
}

/** Trigger_ParseCompare (0x455E60) for animelem / timemod / projhit: undefined if nothing usable. */
function parseCompare(s: string, i: number): { second: NonNullable<ClauseNode['second']>; end: number } | undefined {
  if (i >= s.length) return undefined;
  let kind = s[i]!;
  const next = s[i + 1];
  if (isDigit(kind) || kind === '-') kind = '=';
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (isDigit(c) || c === '-') break;
    j++;
    if (kind === '=') {
      if (s[j] === '(') kind = '(';
      else if (s[j] === '[') kind = '[';
    }
  }
  if (j >= s.length) return undefined;
  const num = (at: number): [number, number] => {
    const m = /^[-+]?\d+/.exec(s.slice(at));
    return m ? [parseInt(m[0], 10), at + m[0].length] : [0, at];
  };
  let op: RelOp;
  switch (kind) {
    case '=': op = '='; break;
    case '!': if (next !== '=') return undefined; op = '!='; break;
    case '>': op = next === '=' ? '>=' : '>'; break;
    case '<': op = next === '=' ? '<=' : '<'; break;
    case '(':
    case '[': {
      const [lo] = num(j);
      let k = j;
      while (k < s.length && s[k] !== ',') k++;
      while (k < s.length && !isDigit(s[k]) && s[k] !== '-') k++;
      const [hi] = num(k);
      while (k < s.length && s[k] !== ')' && s[k] !== ']') k++;
      const close = s[k];
      if (close !== ')' && close !== ']') return undefined;
      return {
        second: { op: '=', value: { kind: 'num', value: lo, isFloat: false }, value2: { kind: 'num', value: hi, isFloat: false }, loOpen: kind === '(', hiOpen: close === ')' },
        end: k + 1,
      };
    }
    default: return undefined;
  }
  const [v, end] = num(j);
  return { second: { op, value: { kind: 'num', value: v, isFloat: false } }, end };
}

/** HitDefAttr_Parse (0x459AB0): attribute bits, -1 if invalid. */
export function parseHitDefAttr(s: string, i: number): { bits: number; end: number } {
  let state = 0;
  let flags = 0;
  let k = i;
  let count = 0;
  let last = 0;
  if (isAlpha(s[k])) {
    do {
      const c = s[k]!.toLowerCase();
      if (c === 'a') state |= 4;
      else if (c === 'c') state |= 2;
      else if (c === 's') state |= 1;
      else return { bits: -1, end: k };
      k++;
    } while (isAlpha(s[k]));
  }
  while (isSpace(s[k])) k++;
  if (k >= s.length) return { bits: state, end: k };
  for (;;) {
    while (isSpace(s[k])) k++;
    count++;
    flags |= state;
    last = k - 1;
    if (s[k] !== ',') break;
    do k++;
    while (isSpace(s[k]));
    state = 0;
    let all: number, a: number, t: number, p: number;
    switch (s[k]?.toLowerCase()) {
      case 'n': [all, a, t, p] = [0x248, 0x008, 0x040, 0x200]; break;
      case 's': [all, a, t, p] = [0x490, 0x010, 0x080, 0x400]; break;
      case 'h': [all, a, t, p] = [0x920, 0x020, 0x100, 0x800]; break;
      // Original bug: a lone "A" gives the value of "H".
      case 'a': [all, a, t, p] = [0x920, 0x038, 0x1c0, 0xe00]; break;
      default: return finish();
    }
    const n2 = s[k + 1];
    if (n2 === undefined || n2 === '\t' || n2 === ' ' || n2 === ',') state = all;
    else {
      const l = n2.toLowerCase();
      if (l === 'a') state = a;
      else if (l === 't') state = t;
      else if (l === 'p') state = p;
      else return finish();
      k++;
    }
    const c = s[k + 1];
    if (isAlnum(c) || c === '_') break;
    k++;
  }
  return finish();
  function finish() {
    if (count < 1) return { bits: -1, end: k };
    return { bits: flags, end: last + 1 };
  }
}

/** Trigger_Parse (0x4538C0) at s[i]: one trigger call, with its redirection. */
function parseTrigger(s: string, i: number): { node: Node; end: number } {
  let [name, pos] = readWord(s, i, false);
  while (isSpace(s[pos])) pos++;
  const lname = name.toLowerCase();
  let redirect: { to: string; id: Node | null } | undefined;
  if (REDIRECTS.includes(lname)) {
    let id: Node | null = null;
    let p = pos;
    if (s[p] === '(' && lname !== 'parent' && lname !== 'root') {
      const r = parseAt(s, p + 1, true);
      if (s[r.end] !== ')') throw new Fail('Se esperaba ")"');
      id = r.node;
      p = r.end + 1;
    } else if (lname === 'playerid') throw new Fail('PlayerID necesita un ID');
    while (isSpace(s[p])) p++;
    if (s[p] === ',') {
      redirect = { to: lname, id };
      p++;
      while (isSpace(s[p])) p++;
      [name, pos] = readWord(s, p, false);
      while (isSpace(s[pos])) pos++;
    } else if (lname !== 'enemy' && lname !== 'enemynear' && lname !== 'partner') {
      throw new Fail(`Redirección "${name}" sin coma`);
    } else throw new Fail(`Redirección "${name}" sin coma`);
  }
  const id = lookup(name);
  if (!id) throw new Fail(`Trigger desconocido: ${name.toLowerCase()}`);
  const wrap = (node: Node, end: number) => ({ node: redirect ? ({ kind: 'redirect', to: redirect.to, id: redirect.id, expr: node } as Node) : node, end });
  const call = (extra: Partial<CallNode> = {}): CallNode => ({ kind: 'call', name: id, args: [], ...extra });

  // Function forms.
  if (OPT_ARG.has(id)) {
    if (s[pos] === '(') {
      const r = parseArgs(s, pos + 1, 1);
      return wrap(call({ args: r.args }), skip(s, r.end));
    }
    return wrap(call(), skip(s, pos));
  }
  if (ONE_ARG.has(id) || id === 'log' || id === 'ifelse' || id === 'cond') {
    if (s[pos] !== '(') throw new Fail(`${id} necesita "("`);
    const r = parseArgs(s, pos + 1, id === 'log' ? 2 : id === 'ifelse' || id === 'cond' ? 3 : 1);
    return wrap(call({ args: r.args }), skip(s, r.end));
  }
  if (id === 'gethitvar' || id === 'const' || id === 'stagevar') {
    if (s[pos] !== '(') throw new Fail(`Se esperaba ${id}(nombre)`);
    let p = pos + 1;
    while (isSpace(s[p])) p++;
    const [word, q] = readWord(s, p, true);
    p = q;
    while (isSpace(s[p])) p++;
    // gethitvar needs ')'; const / stagevar take any character there (original bug).
    if (id === 'gethitvar' ? s[p] !== ')' : p >= s.length) throw new Fail('Se esperaba ")"');
    if (id === 'stagevar') {
      // stagevar(info.name) etc. compare as strings: = "text".
      const v = scanToValue(s, p + 1);
      if (s[v.at] !== '"') throw new Fail('stagevar necesita = "texto"');
      const close = s.indexOf('"', v.at + 1);
      if (close < 0) throw new Fail('Falta "');
      return wrap({ kind: 'clause', name: 'stagevar', op: v.op, words: [word.toLowerCase(), s.slice(v.at + 1, close)], nums: [] }, close + 1);
    }
    return wrap(call({ word: word.toLowerCase() }), skip(s, p + 1));
  }
  if (id === 'win' || id === 'lose') {
    const rest = lname.slice(id.length);
    const lnameNow = name.toLowerCase().slice(id.length);
    const kind = lnameNow.startsWith('ko') ? 'ko' : lnameNow.startsWith('ti') ? 'time' : lnameNow === '' ? '' : undefined;
    void rest;
    if (kind === undefined) throw new Fail(`Trigger desconocido: ${name.toLowerCase()}`);
    return wrap(call({ name: id + kind }), skip(s, pos));
  }
  if (AXIS.has(id)) {
    const c = s[pos]?.toLowerCase();
    if (c !== 'x' && c !== 'y' && c !== 'z') throw new Fail(`${id} necesita x / y`);
    return wrap(call({ axis: c }), skip(s, pos + 1));
  }
  if (id === 'animelem' || id === 'timemod') {
    // "= n" then an optional ", comparison".
    const v = scanToValue(s, pos);
    const m = /^\d+/.exec(s.slice(v.at));
    if (!m) throw new Fail(`${id} necesita un número`);
    let n = parseInt(m[0], 10);
    if (id === 'timemod' && n <= 0) throw new Fail('TimeMod necesita un número > 0');
    if (id === 'animelem' && n <= 0) throw new Fail('AnimElem necesita un número > 0');
    let p = v.at;
    while (isDigit(s[p]) || isSpace(s[p])) p++;
    if (s[p] === ',') p++;
    while (isSpace(s[p])) p++;
    const end0 = p;
    const cmp = parseCompare(s, p);
    if (id === 'timemod') {
      if (!cmp) throw new Fail('TimeMod necesita un valor');
      return wrap({ kind: 'clause', name: 'timemod', op: cmp.second.op, words: [], nums: [{ kind: 'num', value: n, isFloat: false }, cmp.second.value] }, skip(s, cmp.end));
    }
    void n;
    return wrap({ kind: 'clause', name: 'animelem', op: '=', words: [], nums: [{ kind: 'num', value: n, isFloat: false }], second: cmp?.second }, skip(s, cmp ? cmp.end : end0));
  }
  if (id === 'projhit' || id === 'projguarded' || id === 'projcontact') {
    const idNum = parseInt(name.slice(id.length), 10) || 0;
    const v = scanToValue(s, pos);
    if (!isDigit(s[v.at])) throw new Fail(`${id} necesita 0 / 1`);
    const want = parseInt(/^\d+/.exec(s.slice(v.at))![0], 10);
    let p = v.at;
    while (isDigit(s[p]) || isSpace(s[p])) p++;
    if (s[p] === ',') p++;
    while (isSpace(s[p])) p++;
    const end0 = p;
    const cmp = parseCompare(s, p);
    return wrap({ kind: 'clause', name: id, op: '=', words: [], nums: [{ kind: 'num', value: want, isFloat: false }], second: cmp?.second, id: idNum }, skip(s, cmp ? cmp.end : end0));
  }
  if (id === 'command' || STRINGS.has(id)) {
    const v = scanToValue(s, pos);
    if (s[v.at] !== '"') throw new Fail(`${id} necesita = "texto"`);
    const close = s.indexOf('"', v.at + 1);
    if (close < 0) throw new Fail('Falta "');
    return wrap({ kind: 'clause', name: id === 'p1name' ? 'name' : id, op: v.op, words: [s.slice(v.at + 1, close)], nums: [] }, close + 1);
  }
  if (id === 'statetype' || id === 'p2statetype' || id === 'movetype' || id === 'p2movetype') {
    const v = scanToValue(s, pos);
    const c = s[v.at]?.toLowerCase();
    const ok = id.endsWith('statetype') ? 'acls' : 'ahi';
    if (!c || !ok.includes(c)) throw new Fail(`${id} con valor inválido`);
    return wrap({ kind: 'clause', name: id, op: v.op, words: [c], nums: [] }, v.at + 1);
  }
  if (id === 'teammode') {
    const v = scanToValue(s, pos);
    let e = v.at;
    while (e < s.length && !isSpace(s[e]) && s[e] !== ',' && s[e] !== ')') e++;
    const w = s.slice(v.at, e).toLowerCase();
    if (w !== 'single' && w !== 'simul' && w !== 'turns') throw new Fail(`TeamMode inválido: ${w}`);
    return wrap({ kind: 'clause', name: 'teammode', op: v.op, words: [w], nums: [] }, e);
  }
  if (id === 'hitdefattr') {
    const v = scanToValue(s, pos);
    const r = parseHitDefAttr(s, v.at);
    if (r.bits < 0) throw new Fail('HitDefAttr inválido');
    return wrap({ kind: 'clause', name: 'hitdefattr', op: v.op, words: [], nums: [], bits: r.bits }, r.end);
  }
  return wrap(call(), skip(s, pos));
}

function skip(s: string, i: number): number {
  while (isSpace(s[i])) i++;
  return i;
}

/** A whole expression (the trigger and parameter texts of a controller). */
export function mugenParseExpr(src: string): Node {
  try {
    return parseAt(src, 0, false).node;
  } catch (e) {
    if (e instanceof Fail) throw new ExprError(e.message, src, 0);
    throw e;
  }
}

/** Comma-separated values (Cns_ParseValues): each one parsed up to its ','. */
export function mugenParseList(src: string): Node[] {
  try {
    const out: Node[] = [];
    let cur = 0;
    for (;;) {
      const r = parseAt(src, cur, true);
      out.push(r.node);
      if (src[r.end] !== ',') {
        // The last value may end on any character (original quirk); trailing text is ignored.
        break;
      }
      cur = r.end + 1;
      while (isSpace(src[cur])) cur++;
      if (cur >= src.length) break;
    }
    return out;
  } catch (e) {
    if (e instanceof Fail) throw new ExprError(e.message, src, 0);
    throw e;
  }
}
