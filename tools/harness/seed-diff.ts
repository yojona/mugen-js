// Debug helper: compare MUGEN's RNG seed per clock (PEEKALL column 4 =
// [0x5040e8]+0x12840) with ours, and report the first clock that differs.
import { readFileSync } from 'node:fs';
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const [refPath, char, seed, ai2] = process.argv.slice(2);
const mugen = new Map<number, number>();
let clock = 0;
for (const line of readFileSync(refPath!, 'latin1').split('\n')) {
  const p = line.split('|');
  if (p[0] === 'S' && p[2] === '1') clock = Number(p[3]!.split(',')[58]);
  if (p[0] === 'P' && clock > 0) mugen.set(clock, Number(p[2]!.split(',')[3]));
}
const ours = new Map<number, number>();
const orig = World.prototype.tick;
World.prototype.tick = function (this: World, inp: number[]) {
  orig.call(this, inp);
  const c = this.players[0]!.vars[58]!;
  if (c > 0) ours.set(c, this.seed);
};
await runProbe(1000, { char: char!, seed: Number(seed), ai: [undefined, ai2 ? Number(ai2) : undefined] });
for (const [c, s] of [...mugen].sort((a, b) => a[0] - b[0])) {
  if (ours.get(c) !== s) {
    console.log('first seed diff at clock', c, 'mugen', s, 'ours', ours.get(c), 'prev ok clock', c - 1);
    process.exit(0);
  }
}
console.log('seeds identical for', mugen.size, 'clocks');
