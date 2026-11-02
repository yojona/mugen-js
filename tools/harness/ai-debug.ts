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
  if (on) console.log('clock', c, 'state', st0, '->', this.state, 'held', held, 'st', this.p.stateNo, this.p.moveType, 'ctrl', this.p.ctrl, 't', this.p.time, 'cmds', this.cmds.join(','), log.join(' '));
};
await runProbe(1000, { char: 'probeai', inputs, seed: 937167434, ai: [undefined, 4] });
