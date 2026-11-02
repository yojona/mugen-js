// Compare harness logs. Usage: npx tsx tools/harness/diff.ts <mugen-states.log> <ours.log> [maxReports]
import { readFileSync } from 'node:fs';
import { compareLogs } from './compare';

const [ref, ours, maxArg] = process.argv.slice(2);
const r = compareLogs(readFileSync(ref!, 'latin1'), readFileSync(ours!, 'latin1'), parseInt(maxArg ?? '40', 10));
console.log(`Compared ${r.compared} player-ticks.`);
if (!r.first) console.log('No differences.');
else {
  console.log(`First divergence at clock ${r.first}.`);
  console.log('Ticks with a mismatch, per field:', Object.fromEntries([...r.perField].sort((x, y) => y[1] - x[1])));
  console.log(r.reports.join('\n'));
}
