// Debug helper: log the AI's draws per tick around a clock range.
import { MugenAI, setAiDebug } from '../../src/engine/ai';
import { runProbe } from './probe-run';
const [from, to] = [Number(process.argv[2]), Number(process.argv[3])];
const inputs = process.argv[4];
const orig = MugenAI.prototype.tick;
MugenAI.prototype.tick = function (this: MugenAI, f: boolean) {
  const c = this.p.world.players[0]!.vars[58]! + 1; // the clock this tick will show
  const log: string[] = [];
  const on = c >= from && c <= to;
  setAiDebug(on ? log : null);
  const held = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => this.p.cmdInput!.heldAt(k)).join('');
  const st0 = this.state;
  orig.call(this, f);
  const wr = (this as unknown as { watchRec: { stateNo: number; total: { mean: number }; hit: { time: { mean: number } }[] } | null; watching: boolean }).watchRec;
  if (on && wr) log.push(`watch:${wr.stateNo} tot:${wr.total.mean} hits:${wr.hit.map((h) => h.time.mean.toFixed(2)).join('/')}`);
  if (on) console.log('clock', c, 'side', this.p.side, 'face', this.p.facing, 'x', this.p.wx.toFixed(2), 'ex', this.p.world.enemyOf(this.p)?.wx.toFixed(2), 'state', st0, '->', this.state, 'held', held, 'st', this.p.stateNo, this.p.moveType, 'ctrl', this.p.ctrl, 't', this.p.time, 'cmds', this.cmds.join(','), log.join(' '));
};
await runProbe(Number(process.env.TICKS ?? 1000), { char: 'probeai', inputs, seed: 937167434, ai: (process.env.AI ?? ',4').split(',').map((v) => (v ? Number(v) : undefined)) as [number | undefined, number | undefined] });
