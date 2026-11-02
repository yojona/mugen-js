// Debug helper: compare P2's AI watch state with a PEEKALL capture made by
// dbgcap (cols: state, statetime, seed, watching, watchtime, cooldown,
// total, hit0..2 as float bits).
import { readFileSync } from 'node:fs';
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const [refPath, lv] = process.argv.slice(2);
const f = (i: number) => new Float32Array(new Int32Array([i]).buffer)[0]!;
const ref = new Map<number, number[]>();
let clock = 0;
for (const line of readFileSync(refPath!, 'latin1').split('\n')) {
  const p = line.split('|');
  if (p[0] === 'S' && p[2] === '1') clock = Number(p[3]!.split(',')[58]);
  if (p[0] === 'P' && clock > 0) ref.set(clock, p[2]!.split(',').map(Number));
}
const orig = World.prototype.tick;
let shown = 0;
World.prototype.tick = function (this: World, inp: number[]) {
  orig.call(this, inp);
  const c = this.players[0]!.vars[58]!;
  const r = ref.get(c);
  const ai = this.players[1]!.ai as unknown as { state: number; stateTime: number; watching: boolean; watchTime: number; cooldown: number; watchRec: { total: { mean: number }; hit: { time: { mean: number } }[] } | null };
  if (!r || !ai || shown > 8) return;
  const ours = [ai.state, ai.stateTime, ai.watching ? 1 : 0, ai.watchTime, ai.cooldown];
  const theirs = [r[0], r[1], r[3], r[4], r[5]];
  const recO = ai.watchRec ? [ai.watchRec.total.mean, ...ai.watchRec.hit.map((h) => h.time.mean)].map((x) => x.toFixed(2)).join('/') : '-';
  const recT = [r[6], r[7], r[8], r[9]].map((x) => f(x!).toFixed(2)).join('/');
  const watchingBoth = ours[2] === 1 && theirs[2] === 1;
  if (ours.some((v, i) => v !== theirs[i]) || (watchingBoth && recO !== recT)) {
    console.log(c, 'ours', ours.join(','), recO, '| mugen', theirs.join(','), recT);
    shown++;
  }
};
await runProbe(3000, { char: 'probeai', seed: 937167434, ai: [Number(lv), Number(lv)] });
