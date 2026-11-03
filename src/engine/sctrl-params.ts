// Load-time check of a controller's parameters the way mugen.exe parses them
// (StateCtrl_ParseParams and its helpers, described in sctrl-spec.ts): only
// the keys mugen.exe reads are looked at, each with its own reader. A failure
// here is a failure to load the character in mugen.exe.

import { tryParseAt } from '../expr/mugen-parse';
import type { Node } from '../expr/parser';
import { parseHitDefAttr } from '../expr/mugen-parse';
import type { ControllerDef } from './cns';
import { SCTRL_SPECS, STATEDEF_SPEC, type ParamKind, type ParamSpec } from './sctrl-spec';

type Want = 'int' | 'float' | 'any';
const wantOf = (c: string): Want => (c === 'i' ? 'int' : c === 'f' ? 'float' : 'any');

/** Expr_Compile: a single float literal is refused where an int is wanted. */
function wantOk(n: Node, want: Want): boolean {
  return !(want === 'int' && n.kind === 'num' && n.isFloat);
}

/** Expr_Compile without an end pointer: the whole text is one expression. */
export function exprOk(s: string, want: Want): boolean {
  if (s.length === 0) return false;
  const r = tryParseAt(s, 0, false);
  return !!r && wantOk(r.node, want);
}

/**
 * Cns_ParseValues (0x458CE0): the number of values read and where it
 * stopped (after blanks). The last value may end on any character.
 */
export function parseValues(s: string, fmt: string): { count: number; end: number } {
  const n = [...fmt].filter((c) => c === 'n' || c === 'i' || c === 'f').length;
  let cur = 0;
  let i = 0;
  for (; i < n; i++) {
    if (cur >= s.length) break;
    const r = tryParseAt(s, cur, true);
    if (!r || !wantOk(r.node, wantOf(fmt[i]!))) break;
    let e = r.end;
    if (s[e] === ',') {
      if (i < n - 1) e++;
    } else if (e < s.length && i !== n - 1) break;
    cur = e;
  }
  while (cur < s.length && /\s/.test(s[cur]!)) cur++;
  return { count: i, end: cur };
}

function valuesOk(s: string, fmt: string, check: string): boolean {
  const { count, end } = parseValues(s, fmt);
  const atEnd = end >= s.length;
  switch (check) {
    case 'none':
      return true;
    case 'pair':
      return atEnd;
    case 'atLeast1':
      return count > 0;
    default:
      return atEnd && count > 0;
  }
}

/** An F / S prefix (Cns_ParseSoundRef / Cns_ParseAnimRef) removed. */
function stripPrefix(s: string, letters: string): string {
  return letters.includes(s[0]?.toLowerCase() ?? '') ? s.slice(1) : s;
}

function wordOk(key: string, s: string, type: string): boolean {
  const c = s[0]?.toLowerCase() ?? '';
  const last = key.slice(key.lastIndexOf('.') + 1);
  if (key === 'affectteam') return 'bef'.includes(c) && c !== '';
  if (last === 'animtype') return c !== '' && 'lmhbud'.includes(c);
  if (key === 'ground.type' || key === 'air.type') return c !== '' && 'nhlt'.includes(c);
  if (key === 'helpertype') return /^(normal|player|proj)/i.test(s);
  if (type === 'trans' && key === 'trans') return /^(none|add|addalpha|add1|sub|default)$/i.test(s);
  return true;
}

/** Cns_ParseVelocity: "x[, y]" where "n" stands for none. */
function velocityOk(s: string): boolean {
  let e: number;
  if (/^n(\s|,|$)/i.test(s)) e = 1;
  else {
    const r = tryParseAt(s, 0, true);
    if (!r || s[r.end] === ')' || s[r.end] === ']') return false;
    e = r.end;
  }
  while (/\s/.test(s[e] ?? '')) e++;
  if (e >= s.length) return true;
  if (s[e] !== ',') return false;
  do e++;
  while (/\s/.test(s[e] ?? ''));
  if (/^n(\s|$)/i.test(s.slice(e))) e++;
  else {
    const r = tryParseAt(s, e, true);
    if (!r) return false;
    e = r.end;
  }
  while (/\s/.test(s[e] ?? '')) e++;
  return e >= s.length;
}

/** mugenversion below 1.0 (dates "y,m,d", missing or invalid; Version_Parse 0x4218E0). */
export function isPre10(mugenVersion: string): boolean {
  const v = mugenVersion.trim();
  if (v === '' || v.includes(',')) return true;
  const n = parseFloat(v);
  return !(n >= 1);
}

