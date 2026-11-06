// Debug helper: who draws from the RNG at one clock (ROUND 0-based).
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const clk = Number(process.argv[2]);
const want = Number(process.env.ROUND ?? 0);
let round = 0;
let last = 0;
let on = false;
const origTick = World.prototype.tick;
World.prototype.tick = function (this: World, inp: number[]) {
  const c = this.players[0]!.vars[58]! + 1;
  if (c - 1 < last) round++;
  last = c - 1;
  on = round === want && c === clk;
  origTick.call(this, inp);
  on = false;
};
const origRand = World.prototype.random;
World.prototype.random = function (this: World, n: number) {
  const v = origRand.call(this, n);
  if (on)
    console.log(
      'rand',
      n,
      '=',
      v,
      new Error()
        .stack!.split('\n')
        .slice(2, 5)
        .map((l) => l.trim().replace(/\(.*src\//, '('))
        .join(' < '),
    );
  return v;
};
await runProbe(Number(process.env.TICKS ?? 9000), { char: 'probeai', seed: 937167434, ai: [4, 4] });
