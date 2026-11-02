// Debug helper: run the training dummy (P2) against a keyboard script and
// print its state over time. DUMMY='{"stance":1,"guard":true,...}'.
import { MugenAI } from '../../src/engine/ai';
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const settings = { stance: 0, guard: false, distance: 0, jumpDistance: 0, button: 0, ...JSON.parse(process.env.DUMMY ?? '{}') };
const orig = World.prototype.tick;
const seen = new Map<string, number>();
World.prototype.tick = function (this: World, inp: number[]) {
  const p2 = this.players[1]!;
  if (p2.ai && !p2.ai.dummy) p2.ai.dummy = settings;
  orig.call(this, inp);
  const key = `${p2.stateNo}${p2.stateType}`;
  seen.set(key, (seen.get(key) ?? 0) + 1);
};
void MugenAI;
await runProbe(Number(process.env.TICKS ?? 1000), { char: 'probeai', inputs: process.env.INPUTS ?? 'aivs', seed: 937167434, ai: [undefined, 4] });
console.log(JSON.stringify(settings), [...seen].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}:${n}`).join(' '));
