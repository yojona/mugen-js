// Regression against a capture of the original MUGEN 1.1 (tools/harness):
// the probe character's state, tick by tick, must match exactly.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { compareLogs } from '../tools/harness/compare';
import { runProbe } from '../tools/harness/probe-run';

describe('MUGEN 1.1 reference (KFM probe)', () => {
  it('matches the original engine tick by tick', async () => {
    const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'kfm-probe.mugen.log.gz'))).toString('latin1');
    const ours = (await runProbe(1500)).join('\n');
    const r = compareLogs(ref, ours, 10);
    expect(r.compared).toBeGreaterThan(2000);
    expect(r.reports).toEqual([]);
  }, 60_000);

  it('matches the original with Elecbyte kfm720 (720p) as the opponent', async () => {
    // Includes kfm720's own "Diagonal" PosSet in -2: knocked down, it stays
    // stuck in state 5101 at y = -49.5 in the original MUGEN 1.1 too.
    const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'kfm-vs-kfm720.mugen.log.gz'))).toString('latin1');
    const ours = (await runProbe(1300, { char2: 'probe720' })).join('\n');
    const r = compareLogs(ref, ours, 10);
    expect(r.compared).toBeGreaterThan(2000);
    expect(r.reports).toEqual([]);
  }, 60_000);

  it('matches the original camera: tension, centring, pushing and the stage bound', async () => {
    // Scripted probecam scenario (overlay/chars/probe/camscript.st): exercises
    // the eased camera (0.05 of the distance + 0.1, three steps per tick).
    const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'kfm-camera.mugen.log.gz'))).toString('latin1');
    const ours = (await runProbe(470, { char: 'probecam' })).join('\n');
    const r = compareLogs(ref, ours, 10);
    expect(r.compared).toBeGreaterThan(600);
    expect(r.reports).toEqual([]);
  }, 60_000);

  it('matches the original Random sequence, a projectile and a helper', async () => {
    // Scripted probefx scenario (overlay/chars/probe/fxscript.st, fxstates.st).
    // The seed is MUGEN's RNG state at round start in that capture.
    const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'kfm-fx.mugen.log.gz'))).toString('latin1');
    const ours = (await runProbe(500, { char: 'probefx', seed: 937167434 })).join('\n');
    const r = compareLogs(ref, ours, 10);
    expect(r.compared).toBeGreaterThan(600);
    expect(r.reports).toEqual([]);
  }, 60_000);

  it('matches the original supers: SuperPause, afterimages, corner push, mindist', async () => {
    // Scripted probesuper scenario (overlay/chars/probe/superscript.st).
    const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'kfm-supers.mugen.log.gz'))).toString('latin1');
    const ours = (await runProbe(700, { char: 'probesuper', seed: 937167434 })).join('\n');
    const r = compareLogs(ref, ours, 10);
    expect(r.compared).toBeGreaterThan(900);
    expect(r.reports).toEqual([]);
  }, 60_000);

  it('matches the original CPU AI (level 4) against an idle opponent', async () => {
    // P2 is MUGEN's AI (-p2.ai 4); P1 (probeai) only records Random. The AI
    // draws from the shared generator, so this checks its whole decision flow.
    const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'kfm-ai4.mugen.log.gz'))).toString('latin1');
    const ours = (await runProbe(1000, { char: 'probeai', seed: 937167434, ai: [undefined, 4] })).join('\n');
    const r = compareLogs(ref, ours, 10);
    expect(r.compared).toBeGreaterThan(1400);
    expect(r.reports).toEqual([]);
  }, 60_000);

  it('matches the original CPU AI learning, watching and guarding a human', async () => {
    // P1 attacks by keyboard (inputs/aivs.txt) against P2 at AI level 4: the
    // CPU records P1's moves, watches them, guards (AI state 3) and returns.
    const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'kfm-aivs.mugen.log.gz'))).toString('latin1');
    const ours = (await runProbe(1000, { char: 'probeai', inputs: 'aivs', seed: 937167434, ai: [undefined, 4] })).join('\n');
    const r = compareLogs(ref, ours, 10);
    expect(r.compared).toBeGreaterThan(1600);
    expect(r.reports).toEqual([]);
  }, 60_000);

  // Keyboard scenarios (tools/harness/inputs/*.txt), captured with MUGEN
  // running slowly while the harness types the keys.
  for (const [name, ticks, min] of [
    ['basic', 1200, 1600],
    ['moves', 1100, 1500],
    ['push', 700, 900],
    ['guard', 1000, 1100],
    ['liedown', 1100, 1400],
    ['taps', 700, 1000],
    ['slide', 700, 700],
    ['slide2', 700, 600],
  ] as const) {
    it(`matches the original with keyboard input: ${name}.txt`, async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', `kfm-${name}.mugen.log.gz`))).toString('latin1');
      const ours = (await runProbe(ticks, { char: 'probein', inputs: name })).join('\n');
      const r = compareLogs(ref, ours, 10);
      expect(r.compared).toBeGreaterThan(min);
      expect(r.reports).toEqual([]);
    }, 60_000);
  }
});
