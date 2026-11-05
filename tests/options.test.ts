import { describe, expect, it } from 'vitest';
import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_S, IN_U, IN_X, IN_Y, IN_Z } from '../src/engine/cmd';
import { Keyboard, Pad } from '../src/app/input';
import { BROWSER_DEFAULT_KEYS, JOY_NONE, KEY_NONE, KEYBOARD_RELEASE, SDLK_DOWN, SDLK_ESCAPE, SDLK_F1, SDLK_F2, SDLK_F3, SDLK_F4, SDLK_RETURN, SDLK_RIGHT, SDLK_SPACE, SDLK_UP, sdlk } from '../src/app/sdl-keys';
import { parseIni } from '../src/formats/text';
import { GameOptions, OPTIONS_DEFAULTS, OPTIONS_LOAD_SAVE, OPTIONS_STORAGE_KEY, OPTIONS_TIME, pctToVolume, volumeToPct } from '../src/app/game-options';
import { OPTIONS_MENU_INPUT, OPTIONS_MENU_MAIN, OPTIONS_MENU_TEAM, OptionsScreen, keyConfigKeyName, optionsChangeMain, optionsMainValueText, titlePulse } from '../src/app/options';

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

const KEYS_CFG = parseIni(`[P1 Keys]
Jump   = 119
Crouch = 115
[P2 Keys]
Jump   = 273
A      = 260
`);

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

