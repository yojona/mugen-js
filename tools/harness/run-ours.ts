// Write mugen-web's probe log. Usage: npx tsx tools/harness/run-ours.ts <ticks> <out.log>
import { writeFileSync } from 'node:fs';
import { runProbe } from './probe-run';

const ticks = parseInt(process.argv[2] ?? '1600', 10);
const out = process.argv[3] ?? 'ours.log';
const lines = await runProbe(ticks);
writeFileSync(out, lines.join('\n') + '\n');
console.log(`${lines.length} lines -> ${out}`);
