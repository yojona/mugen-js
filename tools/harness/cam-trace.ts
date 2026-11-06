// Debug helper: camera target inputs per clock.
import { World } from '../../src/engine/world';
import { runProbe } from './probe-run';
const [from, to] = [Number(process.argv[2]), Number(process.argv[3])];
const W = World.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const orig = W['cameraTargetX']!;
W['cameraTargetX'] = function (this: World, ps: unknown) {
  const t = orig.call(this, ps) as number;
  const c = this.players[0]!.vars[58]!;
  const w = this as unknown as Record<string, number>;
  if (c >= from && c <= to)
    console.log(
      c,
      'cam',
      this.camera.x.toFixed(4),
      'T',
      t.toFixed(4),
      'xs',
      this.players.map((p) => p.wx.toFixed(3)).join(' '),
      'tension',
      w['tension'],
      'sw',
      w['screenWidth'],
      'sl',
      w['screenLeft'],
      w['screenRight'],
      'bounds',
      w['boundLeft'],
      w['boundRight'],
    );
  return t;
};
const ai = (process.env.AI ?? ',4').split(',').map((v) => (v ? Number(v) : undefined)) as [number | undefined, number | undefined];
await runProbe(Number(process.env.TICKS ?? 1500), { char: 'probeai', seed: 937167434, ai });
