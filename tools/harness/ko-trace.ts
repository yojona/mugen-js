// Debug helper: match phase, KO slowdown state and world ticks around the KO.
import { Match } from '../../src/engine/match';
import { runProbe } from './probe-run';
const orig = Match.prototype.tick;
let n = 0;
let on = false;
Match.prototype.tick = function (this: Match) {
  const r = orig.call(this);
  const m = this as unknown as { phase: string; slowRate: number; slowAcc: number; koTicks: number; phaseTime: number };
  if (m.phase === 'ko') on = true;
  if (on && n++ < Number(process.env.N ?? 40))
    console.log(n, m.phase, m.phaseTime, 'run', r, 'rate', m.slowRate, 'acc', m.slowAcc, 'k', m.koTicks);
  return r;
};
await runProbe(3300, { char: 'probeai', seed: 937167434, ai: [4, 4] });
