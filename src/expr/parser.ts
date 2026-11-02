// Parser for MUGEN expressions.
//
// Precedence (cns.html), highest to lowest:
//   ! ~ - (unary) | ** | * / % | + - | > >= < <= | = != intervals | := | & | ^ | | | && | ^^ | ||
// Trigger redirection ("parent, time") has the lowest precedence and applies to
// the rest of the (sub)expression, which is why the docs write "5 + (parent, time)".

import { ExprError, tokenize, type Token } from './lexer';

export type RelOp = '=' | '!=' | '<' | '>' | '<=' | '>=';

export type Node =
  | { kind: 'num'; value: number; isFloat: boolean }
  | { kind: 'unary'; op: '!' | '~' | '-'; arg: Node }
  | { kind: 'binary'; op: string; l: Node; r: Node }
  | { kind: 'interval'; negate: boolean; x: Node; lo: Node; hi: Node; loOpen: boolean; hiOpen: boolean }
  | { kind: 'assign'; target: CallNode; value: Node }
  | CallNode
  | { kind: 'redirect'; to: string; id: Node | null; expr: Node }
  | ClauseNode;

/** Regular function-type trigger, e.g. `time`, `var(3)`, `pos x`, `const(data.life)`. */
export interface CallNode {
  kind: 'call';
  name: string;
  args: Node[];
  /** Component selector for vector triggers: `pos x`, `vel y`. */
  axis?: 'x' | 'y' | 'z';
  /** Unevaluated word argument: const(...), gethitvar(...), stagevar(...). */
  word?: string;
}

/** Old-style ("***") trigger clause, e.g. `animelem = 2, >= 3`, `command = "x"`. */
export interface ClauseNode {
  kind: 'clause';
  name: string;
  op: RelOp;
  /** String / identifier argument(s) (command, statetype, name, hitdefattr...). */
  words: string[];
  /** Numeric arguments (animelem, timemod, projhit...). */
  nums: Node[];
  /** Optional second comparison: `animelem = 2, >= 3`. */
  second?: { op: RelOp; value: Node };
  /** ProjHit1234 etc.: numeric ID suffix. */
  id?: number;
}

const REDIRECTS = new Set(['parent', 'root', 'helper', 'target', 'partner', 'enemy', 'enemynear', 'playerid']);
const REDIRECTS_WITH_ARG = new Set(['helper', 'target', 'enemy', 'enemynear', 'playerid']);

/** Triggers followed by an axis word (x / y / z). */
export const AXIS_TRIGGERS = new Set(['pos', 'vel', 'hitvel', 'screenpos', 'p2dist', 'p2bodydist', 'parentdist', 'rootdist', 'camerapos']);

/** Triggers whose single argument is an unevaluated name. */
const WORD_ARG_TRIGGERS = new Set(['const', 'gethitvar', 'stagevar']);

const STRING_CLAUSES = new Set(['command', 'name', 'p1name', 'p2name', 'p3name', 'p4name', 'authorname']);
const LETTER_CLAUSES = new Set(['statetype', 'p2statetype', 'movetype', 'p2movetype', 'teammode']);
const PROJ_CLAUSE_RE = /^(projcontact|projguarded|projhit)(\d*)$/;
const REL_OPS = new Set(['=', '!=', '<', '>', '<=', '>=']);

export function parseExpr(src: string): Node {
  const p = new Parser(src);
  const n = p.expr();
  p.expectEnd();
  return n;
}

/** Comma-separated parameter list (each item is its own subexpression). */
export function parseExprList(src: string): Node[] {
  const p = new Parser(src);
  const out = [p.expr()];
  while (p.accept(',')) out.push(p.expr());
  p.expectEnd();
  return out;
}

class Parser {
  private toks: Token[];
  private i = 0;

  constructor(private src: string) {
    this.toks = tokenize(src);
  }

