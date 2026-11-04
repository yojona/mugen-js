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
    'Iori (ikaruga) vs EX-Kyo, CPU level 4: the whole match, two rounds to the last win pose frame',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'iori-vs-kyo.mugen.log.gz'))).toString('latin1');
      // -sessionseed 1: the match RNG starts at the first session draw + 1.
      const ours = await peekMatch({ chars: ['iori-yagami-kofa', 'kyo-kofa'], frames: 5000, seed: 16808 });
      // mugen.exe starts the next match on frame 4722; ours ends there.
      expect(ours.length).toBe(4722);
      expect(peekDiff(ref, ours, 14, 4721)).toEqual([]);
    },
    120_000,
  );

  it.skipIf(!have('kim-kofa', 'benimaru-kofa'))(
    'Kim vs Benimaru, CPU level 4: the whole match (AI detector helper, throws, trades, guard ends, camera edges)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'kim-vs-benimaru.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['kim-kofa', 'benimaru-kofa'], frames: 9000, seed: 16808 });
      // mugen.exe starts the next match on frame 8287; ours ends there.
      expect(ours.length).toBe(8287);
      expect(peekDiff(ref, ours, 14, 8286)).toEqual([]);
    },
    120_000,
  );

  it.skipIf(!have('clark-kofa', 'kula-kofa'))(
    'Clark vs Kula, CPU level 4: 9000 frames into round 3 (helper projectiles, juggles, time over, round resets)',
    async () => {
      // Frame 7385 of the capture is a read in the middle of a frame (its RNG
      // value is not a frame's end) and is left out.
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'clark-vs-kula.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['clark-kofa', 'kula-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );

  it.skipIf(!have('athena-kofa', 'leona-kofa'))(
    'Athena vs Leona, CPU level 4: 9000 frames into round 2 (helper projectiles, reversal helpers, throws with snap, pauses)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'athena-vs-leona.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['athena-kofa', 'leona-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );

  it.skipIf(!have('andy-kofa', 'chris-kofa'))(
    'Andy vs Chris, CPU level 4: 9000 frames into round 3 (projectile end animations, landing turns, p2stateno, round resets)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'andy-vs-chris.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['andy-kofa', 'chris-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('billy-kofa', 'daimon-kofa'))(
    'Billy vs Daimon, CPU level 4: 9000 frames (ReversalDef, NumTarget, AI learning across pauses)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'billy-vs-daimon.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['billy-kofa', 'daimon-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('king-kofa', 'joe-kofa'))(
    'King vs Joe, CPU level 4: 9000 frames (projectiles across Pauses, world-space GetHitVar(xvel))',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'king-vs-joe.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['king-kofa', 'joe-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('chang-kofa', 'choi-kofa'))(
    'Chang vs Choi, CPU level 4: 9000 frames (TargetBind from the binder, custom-state commands, no collisions after the round)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'chang-vs-choi.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['chang-kofa', 'choi-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('chin-kofa', 'kensou-kofa'))(
    'Chin vs Kensou, CPU level 4: 9000 frames (HitDef replacing a ReversalDef in the AI records)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'chin-vs-kensou.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['chin-kofa', 'kensou-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('heidern-kofa', 'geese-kofa'))(
    'Heidern vs Geese, CPU level 4: 9000 frames (mid -1 animation elements, deferred hit facings, BindToTarget, projscale)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'heidern-vs-geese.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['heidern-kofa', 'geese-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('d-yashiro-kofa', 'evil-robert-kofa'))(
    'D-Yashiro vs Evil Robert, CPU level 4: 9000 frames (.def ai file, missing states, chain IDs, kill = 0, KO timing, nokoslow)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'yashiro-vs-robert.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['d-yashiro-kofa', 'evil-robert-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('cool-choi-kofa', 'bebum-ryo-kofa'))(
    'Cool Choi vs Bebum Ryo, CPU level 4: the whole match (8006 frames; floor dust on the round state clock)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'choi-vs-ryo.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['cool-choi-kofa', 'bebum-ryo-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(8006);
      expect(peekDiff(ref, ours, 14, 8005)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('kensou-ex-kofa', 'geese-nw-kofa'))(
    'Kensou EX vs Geese NW, CPU level 4: 9000 frames (camera port, screen bounds in Camera_Update, SuperPause unhittable)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'kensouex-vs-geesenw.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['kensou-ex-kofa', 'geese-nw-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('asura-rugal-kofa', 'geo-kensou-kofa'))(
    'Asura Rugal vs Geo Kensou, CPU level 4: the whole match (pause movetime in custom hit states, world-space velocities across turns)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'rugal-vs-kensou.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['asura-rugal-kofa', 'geo-kensou-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(4726);
      expect(peekDiff(ref, ours, 14, 4725)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('chizuru&maki-kofa', 'akuma-kofa'))(
    'Chizuru&Maki vs Akuma, CPU level 4: 9000 frames (helper binds and camera, float helper origins, AnimExist in custom states, element held through the attacker hit pause)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'chizuru-vs-akuma.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['chizuru&maki-kofa', 'akuma-kofa'], frames: 9000, seed: 16808 });
      expect(ours.length).toBe(9000);
      expect(peekDiff(ref, ours, 14, 9000)).toEqual([]);
    },
    120_000,
  );
  it.skipIf(!have('akuma-kofa', 'iori-yagami-kofa'))(
    'Akuma vs Iori, CPU level 4: the whole match, 5231 frames (power frozen once a round is over, nojugglecheck, round start placement)',
    async () => {
      const ref = gunzipSync(readFileSync(join(__dirname, 'reference', 'akuma-vs-iori.mugen.log.gz'))).toString('latin1');
      const ours = await peekMatch({ chars: ['akuma-kofa', 'iori-yagami-kofa'], frames: 5231, seed: 16808 });
      expect(peekDiff(ref, ours, 14, 5231)).toEqual([]);
    },
    120_000,
  );
});
