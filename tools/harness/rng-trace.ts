import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const [from, to] = [Number(process.argv[2]), Number(process.argv[3])];
const orig = World.prototype.random;
World.prototype.random = function (this: World, n: number) {
  const v = orig.call(this, n);
  const c = this.players[0]!.vars[58]! + 1;
  if (c >= from && c <= to) {
    const st = (new Error().stack ?? '').split('\n').slice(2, 5).map((l) => l.trim().replace(/\(.*mugen-web\//, '(')).join(' < ');
    console.log(c, `%${n}=${v}`, st);
  }
  return v;
};
await runProbe(Number(to) + 300, { char: 'probeai', seed: 937167434, ai: [4, 4] });
