import { describe, expect, it } from 'vitest';
import { browserToSdl, sdlKeyName, sdlToBrowser } from '../src/app/sdl-keys';

describe('SDL 1.2 key table', () => {
  it("maps mugen.cfg's codes to browser codes", () => {
    const cases: [number, string][] = [
      [106, 'KeyJ'],
      [119, 'KeyW'],
      [110, 'KeyN'],
      [273, 'ArrowUp'],
      [274, 'ArrowDown'],
      [275, 'ArrowRight'],
      [276, 'ArrowLeft'],
      [260, 'Numpad4'],
      [266, 'NumpadDecimal'],
      [271, 'NumpadEnter'],
      [13, 'Enter'],
      [8, 'Backspace'],
      [48, 'Digit0'],
      [282, 'F1'],
      [296, 'F15'],
      [304, 'ShiftLeft'],
    ];
    for (const [sdl, code] of cases) {
      expect(sdlToBrowser(sdl)).toBe(code);
      expect(browserToSdl(code)).toBe(sdl);
    }
  });

  it('every browser code round-trips', () => {
    for (let sdl = 0; sdl < 323; sdl++) {
      const code = sdlToBrowser(sdl);
      if (code) expect(browserToSdl(code)).toBe(sdl);
    }
  });

  it('keys one side lacks map to undefined', () => {
    expect(sdlToBrowser(321)).toBeUndefined(); // euro
    expect(browserToSdl('Fn')).toBeUndefined();
  });

  it('names follow SDL_GetKeyName', () => {
    expect(sdlKeyName(273)).toBe('up');
    expect(sdlKeyName(106)).toBe('j');
    expect(sdlKeyName(260)).toBe('[4]');
    expect(sdlKeyName(13)).toBe('return');
    expect(sdlKeyName(271)).toBe('enter');
    expect(sdlKeyName(32)).toBe('space');
    expect(sdlKeyName(280)).toBe('page up');
    expect(sdlKeyName(303)).toBe('right shift');
    expect(sdlKeyName(282)).toBe('f1');
    expect(sdlKeyName(321)).toBe('euro');
    expect(sdlKeyName(200)).toBe('unknown key');
  });
});
