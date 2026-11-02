// Debug helper: consumed key event, ring state and active commands per tick.
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const [from, to, side] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4] ?? 0)];
const orig = World.prototype.tick;
World.prototype.tick = function (this: World, inp: number[]) {
  orig.call(this, inp);
  const c = this.players[0]!.vars[58]!;
  const p = this.players[side]!;
  const ci = p.cmdInput!;
  if (c >= from && c <= to) console.log(c, p.stateNo, 'ev', ci.lastEvent.toString(16), 'ring', ci.debugState().slice(0, 2).join('/'), 'cmds', [...p.commands].filter((x) => !x.startsWith('hold')).join(' '), 'canrec', p.ghv['fall.recovertime']);
};
const ai = (process.env.AI ?? ',4').split(',').map((v) => (v ? Number(v) : undefined)) as [number | undefined, number | undefined];
await runProbe(Number(process.env.TICKS ?? 1500), { char: 'probeai', seed: 937167434, ai });
