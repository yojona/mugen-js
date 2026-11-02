// Compare two harness logs (MUGEN vs mugen-web), aligned on the script clock.
// Usage: npx tsx tools/harness/diff.ts <mugen.log> <ours.log> [maxReports]

import { readFileSync } from 'node:fs';

type Row = Map<string, string>;

function parse(file: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const line of readFileSync(file, 'latin1').split(/\r?\n/)) {
    const i = line.indexOf('H|');
    if (i < 0) continue;
    const parts = line.slice(i).split('|');
    const [, , mode, idx, ...kv] = parts;
    if (mode !== 'fight') continue;
    const row: Row = new Map();
    for (const p of kv) {
      const eq = p.indexOf('=');
      if (eq > 0) row.set(p.slice(0, eq), p.slice(eq + 1));
    }
    const clock = row.get('clock');
    if (!clock || clock === '0') continue; // only ticks once the script runs
    // Keep the first row per (clock, player): later ones are the same tick re-dumped.
    const key = `${clock}|${idx}`;
    if (!rows.has(key)) rows.set(key, row);
  }
  return rows;
}

/** Normalise values: booleans, numbers (with tolerance) and vectors. */
function nums(v: string): number[] | undefined {
  const m = v.match(/-?\d+(\.\d+)?(e-?\d+)?/gi);
  return m ? m.map(Number) : undefined;
}
function same(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^true$/, '1').replace(/^false$/, '0');
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  const nx = nums(x);
  const ny = nums(y);
  if (!nx || !ny || nx.length !== ny.length) return false;
  return nx.every((v, i) => Math.abs(v - ny[i]!) <= 1e-3 * Math.max(1, Math.abs(v)));
}

const [ref, ours, maxArg] = process.argv.slice(2);
const A = parse(ref!);
const B = parse(ours!);
const max = parseInt(maxArg ?? '30', 10);
const keys = [...A.keys()].filter((k) => B.has(k)).sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));
const perField = new Map<string, number>();
const reports: string[] = [];
let firstTick: string | undefined;
for (const k of keys) {
  const a = A.get(k)!;
  const b = B.get(k)!;
  for (const [field, av] of a) {
    if (field === 'clock' || !b.has(field)) continue;
    const bv = b.get(field)!;
    if (same(av, bv)) continue;
    perField.set(field, (perField.get(field) ?? 0) + 1);
    firstTick ??= k;
    if (reports.length < max) reports.push(`clock ${k.replace('|', ' P')}  ${field}: MUGEN=${av}  ours=${bv}`);
  }
}
console.log(`Compared ${keys.length} player-ticks (MUGEN ${A.size}, ours ${B.size}).`);
if (!perField.size) {
  console.log('No differences.');
} else {
  console.log(`First divergence at clock ${firstTick}.`);
  console.log('Mismatches per field:', Object.fromEntries([...perField].sort((x, y) => y[1] - x[1])));
  console.log(reports.join('\n'));
}
