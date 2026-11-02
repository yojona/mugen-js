// Compare harness state logs (MUGEN vs mugen-web), aligned on the probe's
// script clock var(58). Both sides log S|step|side|vars(60)|fvars(40).
// Usage: npx tsx tools/harness/diff.ts <mugen-states.log> <ours.log> [maxReports]

import { readFileSync } from 'node:fs';

/** Fields the probe CNS captures (overlay/chars/probe/probe.st). */
const VARS: Record<number, string> = {
  40: 'stateno', 41: 'prevstateno', 42: 'anim', 43: 'animtime', 44: 'animelemno', 45: 'time', 46: 'ctrl',
  47: 'statetype', 48: 'movetype', 49: 'life', 50: 'power', 51: 'facing', 52: 'hitpausetime', 53: 'movecontact',
  54: 'hitshake/hitover', 58: 'clock',
};
const FVARS: Record<number, string> = { 30: 'pos x', 31: 'pos y', 32: 'vel x', 33: 'vel y', 34: 'screenpos x', 35: 'p2dist x' };

interface Row {
  v: number[];
  f: number[];
}

function parse(file: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const line of readFileSync(file, 'latin1').split(/\r?\n/)) {
    if (!line.startsWith('S|')) continue;
    const [, , side, vs, fs] = line.split('|');
    const v = vs!.split(',').map(Number);
    const f = (fs ?? '').split(',').map(Number);
    const clock = v[58]!;
    if (clock <= 0) continue; // compare from the moment the script runs
    const key = `${clock}|${side}`;
    if (!rows.has(key)) rows.set(key, { v, f });
  }
  return rows;
}

const [ref, ours, maxArg] = process.argv.slice(2);
const A = parse(ref!);
const B = parse(ours!);
const max = parseInt(maxArg ?? '40', 10);
const keys = [...A.keys()].filter((k) => B.has(k)).sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));
const perField = new Map<string, number>();
const reports: string[] = [];
let first: string | undefined;
for (const k of keys) {
  const a = A.get(k)!;
  const b = B.get(k)!;
  const diffs: string[] = [];
  for (const [i, name] of Object.entries(VARS)) {
    const x = a.v[+i]!;
    const y = b.v[+i]!;
    if (x !== y) diffs.push(`${name} ${x}≠${y}`);
  }
  for (const [i, name] of Object.entries(FVARS)) {
    const x = a.f[+i]!;
    const y = b.f[+i]!;
    if (Math.abs(x - y) > 1e-3 * Math.max(1, Math.abs(x))) diffs.push(`${name} ${x}≠${y}`);
  }
  for (const d of diffs) perField.set(d.split(' ')[0]!, (perField.get(d.split(' ')[0]!) ?? 0) + 1);
  if (diffs.length) {
    first ??= k;
    if (reports.length < max) reports.push(`clock ${k.replace('|', ' P')}: ${diffs.join(', ')}   (MUGEN=, ours)`);
  }
}
console.log(`Compared ${keys.length} player-ticks (MUGEN ${A.size}, ours ${B.size}).`);
if (!first) console.log('No differences.');
else {
  console.log(`First divergence at clock ${first}.`);
  console.log('Ticks with a mismatch, per field:', Object.fromEntries([...perField].sort((x, y) => y[1] - x[1])));
  console.log(reports.join('\n'));
}
