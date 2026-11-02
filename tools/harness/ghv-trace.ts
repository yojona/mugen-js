// Debug helper: per-tick get-hit vars of one side (recovertime, fall, events).
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const [from, to, side] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4] ?? 1)];
const orig = World.prototype.tick;
World.prototype.tick = function (this: World, inp: number[]) {
  orig.call(this, inp);
  const c = this.players[0]!.vars[58]!;
  const p = this.players[side]!;
  if (c >= from && c <= to) console.log(c, p.stateNo, p.stateType, p.moveType, 'rt', p.ghv.recovertime, 'fall', p.ghv.fall, 'ev', p.cmdInput?.lastEvent.toString(16), 'hp', p.hitPause, 't', p.time);
};
const ai = (process.env.AI ?? ',4').split(',').map((v) => (v ? Number(v) : undefined)) as [number | undefined, number | undefined];
await runProbe(Number(process.env.TICKS ?? 1500), { char: 'probeai', seed: 937167434, ai });
