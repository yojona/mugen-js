// Debug helper: compare P2's key ring (read/write indices, events, held keys)
// per clock between a MUGEN capture with the ring in PEEKALL columns 9..51
// and our engine; prints the first clocks that differ.
import { readFileSync } from 'node:fs';
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const [refPath, char, seed, ai2] = process.argv.slice(2);
const mugen = new Map<number, number[]>();
let clock = 0;
for (const line of readFileSync(refPath!, 'latin1').split('\n')) {
  const p = line.split('|');
  if (p[0] === 'S' && p[2] === '1') clock = Number(p[3]!.split(',')[58]);
  if (p[0] === 'P' && clock > 0) mugen.set(clock, p[2]!.split(',').slice(8).map(Number));
}
const ours = new Map<number, number[]>();
const orig = World.prototype.tick;
World.prototype.tick = function (this: World, inp: number[]) {
  orig.call(this, inp);
  const c = this.players[0]!.vars[58]!;
  if (c > 0) ours.set(c, this.players[1]!.cmdInput!.debugState());
};
await runProbe(1000, { char: char!, seed: Number(seed), ai: [undefined, ai2 ? Number(ai2) : undefined] });
let shown = 0;
for (const [c, m] of [...mugen].sort((a, b) => a[0] - b[0])) {
  const o = ours.get(c);
  if (!o || o.join() !== m.join()) {
    console.log('clock', c, '\n mugen', m.join(','), '\n ours ', o?.join(','));
    if (++shown >= 3) break;
  }
}
if (!shown) console.log('rings identical');
