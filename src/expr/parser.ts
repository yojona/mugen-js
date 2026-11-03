// AST of MUGEN expressions and the parse entry points. The parser itself is
// mugen.exe's (src/expr/mugen-parse.ts).

import { mugenParseExpr, mugenParseList } from './mugen-parse';

export { ExprError } from './lexer';

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

/** A trigger that compares by itself, e.g. `animelem = 2, >= 3`, `command = "x"`. */
export interface ClauseNode {
  kind: 'clause';
  name: string;
  op: RelOp;
  /** String / identifier argument(s) (command, statetype, name...). */
  words: string[];
  /** Numeric arguments (animelem, timemod, projhit...). */
  nums: Node[];
  /**
   * Optional comparison of the elapsed time: `animelem = 2, >= 3`, or a range
   * `animelem = 2, [0, 3]` (value .. value2 with open ends).
   */
  second?: { op: RelOp; value: Node; value2?: Node; loOpen?: boolean; hiOpen?: boolean };
  /** ProjHit1234 etc.: numeric ID suffix. */
  id?: number;
  /** HitDefAttr: attribute bits (state 1/2/4 = S/C/A, then attack type bits). */
  bits?: number;
}

export function parseExpr(src: string): Node {
  return mugenParseExpr(src);
}

/** Comma-separated parameter list (each item is its own subexpression). */
export function parseExprList(src: string): Node[] {
  return mugenParseList(src);
}
