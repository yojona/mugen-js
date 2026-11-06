// Debug helper: report AI passes that think outside RoundState 2.
import { MugenAI } from '../../src/engine/ai';
import { runProbe } from './probe-run';
const orig = MugenAI.prototype.tick;
let shown = 0;
MugenAI.prototype.tick = function (this: MugenAI, f: boolean) {
  const w = this.p.world;
  if (f && w.roundState !== 2 && shown++ < 5)
    console.log(
      'think at rs',
      w.roundState,
      'clock',
      w.players[0]!.vars[58],
      'aiRF',
      (w as unknown as { aiRoundFight: boolean }).aiRoundFight,
    );
  orig.call(this, f);
};
await runProbe(3300, { char: 'probeai', seed: 937167434, ai: [4, 4] });
