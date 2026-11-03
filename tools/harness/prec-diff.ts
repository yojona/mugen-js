// First frames where positions or velocities differ from a mugen.exe capture
// at full precision (internal units, 1e-9).
// Usage: tsx tools/harness/prec-diff.ts <char1> <char2> <mugen.log> <frames>
import { readFileSync } from 'node:fs';
import { peekMatch } from './peek-run';
const [c1, c2, mlog, n] = process.argv.slice(2);
const rows = new Map<number, number[]>();
for (const l of readFileSync(mlog!, 'latin1').split('\n')) {
  if (!l.startsWith('P|')) continue;
  const v = l.split('|')[2]!.split(',').map(Number);
  if (!rows.has(v[0]!)) rows.set(v[0]!, v);
}
const ours = await peekMatch({ chars: [c1!, c2!], frames: Number(n), seed: 16808, exact: true } as never);
let shown = 0;
for (const l of ours) {
  const v = l.split('|')[2]!.split(',').map(Number);
  const m = rows.get(v[0]!);
  if (!m) continue;
  for (const [i, name] of [[6, 'p1.x'], [7, 'p1.y'], [8, 'p1.vx'], [9, 'p1.vy'], [13, 'p2.x'], [14, 'p2.y'], [15, 'p2.vx'], [16, 'p2.vy']] as const) {
    const d = Math.abs(m[i]! - v[i]! * 2);
    if (d > 1e-9) {
      console.log(`frame ${v[0]} ${name} mugen ${m[i]} ours ${v[i]! * 2} st ${m[3]}/${m[10]}`);
      if (++shown >= 8) process.exit(0);
    }
  }
}
