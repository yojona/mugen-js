// Debug helper: RNG state after every tick of one clock (pauses repeat the
// clock), ours vs a PEEKALL capture (SEEDCOL column).
import { readFileSync } from 'node:fs';
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const [refPath, lv, clk] = process.argv.slice(2);
const col = Number(process.env.SEEDCOL ?? 2);
const mugen: number[] = [];
let clock = 0;
for (const line of readFileSync(refPath!, 'latin1').split('\n')) {
  const p = line.split('|');
  if (p[0] === 'S' && p[2] === '1') clock = Number(p[3]!.split(',')[58]);
  if (p[0] === 'P' && clock === Number(clk)) mugen.push(Number(p[2]!.split(',')[col]));
}
const ours: number[] = [];
const orig = World.prototype.tick;
World.prototype.tick = function (this: World, inp: number[]) {
  orig.call(this, inp);
  if (this.players[0]!.vars[58] === Number(clk)) ours.push(this.seed);
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
for (let i = 0; i < Math.max(mugen.length, ours.length); i++) console.log(i, mugen[i], ours[i], mugen[i] === ours[i] ? '' : 'DIFF', i > 0 && mugen[i - 1] && mugen[i] ? dist(mugen[i - 1]!, mugen[i]!) : '', i > 0 && ours[i - 1] && ours[i] ? dist(ours[i - 1]!, ours[i]!) : '');
