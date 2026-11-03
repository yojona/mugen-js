// Community characters against captures of the original mugen.exe (NOPROBE
// runs of tools/harness/drive.py). The characters themselves are not in the
// repository: these tests run only where ref/mugen-1.1b1/chars has them.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { peekDiff, peekMatch, REF_DIR } from '../tools/harness/peek-run';

const have = (...chars: string[]) => chars.every((c) => existsSync(join(REF_DIR, 'chars', c)));

describe('community characters vs mugen.exe', () => {
  it.skipIf(!have('iori-yagami-kofa', 'kyo-kofa'))(
    'Iori (ikaruga) vs EX-Kyo, CPU level 4: the whole first round, KO and win pose',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'iori-vs-kyo.mugen.log.gz'))).toString('latin1');
      // -sessionseed 1: the match RNG starts at the first session draw + 1.
      const ours = await peekMatch({ chars: ['iori-yagami-kofa', 'kyo-kofa'], frames: 2343, seed: 16808 });
      expect(ours.length).toBe(2343);
      expect(peekDiff(ref, ours, 14, 2343)).toEqual([]);
    },
    120_000,
  );
});