  private get t(): Token {
    return this.toks[this.i]!;
  }
  private peek(n = 1): Token {
    return this.toks[Math.min(this.i + n, this.toks.length - 1)]!;
  }
  private fail(msg: string, tok: Token = this.t): never {
    throw new ExprError(msg, this.src, tok.pos);
  }
  private isOp(text: string, tok: Token = this.t): boolean {
    return tok.type === 'op' && tok.text === text;
  }
  accept(text: string): boolean {
    if (this.isOp(text)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expect(text: string): void {
    if (!this.accept(text)) this.fail(`Se esperaba "${text}"`);
  }
  expectEnd(): void {
    if (this.t.type !== 'eof') this.fail(`Texto inesperado "${this.t.raw}"`);
  }

  // expr := redirect ',' expr | or
  expr(): Node {
    const t = this.t;
    if (t.type === 'ident' && REDIRECTS.has(t.text)) {
      const save = this.i;
      this.i++;
      let id: Node | null = null;
      if (REDIRECTS_WITH_ARG.has(t.text) && this.isOp('(')) {
        this.i++;
        id = this.expr();
        this.expect(')');
      }
      if (this.accept(',')) return { kind: 'redirect', to: t.text, id, expr: this.expr() };
      this.i = save;
      if (t.text === 'helper' || t.text === 'target' || t.text === 'parent' || t.text === 'root') {
        this.fail(`Redirección "${t.raw}" sin coma`);
      }
    }
    return this.or();
  }

  private binLevel(ops: string[], next: () => Node): Node {
    let l = next();
    for (;;) {
      const op = this.t;
      if (op.type === 'op' && ops.includes(op.text)) {
        this.i++;
        l = { kind: 'binary', op: op.text, l, r: next() };
      } else return l;
    }
  }

  private or = (): Node => this.binLevel(['||'], this.xor);
  private xor = (): Node => this.binLevel(['^^'], this.and);
  private and = (): Node => this.binLevel(['&&'], this.bitOr);
  private bitOr = (): Node => this.binLevel(['|'], this.bitXor);
  private bitXor = (): Node => this.binLevel(['^'], this.bitAnd);
  private bitAnd = (): Node => this.binLevel(['&'], this.assign);

  // := is right-associative and requires a variable on the left.
  private assign = (): Node => {
    const l = this.equality();
    if (this.isOp(':=')) {
      const tok = this.t;
      if (l.kind !== 'call' || !['var', 'fvar', 'sysvar', 'sysfvar'].includes(l.name)) {
        this.fail('El lado izquierdo de := debe ser var/fvar/sysvar/sysfvar', tok);
      }
      this.i++;
      return { kind: 'assign', target: l, value: this.assign() };
    }
    return l;
  };

  private equality = (): Node => {
    let l = this.relational();
    for (;;) {
      const op = this.t;
      if (!(this.isOp('=') || this.isOp('!='))) return l;
      this.i++;
      if (this.isOp('[') || (this.isOp('(') && this.parenIsInterval())) {
        l = this.interval(l, op.text === '!=');
        continue;
      }
      l = { kind: 'binary', op: op.text, l, r: this.relational() };
    }
  };

  /** At '(' : is this an interval "(a, b)" rather than a parenthesized expression? */
  private parenIsInterval(): boolean {
    let j = this.i + 1;
    // Skip a leading redirect prefix: "(parent, time)" / "(helper(2), time)".
    const first = this.toks[j]!;
    if (first.type === 'ident' && REDIRECTS.has(first.text)) {
      let k = j + 1;
      if (this.isOp('(', this.toks[k]!)) k = this.matching(k) + 1;
      if (this.isOp(',', this.toks[k]!)) j = k + 1;
    }
    let depth = 1;
    for (; j < this.toks.length; j++) {
      const t = this.toks[j]!;
      if (t.type === 'eof') return false;
      if (t.type !== 'op') continue;
      if (t.text === '(' || t.text === '[') depth++;
      else if (t.text === ')' || t.text === ']') {
        if (--depth === 0) return false;
      } else if (t.text === ',' && depth === 1) return true;
    }
    return false;
  }

  /** Index of the bracket closing the one at `k`. */
  private matching(k: number): number {
    let depth = 0;
    for (let j = k; j < this.toks.length; j++) {
      const t = this.toks[j]!;
      if (t.type !== 'op') continue;
      if (t.text === '(' || t.text === '[') depth++;
      else if ((t.text === ')' || t.text === ']') && --depth === 0) return j;
    }
    return this.toks.length - 1;
  }

  private interval(x: Node, negate: boolean): Node {
    const loOpen = this.isOp('(');
    this.i++;
    const lo = this.expr();
    this.expect(',');
    const hi = this.expr();
    let hiOpen: boolean;
    if (this.accept(')')) hiOpen = true;
    else if (this.accept(']')) hiOpen = false;
    else this.fail('Intervalo sin cerrar');
    return { kind: 'interval', negate, x, lo, hi, loOpen, hiOpen };
  }

  private relational = (): Node => this.binLevel(['>', '>=', '<', '<='], this.additive);
  private additive = (): Node => this.binLevel(['+', '-'], this.multiplicative);
  private multiplicative = (): Node => this.binLevel(['*', '/', '%'], this.power);
  private power = (): Node => this.binLevel(['**'], this.unary);

  private unary = (): Node => {
    const t = this.t;
    if (this.isOp('!') || this.isOp('~') || this.isOp('-')) {
      this.i++;
      const arg = this.unary();
      // Fold negative literals so "-2147483648" stays an int.
      if (t.text === '-' && arg.kind === 'num') return { kind: 'num', value: -arg.value, isFloat: arg.isFloat };
      return { kind: 'unary', op: t.text as '!' | '~' | '-', arg };
    }
    if (this.isOp('+')) {
      this.i++;
      return this.unary();
    }
    return this.primary();
  };

  private primary(): Node {
    const t = this.t;
    if (t.type === 'num') {
      this.i++;
      return { kind: 'num', value: t.isFloat ? parseFloat(t.text) : parseInt(t.text, 10), isFloat: !!t.isFloat };
    }
    if (this.isOp('(')) {
      this.i++;
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (t.type === 'ident') return this.trigger();
    if (t.type === 'eof') this.fail('Expresión incompleta');
    return this.fail(`Token inesperado "${t.raw}"`);
  }

  private relOp(): RelOp {
    const t = this.t;
    if (t.type === 'op' && REL_OPS.has(t.text)) {
      this.i++;
      return t.text as RelOp;
    }
    return this.fail('Se esperaba un operador de comparación');
  }

  /**
   * Optional ", [oper] value" tail of AnimElem / ProjHit-style clauses. The
   * operator defaults to "=" (kfm.cns uses "AnimElem = 3, -1"). Like MUGEN, the
   * comma is consumed greedily, even inside a function argument list.
   */
  private clauseSecond(clause: ClauseNode): void {
    if (!this.isOp(',')) return;
    const next = this.peek();
    const hasOp = next.type === 'op' && REL_OPS.has(next.text);
    const isValue = next.type === 'num' || (next.type === 'op' && (next.text === '-' || next.text === '('));
    if (!hasOp && !isValue) return;
    this.i++;
    clause.second = { op: hasOp ? this.relOp() : '=', value: this.clauseNum() };
  }

  /** A numeric argument of an old-style clause: optionally signed literal or (expr). */
  private clauseNum(): Node {
    return this.unary();
  }

  private trigger(): Node {
    const t = this.t;
    const name = t.text;
    this.i++;

    // Old-style clauses.
    if (STRING_CLAUSES.has(name)) {
      const op = this.relOp();
      if (this.t.type !== 'str') this.fail(`${t.raw} necesita un texto entre comillas`);
      const s = this.t.raw;
      this.i++;
      return { kind: 'clause', name, op, words: [s], nums: [] };
    }
    if (LETTER_CLAUSES.has(name)) {
      const op = this.relOp();
      if (this.t.type !== 'ident') this.fail(`${t.raw} necesita un valor`);
      const w = this.t.text;
      this.i++;
      return { kind: 'clause', name, op, words: [w], nums: [] };
    }
    if (name === 'hitdefattr') {
      const op = this.relOp();
      if (this.t.type !== 'ident') this.fail('HitDefAttr necesita atributos');
      const words = [this.t.text];
      this.i++;
      while (this.isOp(',') && this.peek().type === 'ident' && /^[nsh][atp]$/.test(this.peek().text)) {
        this.i++;
        words.push(this.t.text);
        this.i++;
      }
      return { kind: 'clause', name, op, words, nums: [] };
    }
    if (name === 'animelem') {
      const op = this.relOp();
      const n = this.clauseNum();
      const clause: ClauseNode = { kind: 'clause', name, op, words: [], nums: [n] };
      this.clauseSecond(clause);
      return clause;
    }
    if (name === 'timemod') {
      const op = this.relOp();
      const div = this.clauseNum();
      this.expect(',');
      return { kind: 'clause', name, op, words: [], nums: [div, this.clauseNum()] };
    }
    const pm = PROJ_CLAUSE_RE.exec(name);
    if (pm) {
      const op = this.relOp();
      const clause: ClauseNode = { kind: 'clause', name: pm[1]!, op, words: [], nums: [this.clauseNum()] };
      if (pm[2]) clause.id = parseInt(pm[2], 10);
      this.clauseSecond(clause);
      return clause;
    }

    const call: CallNode = { kind: 'call', name, args: [] };
    if (WORD_ARG_TRIGGERS.has(name)) {
      this.expect('(');
      if (this.t.type !== 'ident') this.fail(`${t.raw}() necesita un nombre`);
      call.word = this.t.text;
      this.i++;
      this.expect(')');
      // stagevar(info.name) = "..." compares strings.
      if (name === 'stagevar' && (this.isOp('=') || this.isOp('!=')) && this.peek().type === 'str') {
        const op = this.relOp();
        const s = this.t.raw;
        this.i++;
        return { kind: 'clause', name, op, words: [call.word, s], nums: [] };
      }
      return call;
    }
    if (this.isOp('(')) {
      this.i++;
      if (!this.isOp(')')) {
        call.args.push(this.expr());
        while (this.accept(',')) call.args.push(this.expr());
      }
      this.expect(')');
    }
    if (AXIS_TRIGGERS.has(name)) {
      const a = this.t;
      if (a.type === 'ident' && (a.text === 'x' || a.text === 'y' || a.text === 'z')) {
        call.axis = a.text;
        this.i++;
      } else this.fail(`${t.raw} necesita un eje (x / y)`);
    }
    return call;
  }
}
