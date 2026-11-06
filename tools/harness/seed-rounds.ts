// Debug helper: first RNG divergence across rounds (clock restarts each
// round), ours vs a PEEKALL capture (SEEDCOL column).
import { readFileSync } from 'node:fs';
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const [refPath, ai] = process.argv.slice(2);
const col = Number(process.env.SEEDCOL ?? 2);
const key = (r: number, c: number) => r * 100000 + c;
const mugen = new Map<number, number>();
{
  let clock = 0;
  let last = 0;
  let round = 0;
  for (const line of readFileSync(refPath!, 'latin1').split('\n')) {
    const p = line.split('|');
    if (p[0] === 'S' && p[2] === '1') {
      clock = Number(p[3]!.split(',')[58]);
      if (clock > 0 && clock < last) round++;
      if (clock > 0) last = clock;
    }
    if (p[0] === 'P' && clock > 0) mugen.set(key(round, clock), Number(p[2]!.split(',')[col]));
  }
}
const ours = new Map<number, number>();
let last = 0;
let round = 0;
const orig = World.prototype.tick;
World.prototype.tick = function (this: World, inp: number[]) {
  orig.call(this, inp);
  const c = this.players[0]!.vars[58]!;
  if (c > 0 && c < last) round++;
  if (c > 0) last = c;
  if (c > 0) ours.set(key(round, c), this.seed);
};
await runProbe(Number(process.env.TICKS ?? 9000), {
  char: 'probeai',
  seed: 937167434,
  ai: (ai ?? '4,4').split(',').map(Number) as [number, number],
});
for (const [k, s] of [...mugen].sort((a, b) => a[0] - b[0])) {
  if (ours.get(k) !== s) {
    console.log('first seed diff at', k, 'mugen', s, 'ours', ours.get(k));
    process.exit(0);
  }
}
console.log('seeds identical for', mugen.size, 'clocks');
