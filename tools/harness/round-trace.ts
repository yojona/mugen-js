// Debug helper: per tick at one clock: roundState, players' states, seed.
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const clk = Number(process.argv[2]);
const orig = World.prototype.tick;
let n = 0;
World.prototype.tick = function (this: World, inp: number[]) {
  const s0 = this.seed;
  orig.call(this, inp);
  if (this.players[0]!.vars[58] === clk && n++ < Number(process.env.N ?? 40)) console.log(n, 'rs', this.roundState, this.players.map((p) => `${p.stateNo}/${p.time}/${p.ctrl ? 1 : 0}/${p.alive ? 'a' : 'd'}`).join(' '), 'seed', this.seed, s0 === this.seed ? '' : 'drew');
};
await runProbe(Number(process.env.TICKS ?? 9000), { char: 'probeai', seed: 937167434, ai: (process.env.AI ?? '4,4').split(',').map(Number) as [number, number] });
