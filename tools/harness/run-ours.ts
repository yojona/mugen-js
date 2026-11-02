// Write mugen-web's probe log. Usage: npx tsx tools/harness/run-ours.ts <ticks> <out.log>
import { writeFileSync } from 'node:fs';
import { runProbe } from './probe-run';

// Usage: run-ours.ts <ticks> <out.log> [char] [inputs] [char2]
const ticks = parseInt(process.argv[2] ?? '1600', 10);
const out = process.argv[3] ?? 'ours.log';
const lines = await runProbe(ticks, { char: process.argv[4] || undefined, inputs: process.argv[5] || undefined, char2: process.argv[6] || undefined, seed: process.argv[7] ? Number(process.argv[7]) : undefined, ai: process.argv[8] ? (process.argv[8].split(',').map((x) => (x ? Number(x) : undefined)) as [number | undefined, number | undefined]) : undefined });
writeFileSync(out, lines.join('\n') + '\n');
console.log(`${lines.length} lines -> ${out}`);