function kindOk(spec: ParamSpec, raw: string, c: ControllerDef, pre10: boolean): boolean {
  const s = raw.trim();
  const k: ParamKind = spec.kind;
  // HitDef snap / mindist / maxdist take an extra z before 1.0.
  if (pre10 && spec.key === 'snap') return valuesOk(s, 'iiii', 'checked');
  if (c.type === 'bindtotarget' && spec.key === 'pos') {
    // "x, y[, foot | mid | head]"
    const { count, end } = parseValues(s, 'ff:,');
    if (count === 0) return false;
    if (end >= s.length) return true;
    if (s[end] !== ',' || count !== 2) return false;
    const w = s.slice(end + 1).trim()[0]?.toLowerCase();
    return w === 'f' || w === 'h' || w === 'm';
  }
  if (pre10 && (spec.key === 'mindist' || spec.key === 'maxdist')) return valuesOk(s, 'iii', 'checked');
  switch (k.k) {
    case 'expr':
      return exprOk(s, k.want);
    case 'values':
      return valuesOk(s, k.fmt, k.check);
    case 'soundRef':
      return valuesOk(stripPrefix(s, 'fs'), 'ii', 'checked');
    case 'animRef':
      return valuesOk(stripPrefix(s, 'fs'), 'i', 'checked');
    case 'velocity':
      return velocityOk(s);
    case 'posType':
      return s !== '' && 'pfblrn'.includes(s[0]!.toLowerCase());
    case 'hitDefAttr':
      return parseHitDefAttr(s, 0).bits >= 0;
    case 'hitFlags':
    case 'string':
      return true;
    case 'word':
      return wordOk(spec.key, s, c.type);
    case 'varLine':
      return true;
    case 'custom':
      if (spec.key === 'sparkno' || spec.key === 'guard.sparkno') return exprOk(stripPrefix(s, 's'), 'int');
      if (spec.key === 'anim') return exprOk(stripPrefix(s, 'f'), 'int');
      if (spec.key === 'priority') {
        const { count, end } = parseValues(s, 'i');
        if (count === 0) return false;
        if (end >= s.length) return true;
        if (s[end] !== ',') return false;
        const w = s.slice(end + 1).trim()[0]?.toLowerCase();
        return w === 'h' || w === 'm' || w === 'd';
      }
      if (spec.key === 'value') {
        // VarSet "value = x" with v / fv; without either it is not compiled.
        if (c.params.has('v')) return exprOk(s, 'int');
        if (c.params.has('fv')) return exprOk(s, 'float');
        return true;
      }
      return true;
  }
}

/** The var(n) = x line form of VarSet / VarAdd (parse_var_line). */
function varLineOk(c: ControllerDef, sys: boolean): boolean {
  for (const [key, v] of c.params) {
    const m = /^(sysfvar|sysvar|fvar|var)\s*(.*)$/.exec(key);
    if (!m || (!sys && m[1]!.startsWith('sys'))) continue;
    // "(" index ")" then anything up to the '=' (parse_var_line).
    const rest = m[2]!.trim();
    if (rest[0] !== '(') return false;
    const r = tryParseAt(rest, 1, true);
    if (!r || rest[r.end] !== ')' || !wantOk(r.node, 'int')) return false;
    return exprOk(v.trim(), m[1]!.includes('f') ? 'float' : 'int');
  }
  return false;
}

function check(specs: ParamSpec[], c: ControllerDef, pre10: boolean): void {
  for (const spec of specs) {
    if (spec.key === 'var(n)') continue;
    const raw = c.params.get(spec.key);
    if (raw === undefined) {
      if (spec.required) throw new Error(`falta el parámetro ${spec.key}`);
      continue;
    }
    if (spec.fatal && !kindOk(spec, raw, c, pre10)) throw new Error(`parámetro ${spec.key} inválido: "${raw.trim()}"`);
  }
  if (specs.some((s) => s.key === 'var(n)') && !c.params.has('value') && !varLineOk(c, c.type === 'varset' || c.type === 'varadd')) {
    throw new Error('falta var(n) = valor');
  }
}

/** Throws where mugen.exe would refuse this controller (and the character). */
export function checkControllerParams(c: ControllerDef, mugenVersion = '1.0'): void {
  const specs = SCTRL_SPECS[c.type];
  if (!specs) throw new Error(`controller desconocido "${c.type}"`);
  check(specs, c, isPre10(mugenVersion));
}

/** The keys mugen.exe reads for a controller type (undefined: unknown type). */
export function specKeys(type: string): Set<string> | undefined {
  const specs = SCTRL_SPECS[type];
  return specs && new Set(specs.map((s) => s.key));
}

export { STATEDEF_SPEC };
