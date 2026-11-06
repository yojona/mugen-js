import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAir } from '../src/formats/air';
import { parseCharDef } from '../src/formats/chardef';
import { parseSff } from '../src/formats/sff';
import { parseSnd } from '../src/formats/snd';

const REF = join(__dirname, '..', 'ref', 'mugen-1.1b1');
const bin = (p: string) => new Uint8Array(readFileSync(join(REF, p)));
const txt = (p: string) => readFileSync(join(REF, p), 'latin1');

describe('kfm def', () => {
  it('parses files section', () => {
    const d = parseCharDef(txt('chars/kfm/kfm.def'));
    expect(d.name).toBe('Kung Fu Man');
    expect(d.localCoord).toEqual([320, 240]);
    expect(d.files.sprite).toBe('kfm.sff');
    expect(d.files.st).toEqual(['kfm.cns']);
    expect(d.files.stcommon).toBe('common1.cns');
  });
});

describe('air', () => {
  it('parses kfm.air', () => {
    const a = parseAir(txt('chars/kfm/kfm.air'));
    const stand = a.get(0)!;
    expect(stand.elements).toHaveLength(11);
    expect(stand.totalTime).toBe(10 + 7 * 4 + 45 + 7 * 4 + 40);
    expect(stand.elements[0]!.clsn2).toHaveLength(2);
    expect(a.get(5)!.elements[0]!.flipH).toBe(true);
    expect(a.size).toBeGreaterThan(100);
  });
});

describe('sff', () => {
  for (const f of [
    'chars/kfm/kfm.sff',
    'chars/kfm720/kfm720.sff',
    'data/fight.sff',
    'data/system.sff',
    'font/num1.sff',
    'data/fightfx.sff',
  ]) {
    it(`decodes every sprite in ${f}`, async () => {
      const s = await parseSff(bin(f));
      expect(s.sprites.length).toBeGreaterThan(0);
      for (const sp of s.sprites) {
        const px = sp.indices ?? sp.rgba;
        expect(px, `${sp.group},${sp.number}`).toBeDefined();
        expect(px!.length).toBe(sp.width * sp.height * (sp.rgba ? 4 : 1));
      }
    });
  }
  it('kfm standing sprite looks sane', async () => {
    const s = await parseSff(bin('chars/kfm/kfm.sff'));
    const sp = s.get(0, 0)!;
    expect(sp).toBeDefined();
    // Transparent border, opaque body.
    expect(sp.indices![0]).toBe(0);
    const opaque = sp.indices!.filter((v) => v !== 0).length;
    expect(opaque / sp.indices!.length).toBeGreaterThan(0.2);
  });
});

describe('snd + act', () => {
  it('parses kfm.snd', () => {
    const s = parseSnd(bin('chars/kfm/kfm.snd'));
    expect(s.sounds.length).toBeGreaterThan(5);
    for (const x of s.sounds) expect(String.fromCharCode(...x.wav.subarray(0, 4))).toBe('RIFF');
  });
});
