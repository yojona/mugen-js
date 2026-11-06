// Debug helper: log state changes (with caller) for a clock range.
import { Player } from '../../src/engine/player';
import { runProbe } from './probe-run';
const [from, to, side] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4] ?? 1)];
const orig = Player.prototype.changeState;
Player.prototype.changeState = function (this: Player, no: number, ...rest: unknown[]) {
  const c = this.world.players[0]!.vars[58]!;
  if (c >= from && c <= to && this.side === side) {
    const st = (new Error().stack ?? '').split('\n').slice(2, 5).map((l) => l.trim().replace(/\(.*mugen-web\//, '(')).join(' < ');
    console.log(c, this.stateNo, '->', no, 'face', this.facing, st);
  }
  return (orig as (...a: unknown[]) => void).call(this, no, ...rest);
};
const P = Player.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const origLater = P['enterLater']!;
P['enterLater'] = function (this: Player, no: number) {
  const c = this.world.players[0]!.vars[58]!;
  if (c >= from && c <= to && this.side === side) console.log(c, this.stateNo, '=> later', no, 'face', this.facing, [...this.commands].filter((x) => x.startsWith('hold')).join(' '));
  return origLater.call(this, no);
} as (...a: unknown[]) => unknown;
import { World } from '../../src/engine/world';
const W = World.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const origTurn = W['autoTurn']!;
W['autoTurn'] = function (this: World, p: Player) {
  const f0 = p.facing;
  const r = origTurn.call(this, p);
  const c = this.players[0]!.vars[58]!;
  if (c >= from && c <= to && p.side === side && f0 !== p.facing) console.log(c, 'TURN', p.wx, this.enemyOf(p)?.wx, new Error().stack?.split('\n')[2]?.trim());
  return r;
} as (...a: unknown[]) => unknown;
const ai = (process.env.AI ?? ',4').split(',').map((v) => (v ? Number(v) : undefined)) as [number | undefined, number | undefined];
await runProbe(Number(process.env.TICKS ?? 1500), { char: 'probeai', seed: 937167434, ai });
