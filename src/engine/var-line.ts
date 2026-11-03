// The variable a VarSet / VarAdd / ParentVarSet / ParentVarAdd writes, read
// the way mugen.exe does (parse_var_line / parse_var_value in sctrl.c).

import { compileExpr, compileNode, type Fn, type TriggerEnv } from '../expr/compile';
import { tryParseAt } from '../expr/mugen-parse';
import type { ControllerDef } from './cns';

export type VarKind = 'var' | 'fvar' | 'sysvar' | 'sysfvar';

export interface VarTarget<C> {
  kind: VarKind;
  index: Fn<C>;
  value: Fn<C>;
}

/**
 * With `value`: the index in v (var) or fv (fvar); neither = no target. Else
 * the first "var(n) = x" line (sysvar / sysfvar only with `sys`).
 */
export function varTarget<C>(c: ControllerDef, env: TriggerEnv<C>, sys: boolean): VarTarget<C> | undefined {
  const value = c.params.get('value');
  if (value !== undefined) {
    const v = c.params.get('v');
    if (v !== undefined) return { kind: 'var', index: compileExpr(v, env), value: compileExpr(value, env) };
    const fv = c.params.get('fv');
    if (fv !== undefined) return { kind: 'fvar', index: compileExpr(fv, env), value: compileExpr(value, env) };
    return undefined;
  }
  for (const [key, text] of c.params) {
    const m = /^(sysfvar|sysvar|fvar|var)\s*(\(.*)$/.exec(key);
    if (!m || (!sys && m[1]!.startsWith('sys'))) continue;
    const r = tryParseAt(m[2]!, 1, true);
    if (!r || m[2]![r.end] !== ')') return undefined;
    return { kind: m[1] as VarKind, index: compileNode(r.node, env), value: compileExpr(text, env) };
  }
  return undefined;
}
