import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCharacter, loadCharacterPreview } from '../src/engine/character';
import { nodeSource } from '../src/engine/node-source';
import { Vfs } from '../src/engine/vfs';

const REF = join(__dirname, '..', 'ref', 'mugen-1.1b1');
const PORTRAITS = [[9000, 0], [9000, 1]] as const;

describe('select-screen preview', () => {
  it('portraits and their palettes equal the full load, for every character', async () => {
    const vfs = new Vfs(nodeSource(REF));
    // A fixed sample (every 8th character) keeps the test short with a big pack.
    const chars = readdirSync(join(REF, 'chars'))
      .sort()
      .filter((c, i) => vfs.resolve(`chars/${c}/${c}.def`) && (i % 8 === 0 || c === 'kfm' || c === 'kfm720'));
    expect(chars.length).toBeGreaterThan(0);
    for (const c of chars) {
      const def = `chars/${c}/${c}.def`;
      const [full, prev] = await Promise.all([loadCharacter(vfs, def), loadCharacterPreview(vfs, def, PORTRAITS)]);
      expect(prev.def.displayName, c).toBe(full.def.displayName);
      for (const [g, n] of PORTRAITS) {
        const a = full.sff.get(g, n);
        const b = prev.sff.get(g, n);
        expect(!!b, `${c} ${g},${n}`).toBe(!!a);
        if (!a || !b) continue;
        expect([b.width, b.height, b.axisX, b.axisY], `${c} ${g},${n}`).toEqual([a.width, a.height, a.axisX, a.axisY]);
        expect(b.indices ?? b.rgba, `${c} ${g},${n} pixels`).toEqual(a.indices ?? a.rgba);
        for (let pal = 1; pal <= 12; pal++) expect(prev.paletteFor(b, pal), `${c} ${g},${n} pal ${pal}`).toEqual(full.paletteFor(a, pal));
      }
    }
  }, 120_000);
});
