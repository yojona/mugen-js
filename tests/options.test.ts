import { describe, expect, it } from 'vitest';
import { IN_D, IN_L, IN_R, IN_X } from '../src/engine/cmd';
import { Pad } from '../src/app/input';
import { parseIni } from '../src/formats/text';
import { GameOptions, OPTIONS_DEFAULTS, OPTIONS_LOAD_SAVE, OPTIONS_STORAGE_KEY, OPTIONS_TIME, pctToVolume, volumeToPct } from '../src/app/game-options';
import { OPTIONS_MENU_INPUT, OPTIONS_MENU_MAIN, OPTIONS_MENU_TEAM, OptionsScreen, optionsChangeMain, optionsMainValueText, titlePulse } from '../src/app/options';

const CFG = parseIni(`[Options]
Difficulty = 4
Life = 100
Time = 99
GameSpeed = 0
Team.1VS2Life = 150
Team.LoseOnKO = 0
[Config]
GameSpeed = 60
[Sound]
MasterVolume = 100
WavVolume = 80
BGMVolume = 75
[Input]
P1.Joystick.type = 0
`);

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

function make(opts = new GameOptions(CFG).init()) {
  const pads = [new Pad(), new Pad()];
  const keys = { pads, escape: false, pressed: [] as string[] };
  const font = { height: 20, spaceWidth: 10, spacing: [1, 0], offset: [0, 0], glyph: () => undefined, palette: () => undefined, trueType: true };
  const ctx = {
    renderer: {},
    mixer: { play() {}, volume: 1 },
    keys,
    aiLevel: 4,
    motif: { value: () => undefined, section: () => undefined, localCoord: [320, 240], backgrounds: new Map(), assets: {}, fonts: [], snd: undefined },
  };
  const scr = new OptionsScreen(ctx as never, font as never, opts);
  const tick = (pad = 0, bit = 0, key?: string) => {
    for (const p of pads) p.latch();
    pads[pad]!.bits = bit;
    keys.escape = key === 'Escape';
    keys.pressed = key && key !== 'Escape' ? [key] : [];
    scr.tick();
    pads[pad]!.bits = 0;
    keys.escape = false;
    keys.pressed = [];
  };
  // a press, then a frame without it (the edge)
  const press = (bit: number, pad = 0) => {
    tick(pad, bit);
    tick();
  };
  return { scr, opts, ctx, tick, press };
}

describe('options values', () => {
  it('Options_ChangeMain: time steps 20..80, 99, none', () => {
    const st = { prompt: false, promptDone: false, promptYes: false };
    const seq: number[] = [];
    let v = 20;
    for (let i = 0; i < 6; i++) {
      seq.push(v);
      v = optionsChangeMain(st, OPTIONS_TIME, v, false, true, false, () => {});
    }
    expect(seq).toEqual([20, 40, 60, 80, 99, -1]);
    expect(optionsChangeMain(st, OPTIONS_TIME, -1, true, false, false, () => {})).toBe(99);
    expect(optionsChangeMain(st, OPTIONS_TIME, 99, true, false, false, () => {})).toBe(80);
  });

  it('value texts', () => {
    expect(optionsMainValueText(0, 4)).toBe('Medium 4');
    expect(optionsMainValueText(0, 2)).toBe('Easy 2');
    expect(optionsMainValueText(3, -3)).toBe('Slow 3');
    expect(optionsMainValueText(4, 101)).toBe('Max');
    expect(optionsMainValueText(5, -1)).toBe('Off');
    expect(optionsMainValueText(2, -1)).toBe('None');
    expect(titlePulse(0, 64, 32)).toBe(32);
    expect(titlePulse(64, 64, 32)).toBe(95);
  });

  it('load: volume percentages from the volumes (100 is Max); defaults keep 100', () => {
    const o = new GameOptions(CFG).init();
    expect(o.main.slice(0, 7)).toEqual([4, 100, 99, 0, 101, 80, 75]);
    o.setDefaults();
    expect(o.main[4]).toBe(100);
    expect(volumeToPct(0)).toBe(-1);
    expect(pctToVolume(50, 80.25)).toBe(50.25);
    expect(o.wavGain).toBeCloseTo(0.8);
  });

  it('save goes to the storage and load reads it back', () => {
    const s = memoryStorage();
    const o = new GameOptions(CFG, s).init();
    o.main[0] = 7;
    o.main[OPTIONS_TIME] = -1;
    o.main[5] = 40;
    o.save();
    expect(JSON.parse(s.m.get(OPTIONS_STORAGE_KEY)!).options.difficulty).toBe('7');
    const again = new GameOptions(CFG, s).init();
    expect(again.difficulty).toBe(7);
    expect(again.time).toBe(-1);
    expect(again.wavVolume).toBe(40);
    // a storage that throws is ignored
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const o2 = new GameOptions(CFG, bad).init();
    expect(o2.difficulty).toBe(4);
    expect(o2.save()).toBe(false);
  });
});

describe('options screen', () => {
  it('changes the difficulty and publishes it as the AI level', () => {
    const { press, opts, ctx } = make();
    press(IN_R);
    press(IN_R);
    expect(opts.difficulty).toBe(6);
    expect(ctx.aiLevel).toBe(6);
  });

  it('F1 / F2 enter the sub-menus, escape returns to the main menu cursor', () => {
    const { scr, tick } = make();
    tick(0, 0, 'F2');
    expect(scr.menu).toBe(OPTIONS_MENU_TEAM);
    tick(0, 0, 'Escape');
    expect(scr.menu).toBe(OPTIONS_MENU_MAIN);
    expect(scr.cursorOf(0)).toBe(8);
    tick(0, 0, 'F1');
    expect(scr.menu).toBe(OPTIONS_MENU_INPUT);
  });

  it('input menu: one cursor per player', () => {
    const { scr, tick, press } = make();
    tick(0, 0, 'F1');
    press(IN_D, 1);
    expect([scr.cursorOf(0), scr.cursorOf(1)]).toEqual([0, 1]);
    // no pads in the browser: the joystick type stays set, unused
    press(IN_R, 1);
    expect(scr['opts'].input[1]![1]).toBe(1);
    expect(scr['opts'].useJoystick[1]).toBe(false);
  });

  it('Default Values asks first; Yes resets', () => {
    const { scr, press, opts } = make();
    press(IN_R); // difficulty 5
    for (let i = 0; i < OPTIONS_DEFAULTS; i++) press(IN_D);
    expect(scr.cursorOf(0)).toBe(OPTIONS_DEFAULTS);
    press(IN_X);
    expect(scr.prompt).toBe(true);
    press(IN_D); // the cursor is held while the prompt shows
    expect(scr.cursorOf(0)).toBe(OPTIONS_DEFAULTS);
    press(IN_R); // Yes
    press(IN_X);
    expect(scr.prompt).toBe(false);
    expect(opts.difficulty).toBe(4);
  });

  it('Load/Save shows a message; Return to Main Menu fades out', () => {
    const { scr, press, tick } = make();
    for (let i = 0; i < OPTIONS_LOAD_SAVE; i++) press(IN_D);
    press(IN_L);
    press(IN_X);
    expect(scr.prompt).toBe(true);
    press(IN_D); // Load/Save lets the cursor move on, closing the message
    expect(scr.prompt).toBe(false);
    press(IN_D); // Return to Main Menu
    press(IN_X);
    for (let i = 0; i < 12 && scr.result === undefined; i++) tick();
    expect(scr.result).toBe(true);
  });
});
