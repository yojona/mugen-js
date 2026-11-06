import { describe, expect, it } from 'vitest';
import { readBgm } from '../src/audio/music';

const from = (values: Record<string, string>) => (key: string) => values[key];

describe('readBgm', () => {
  it('has no track without a path', () => {
    expect(readBgm(from({}), 'title.bgm')).toBeUndefined();
    expect(readBgm(from({ 'title.bgm': '  ' }), 'title.bgm')).toBeUndefined();
  });

  it('fills the defaults of Bgm_ReadInfoKeys', () => {
    expect(readBgm(from({ 'title.bgm': 'sound/a.mp3' }), 'title.bgm')).toEqual({
      path: 'sound/a.mp3',
      volume: 100,
      loop: true,
      loopStart: -1,
      loopEnd: -1,
    });
  });

  it('reads the parameters, and drops a loop end not after its start', () => {
    const values = { 'a.bgm': 'x.ogg', 'a.bgm.volume': '50', 'a.bgm.loop': '0', 'a.bgm.loopstart': '10', 'a.bgm.loopend': '5' };
    expect(readBgm(from(values), 'a.bgm')).toEqual({ path: 'x.ogg', volume: 50, loop: false, loopStart: 10, loopEnd: -1 });
  });

  it("takes a stage's own key names", () => {
    const keys = { volume: 'bgmvolume', loop: 'bgmloop', start: 'bgmloopstart', end: 'bgmloopend' };
    const values = { bgmusic: 'sound/s.mp3', bgmvolume: '80', bgmloopstart: '100', bgmloopend: '200' };
    expect(readBgm(from(values), 'bgmusic', keys)).toEqual({ path: 'sound/s.mp3', volume: 80, loop: true, loopStart: 100, loopEnd: 200 });
  });
});