function make(opts = new GameOptions(CFG).init()) {
  const pads = [new Pad(), new Pad()];
  const queue: number[] = [];
  const padQueue: number[] = [];
  const keys = { pads, escape: false, pressed: [] as string[], capture: false, resetQueues() {}, popKey: () => queue.shift() ?? 0, popPad: () => padQueue.shift() ?? 0 };
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
  return { scr, opts, ctx, tick, press, queue, padQueue };
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

describe('key maps', () => {
  const held = () => {
    const target = new EventTarget();
    const kb = new Keyboard(target);
    const send = (type: string, code: string) => target.dispatchEvent(Object.assign(new Event(type), { code }));
    return { kb, send };
  };
  const after = (kb: Keyboard, send: (t: string, c: string) => void, code: string) => {
    send('keydown', code);
    kb.poll();
    const bits = [kb.pads[0]!.bits, kb.pads[1]!.bits];
    send('keyup', code);
    kb.poll();
    return bits;
  };

  it('default play is the fixed maps input.ts always had', () => {
    const { kb, send } = held();
    const old: Record<string, number>[] = [
      { ArrowUp: IN_U, ArrowDown: IN_D, ArrowLeft: IN_L, ArrowRight: IN_R, KeyA: IN_X, KeyS: IN_Y, KeyD: IN_Z, KeyZ: IN_A, KeyX: IN_B, KeyC: IN_C, Enter: IN_S },
      { KeyI: IN_U, KeyK: IN_D, KeyJ: IN_L, KeyL: IN_R, KeyU: IN_X, KeyO: IN_Y, KeyP: IN_Z, KeyM: IN_A, Comma: IN_B, Period: IN_C, Backspace: IN_S },
    ];
    old.forEach((m, side) => {
      for (const [code, bit] of Object.entries(m)) {
        const bits = after(kb, send, code);
        expect(bits[side]).toBe(bit);
        expect(bits[1 - side]).toBe(0);
      }
    });
    expect(after(kb, send, 'KeyW')).toEqual([0, 0]);
  });

  it('GameOptions without saved keys gives the same maps', () => {
    const o = new GameOptions(KEYS_CFG).init();
    expect(o.keys).toEqual(BROWSER_DEFAULT_KEYS);
  });

  it('keysFromCfg reads [P1 Keys] / [P2 Keys] (Options_Load)', () => {
    let maps: number[][] = [];
    const o = new GameOptions(KEYS_CFG, undefined, { keysFromCfg: true, onRemap: (k) => (maps = k) }).init();
    expect(o.keys[0]!.slice(0, 2)).toEqual([119, 115]);
    expect(o.keys[1]![4]).toBe(260);
    expect(o.keys[0]![10]).toBe(KEY_NONE); // missing from the file: unused
    expect(maps).toBe(o.keys);
    const { kb, send } = held();
    kb.setMaps(maps);
    expect(after(kb, send, 'KeyW')).toEqual([IN_U, 0]);
    expect(after(kb, send, 'Numpad4')).toEqual([0, IN_A]);
    expect(after(kb, send, 'ArrowUp')).toEqual([0, IN_U]);
  });

  it('a key both players have drives only P2 (Input_Remap); KEY_NONE drives nothing', () => {
    const { kb, send } = held();
    const p1 = [...BROWSER_DEFAULT_KEYS[0]!];
    const p2 = [...BROWSER_DEFAULT_KEYS[1]!];
    p1[0] = 119;
    p2[0] = 119;
    p1[1] = KEY_NONE;
    kb.setMaps([p1, p2]);
    expect(after(kb, send, 'KeyW')).toEqual([0, IN_U]);
    expect(after(kb, send, 'ArrowUp')).toEqual([0, 0]);
    expect(after(kb, send, 'ArrowDown')).toEqual([0, 0]);
  });

  it('saved keys persist through Save / Load, unused entries as 0', () => {
    const s = memoryStorage();
    let maps: number[][] = [];
    const o = new GameOptions(KEYS_CFG, s, { onRemap: (k) => (maps = k) }).init();
    o.keys[0]![0] = 119;
    o.keys[1]![10] = KEY_NONE;
    o.save();
    const raw = JSON.parse(s.m.get(OPTIONS_STORAGE_KEY)!);
    expect(raw['p1 keys'].jump).toBe('119');
    expect(raw['p2 keys'].start).toBe('0');
    const again = new GameOptions(KEYS_CFG, s, { onRemap: (k) => (maps = k) }).init();
    expect(again.keys[0]![0]).toBe(119);
    expect(again.keys[1]![10]).toBe(KEY_NONE);
    expect(maps).toBe(again.keys);
    // Load drops what was not saved
    again.keys[0]![1] = 97;
    again.load();
    expect(again.keys[0]![1]).toBe(BROWSER_DEFAULT_KEYS[0]![1]);
    expect(again.keys[0]![0]).toBe(119);
  });
});

describe('key config (KeyConfig_Run)', () => {
  /** The input menu with the cursor on "Key Config", which is entered with a button. */
  const open = (opts?: GameOptions) => {
    const m = make(opts);
    m.tick(0, 0, 'F1');
    m.press(IN_X);
    const kc = m.scr.activeKeyConfig!;
    expect(kc).toBeDefined();
    return { ...m, kc };
  };
  /** Queues one key press and its release, and runs the two frames they take. */
  const key = (m: ReturnType<typeof open>, sdl: number) => {
    m.queue.push(sdl);
    m.tick();
    m.queue.push(sdl | KEYBOARD_RELEASE);
    m.tick();
  };

  it('names keys and joystick buttons like KeyConfig_KeyName', () => {
    expect(keyConfigKeyName(false, 106, KEY_NONE)).toBe('j');
    expect(keyConfigKeyName(false, 260, KEY_NONE)).toBe('[4]');
    expect(keyConfigKeyName(false, KEY_NONE, KEY_NONE)).toBe('Not used');
    expect(keyConfigKeyName(true, 9, JOY_NONE)).toBe('A-09');
    expect(keyConfigKeyName(true, 0x21, JOY_NONE)).toBe('B-01');
    expect(keyConfigKeyName(true, JOY_NONE, JOY_NONE)).toBe('Not used');
  });

  it('starts with the configured keys and takes the screen over', () => {
    const { kc, opts, ctx } = open();
    expect(kc.cur).toEqual(opts.keys);
    expect(kc.cur).not.toBe(opts.keys);
    expect(ctx.keys.capture).toBe(true);
  });

  it('Config all fills every entry in order; space disables one; the end returns to browsing', () => {
    const m = open();
    const { kc } = m;
    key(m, SDLK_RETURN);
    expect(kc.state).toBe(1);
    const codes = [...'qwertyuiop'].map(sdlk);
    key(m, codes[0]!);
    key(m, SDLK_SPACE);
    expect(kc.entry).toBe(2);
    expect(kc.cur[0]!.slice(0, 2)).toEqual([codes[0], KEY_NONE]);
    for (let i = 2; i < 11; i++) key(m, sdlk('a') + i);
    expect(kc.state).toBe(0);
    expect(kc.cur[0]![10]).toBe(sdlk('a') + 10);
  });

  it('Escape cancels Config all, restoring the keys; then exits with the sounds and the remap', () => {
    const remaps: number[][][] = [];
    const m = open(new GameOptions(CFG, undefined, { onRemap: (k) => remaps.push(k) }).init());
    const { kc, opts, ctx } = m;
    const before = opts.keys[1]!.slice();
    key(m, SDLK_RIGHT);
    expect(kc.player).toBe(1);
    key(m, SDLK_RETURN);
    expect(kc.state).toBe(2);
    key(m, sdlk('q'));
    expect(kc.cur[1]![0]).toBe(sdlk('q'));
    key(m, SDLK_ESCAPE);
    expect(kc.state).toBe(0);
    expect(kc.cur[1]).toEqual(before);
    const count = remaps.length;
    key(m, SDLK_F2); // straight to Config all of P2
    expect(kc.state).toBe(2);
    key(m, sdlk('q'));
    key(m, SDLK_ESCAPE); // cancels
    m.queue.push(SDLK_ESCAPE); // exits
    m.tick();
    expect(kc.done).toBe(true);
    expect(remaps.length).toBe(count + 1);
    expect(ctx.keys.capture).toBe(false);
    expect(m.scr.activeKeyConfig).toBe(kc); // its last frame is still drawn
    m.tick();
    expect(m.scr.activeKeyConfig).toBeUndefined();
    expect(m.scr.menu).toBe(OPTIONS_MENU_INPUT);
  });

  it('assigned keys reach the options and, through onRemap, the keyboard', () => {
    const target = new EventTarget();
    const kb = new Keyboard(target);
    const m = open(new GameOptions(CFG, undefined, { onRemap: (k) => kb.setMaps(k) }).init());
    key(m, SDLK_F1);
    key(m, sdlk('q'));
    for (let i = 0; i < 10; i++) key(m, SDLK_SPACE);
    key(m, SDLK_ESCAPE);
    expect(m.opts.keys[0]![0]).toBe(sdlk('q'));
    target.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyQ' }));
    kb.poll();
    expect(kb.pads[0]!.bits).toBe(IN_U);
    target.dispatchEvent(Object.assign(new Event('keyup'), { code: 'KeyQ' }));
    target.dispatchEvent(Object.assign(new Event('keydown'), { code: 'ArrowUp' }));
    kb.poll();
    expect(kb.pads[0]!.bits).toBe(0);
  });

  it('the cursor stops on Config all, Default and Exit; F3 / F4 load the Default keys', () => {
    const m = open();
    const { kc } = m;
    key(m, SDLK_DOWN);
    expect(kc.item).toBe(12);
    key(m, SDLK_DOWN);
    expect(kc.item).toBe(13);
    key(m, SDLK_DOWN);
    expect(kc.item).toBe(0);
    key(m, SDLK_UP);
    expect(kc.item).toBe(13);
    key(m, SDLK_F4);
    expect(kc.item).toBe(12);
    expect(kc.player).toBe(1);
    expect(kc.cur[1]).toEqual([...'wsadfghrtyu'].map(sdlk));
    key(m, SDLK_F3);
    expect(kc.cur[0]![4]).toBe(sdlk(','));
  });
});
