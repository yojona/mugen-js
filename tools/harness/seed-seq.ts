// Debug helper: RNG state after every tick of one clock (pauses repeat the
// clock), ours vs a PEEKALL capture (SEEDCOL column). ROUND picks the round
// (0-based; the clock restarts each round). MUGEN rows are per frame, so the
// KO slowdown repeats them.
import { readFileSync } from 'node:fs';
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const [refPath, lv, clk] = process.argv.slice(2);
const col = Number(process.env.SEEDCOL ?? 2);
const want = Number(process.env.ROUND ?? 0);
const mugen: number[] = [];
let clock = 0;
let round = 0;
for (const line of readFileSync(refPath!, 'latin1').split('\n')) {
  const p = line.split('|');
  if (p[0] === 'S' && p[2] === '1') {
    const c = Number(p[3]!.split(',')[58]);
    if (c < clock) round++;
    clock = c;
  }
  if (p[0] === 'P' && round === want && clock === Number(clk)) mugen.push(Number(p[2]!.split(',')[col]));
}
const ours: number[] = [];
let oclock = 0;
let oround = 0;
const orig = World.prototype.tick;
World.prototype.tick = function (this: World, inp: number[]) {
  orig.call(this, inp);
  const c = this.players[0]!.vars[58]!;
  if (c < oclock) oround++;
  oclock = c;
  if (oround === want && c === Number(clk)) ours.push(this.seed);
};
await runProbe(Number(process.env.TICKS ?? 3000), { char: 'probeai', seed: 937167434, ai: [Number(lv), Number(lv)] });
const dist = (a: number, b: number) => {
  let s = a;
  for (let i = 0; i < 300; i++) {
    if (s === b) return i;
    s = (s * 16807) % 2147483647;
  }
  return -1;
};
console.log('mugen', mugen.length, 'ours', ours.length);
for (let i = 0; i < Math.max(mugen.length, ours.length); i++)
  console.log(
    i,
    mugen[i],
    ours[i],
    mugen[i] === ours[i] ? '' : 'DIFF',
    i > 0 && mugen[i - 1] && mugen[i] ? dist(mugen[i - 1]!, mugen[i]!) : '',
    i > 0 && ours[i - 1] && ours[i] ? dist(ours[i - 1]!, ours[i]!) : '',
  );
