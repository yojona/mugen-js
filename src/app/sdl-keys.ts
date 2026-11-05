// SDL 1.2 key codes, the values mugen.cfg's [P1 Keys] / [P2 Keys] hold and
// KeyConfig_Run assigns, with SDL_GetKeyName's names (SDL_keyboard.c) and the
// KeyboardEvent.code of each key. KeyboardEvent.code names the physical key
// (US layout) while SDL 1.2 reports the layout's character, so on another
// layout a name may differ from the key's label.

/** game.h: "unassigned" in keyboard (KEY_NONE) and joystick (JOY_NONE) maps. */
export const KEY_NONE = 0x200;
export const JOY_NONE = 0x80;
/** keyboard.c KEYBOARD_RELEASE: a queued key code with this bit is a release. */
export const KEYBOARD_RELEASE = 0x200;
/** pads.c PAD_RELEASE: a queued joystick code with this bit is a release. */
export const PAD_RELEASE = 0x100;
export const SDLK_LAST = 323;

export const SDLK_RETURN = 13;
export const SDLK_ESCAPE = 27;
export const SDLK_SPACE = 32;
export const SDLK_UP = 273;
export const SDLK_DOWN = 274;
export const SDLK_RIGHT = 275;
export const SDLK_LEFT = 276;
export const SDLK_F1 = 282;
export const SDLK_F2 = 283;
export const SDLK_F3 = 284;
export const SDLK_F4 = 285;

/** The SDLK_* value of a character key (SDL 1.2 uses ASCII). */
export const sdlk = (ch: string): number => ch.charCodeAt(0);

/** [SDLKey, SDL_GetKeyName, KeyboardEvent.code when a browser reports that key]. */
const KEYS: [number, string, string?][] = [
  [8, 'backspace', 'Backspace'],
  [9, 'tab', 'Tab'],
  [12, 'clear'],
  [13, 'return', 'Enter'],
  [19, 'pause', 'Pause'],
  [27, 'escape', 'Escape'],
  [32, 'space', 'Space'],
  [33, '!'],
  [34, '"'],
  [35, '#'],
  [36, '$'],
  [38, '&'],
  [39, "'", 'Quote'],
  [40, '('],
  [41, ')'],
  [42, '*'],
  [43, '+'],
  [44, ',', 'Comma'],
  [45, '-', 'Minus'],
  [46, '.', 'Period'],
  [47, '/', 'Slash'],
  [58, ':'],
  [59, ';', 'Semicolon'],
  [60, '<', 'IntlBackslash'],
  [61, '=', 'Equal'],
  [62, '>'],
  [63, '?'],
  [64, '@'],
  [91, '[', 'BracketLeft'],
  [92, '\\', 'Backslash'],
  [93, ']', 'BracketRight'],
  [94, '^'],
  [95, '_'],
  [96, '`', 'Backquote'],
  [127, 'delete', 'Delete'],
  [266, '[.]', 'NumpadDecimal'],
  [267, '[/]', 'NumpadDivide'],
  [268, '[*]', 'NumpadMultiply'],
  [269, '[-]', 'NumpadSubtract'],
  [270, '[+]', 'NumpadAdd'],
  [271, 'enter', 'NumpadEnter'],
  [272, 'equals', 'NumpadEqual'],
  [273, 'up', 'ArrowUp'],
  [274, 'down', 'ArrowDown'],
  [275, 'right', 'ArrowRight'],
  [276, 'left', 'ArrowLeft'],
  [277, 'insert', 'Insert'],
  [278, 'home', 'Home'],
  [279, 'end', 'End'],
  [280, 'page up', 'PageUp'],
  [281, 'page down', 'PageDown'],
  [300, 'numlock', 'NumLock'],
  [301, 'caps lock', 'CapsLock'],
  [302, 'scroll lock', 'ScrollLock'],
  [303, 'right shift', 'ShiftRight'],
  [304, 'left shift', 'ShiftLeft'],
  [305, 'right ctrl', 'ControlRight'],
  [306, 'left ctrl', 'ControlLeft'],
  [307, 'right alt', 'AltRight'],
  [308, 'left alt', 'AltLeft'],
  [309, 'right meta', 'MetaRight'],
  [310, 'left meta', 'MetaLeft'],
  [311, 'left super'],
  [312, 'right super'],
  [313, 'alt gr'],
  [314, 'compose'],
  [315, 'help', 'Help'],
  [316, 'print screen', 'PrintScreen'],
  [317, 'sys req'],
  [318, 'break'],
  [319, 'menu', 'ContextMenu'],
  [320, 'power'],
  [321, 'euro'],
  [322, 'undo'],
];
for (let i = 0; i < 10; i++) {
  KEYS.push([48 + i, `${i}`, `Digit${i}`]); // SDLK_0..9
  KEYS.push([256 + i, `[${i}]`, `Numpad${i}`]); // SDLK_KP0..9
}
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(97 + i);
  KEYS.push([97 + i, ch, `Key${ch.toUpperCase()}`]); // SDLK_a..z
}
for (let i = 0; i < 15; i++) KEYS.push([282 + i, `f${i + 1}`, `F${i + 1}`]); // SDLK_F1..15

const NAMES = new Map(KEYS.map(([sdl, name]) => [sdl, name]));
const TO_BROWSER = new Map(KEYS.filter((k) => k[2]).map(([sdl, , code]) => [sdl, code!]));
const TO_SDL = new Map(KEYS.filter((k) => k[2]).map(([sdl, , code]) => [code!, sdl]));

/** KeyboardEvent.code of an SDL key; undefined when browsers have no such key. */
export function sdlToBrowser(sdl: number): string | undefined {
  return TO_BROWSER.get(sdl);
}

/** SDL key of a KeyboardEvent.code; undefined for a key SDL 1.2 has no code for. */
export function browserToSdl(code: string): number | undefined {
  return TO_SDL.get(code);
}

/** SDL_GetKeyName. */
export function sdlKeyName(sdl: number): string {
  return NAMES.get(sdl) ?? 'unknown key';
}

/**
 * The browser port's keys when nothing was saved: the fixed maps input.ts
 * always had (P1 arrows, A S D / Z X C, Enter; P2 I J K L, U O P / M , .,
 * Backspace), by key configuration entry (up, down, left, right, a, b, c, x,
 * y, z, start). See GameOptions.keysFromCfg for why not mugen.cfg's.
 */
export const BROWSER_DEFAULT_KEYS: readonly (readonly number[])[] = [
  [SDLK_UP, SDLK_DOWN, SDLK_LEFT, SDLK_RIGHT, sdlk('z'), sdlk('x'), sdlk('c'), sdlk('a'), sdlk('s'), sdlk('d'), SDLK_RETURN],
  [sdlk('i'), sdlk('k'), sdlk('j'), sdlk('l'), sdlk('m'), sdlk(','), sdlk('.'), sdlk('u'), sdlk('o'), sdlk('p'), 8],
];
