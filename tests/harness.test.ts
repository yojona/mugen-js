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
});
