// The options screen (mugen.exe title.c, Options_* at 0x429CB0-0x42BA00):
// a panel of plain rectangles over [OptionBGdef], drawn in game pixels
// (g_targetWidth x g_targetHeight) with font/options.def, with the main
// menu and its two sub-menus (input config: one column per player; team
// mode config), and the key configuration (KeyConfig_Run). The values live in
// GameOptions (GameVars 0x12C00..).

import { IN_D, IN_L, IN_R, IN_S, IN_U } from '../engine/cmd';
import { ElementInstance, drawText, parseElement } from '../motif/element';
import { textWidth, type Font } from '../motif/font';
import type { Renderer } from '../render/renderer';
import {
  OPTIONS_BGM_VOLUME,
  OPTIONS_DEFAULTS,
  OPTIONS_DIFFICULTY,
  OPTIONS_GAME_SPEED,
  OPTIONS_INPUT_CONFIG,
  OPTIONS_LIFE,
  OPTIONS_LOAD_SAVE,
  OPTIONS_MAIN_COUNT,
  OPTIONS_MASTER_VOLUME,
  OPTIONS_RETURN,
  OPTIONS_TEAM_CONFIG,
  OPTIONS_TIME,
  OPTIONS_WAV_VOLUME,
  type GameOptions,
} from './game-options';
import { BUTTONS } from './input';
import {
  JOY_NONE,
  KEY_NONE,
  KEYBOARD_RELEASE,
  PAD_RELEASE,
  SDLK_DOWN,
  SDLK_ESCAPE,
  SDLK_F1,
  SDLK_F2,
  SDLK_F3,
  SDLK_F4,
  SDLK_LAST,
  SDLK_LEFT,
  SDLK_RETURN,
  SDLK_RIGHT,
  SDLK_SPACE,
  SDLK_UP,
  sdlk,
  sdlKeyName,
} from './sdl-keys';
import { fader, MotifBackground, motifSound, type AppContext, type Fader, type Screen } from './screen';

/** OptionsState.menu (OPTIONS_MENU_*). */
export const OPTIONS_MENU_MAIN = 0;
export const OPTIONS_MENU_TEAM = 1;
export const OPTIONS_MENU_INPUT = 2;

/** ScreenLoop.input bits (select.h SCREEN_IN_*) and TITLE_IN_BUTTONS. */
const SCREEN_IN_UP = 0x001;
const SCREEN_IN_RIGHT = 0x002;
const SCREEN_IN_DOWN = 0x004;
const SCREEN_IN_LEFT = 0x008;
const TITLE_IN_BUTTONS = 0xff0;

/** FONT_ALIGN_*: left edge at x, centred on x, right edge at x. */
const ALIGN_LEFT = 1;
const ALIGN_CENTER = 0;
const ALIGN_RIGHT = -1;

/** The game's pixel size (mugen.cfg GameWidth x GameHeight; 640x480 like the rest of the app). */
export const OPTIONS_GAME_SIZE: [number, number] = [640, 480];

/** Options_GetFont (0x429CB0): font/options.def is loaded at this height. */
export function optionsFontHeight(gameHeight: number): number {
  return gameHeight > 240 ? Math.trunc((gameHeight * 10) / 240) : 10;
}

/** Title_Pulse: brightness of a blinking cursor bar for a tick count (a triangle wave). */
export function titlePulse(t: number, period: number, base: number): number {
  if (t % (period * 2) < period) return (t % period) + base;
  return base + period - 1 - (t % period);
}

/**
 * Options_ChangeMain: left / right on a main menu item. `prompt` is
 * OptionsState.prompt before this frame's input; `st` the prompt state the
 * Load/Save and Default Values items close (setDefaults runs on Yes).
 */
export function optionsChangeMain(
  st: { prompt: boolean; promptDone: boolean; promptYes: boolean },
  item: number,
  v: number,
  left: boolean,
  right: boolean,
  prompt: boolean,
  setDefaults: () => void,
): number {
  switch (item) {
    case OPTIONS_DIFFICULTY:
      if (left && v > 1) v--;
      if (right && v < 8) v++;
      break;
    case OPTIONS_LIFE:
      if (left && v > 30) v -= 10;
      if (right && v < 300) v += 10;
      break;
    case OPTIONS_TIME:
      // 20, 40, 60, 80, 99, none (-1)
      if (left) {
        if (v > 20) v = v === 99 ? 80 : v - 20;
        else if (v === 99) v = 80;
        else if (v === -1) v = 99;
      }
      if (right) {
        if (v < 80 && v !== -1) v += 20;
        else if (v === 80) v = 99;
        else if (v === 99) v = -1;
      }
      break;
    case OPTIONS_GAME_SPEED:
      if (left && v > -9) v--;
      if (right && v < 9) v++;
      break;
    case OPTIONS_MASTER_VOLUME:
    case OPTIONS_WAV_VOLUME:
    case OPTIONS_BGM_VOLUME:
      // -1 off .. 101 max
      if (left && v > -1) v--;
      if (right && v < 101) v++;
      break;
    case OPTIONS_LOAD_SAVE:
      if (left) v = 0;
      if (right) v = 1;
      if (prompt && st.promptDone) {
        // the "Options Loaded/Saved" message was confirmed
        st.prompt = false;
        st.promptDone = false;
      }
      break;
    case OPTIONS_DEFAULTS:
      if (prompt && st.promptDone) {
        // Quirk kept: the slot's old value is written back after
        // Options_SetDefaults (the slot holds no option).
        if (st.promptYes) setDefaults();
        st.prompt = false;
        st.promptDone = false;
      }
      break;
  }
  return v;
}

/** Options_MainValueText: value text of a main menu item ('' for the others). */
export function optionsMainValueText(item: number, v: number): string {
  switch (item) {
    case OPTIONS_DIFFICULTY:
      return `${v < 3 ? 'Easy' : v > 5 ? 'Hard' : 'Medium'} ${v}`;
    case OPTIONS_LIFE:
      return `${v}%`;
    case OPTIONS_TIME:
      return v !== -1 ? `${v}` : 'None';
    case OPTIONS_GAME_SPEED:
      return v === 0 ? 'Normal' : v > 0 ? `Fast ${v}` : `Slow ${-v}`;
    case OPTIONS_MASTER_VOLUME:
    case OPTIONS_WAV_VOLUME:
    case OPTIONS_BGM_VOLUME:
      return v === -1 ? 'Off' : v === 101 ? 'Max' : `${v}`;
    case OPTIONS_LOAD_SAVE:
      return v === 0 ? 'Load' : 'Save';
  }
  return '';
}

/** Options_JoystickText: the joystick type ('' for an unknown one). */
export function optionsJoystickText(v: number): string {
  if (v === 0) return 'Disabled';
  if (v === 1) return 'Enabled';
  if (v >= 4 && v <= 8) return `${v} button`;
  return { 20: 'Sidewinder', 21: 'SNESKey', 22: 'PSX Pad', 23: 'N64 Pad' }[v] ?? '';
}

/** Options_Hint: the key hint drawn right-aligned after an item. */
export function optionsHint(menu: number, col: number, item: number): string | undefined {
  if (menu === OPTIONS_MENU_MAIN) {
    if (item === OPTIONS_INPUT_CONFIG) return '(F1)';
    if (item === OPTIONS_TEAM_CONFIG) return '(F2)';
    if (item === OPTIONS_RETURN) return '(Esc)';
  } else if (menu === OPTIONS_MENU_INPUT) {
    if (col === 1) {
      if (item === 0) return '(F1)';
      if (item === 2) return '(F2)';
      if (item === 4) return '(Esc)';
    }
  } else if (menu === OPTIONS_MENU_TEAM && item === 3) return '(Esc)';
  return undefined;
}

/** Options_HasGap: a blank row comes before the item. */
export function optionsHasGap(menu: number, item: number): boolean {
  switch (menu) {
    case OPTIONS_MENU_MAIN:
      return item === OPTIONS_RETURN || item === OPTIONS_LOAD_SAVE;
    case OPTIONS_MENU_INPUT:
      return item === 0 || item === 3 || item === 1;
    case OPTIONS_MENU_TEAM:
      return item === 3;
  }
  return false;
}

const MAIN_ITEMS = [
  'Difficulty',
  'Life',
  'Time Limit',
  'Game Speed',
  'Master Volume',
  'Wave/SFX Volume',
  'BGM Volume',
  'Input Config',
  'Team Mode Config',
  'Load/Save',
  'Default Values',
  'Return to Main Menu',
];
const INPUT_ITEMS = ['Key Config', 'Joystick', 'Joystick Config', 'Default Values', 'Return to Options'];
const TEAM_ITEMS = ['Single VS Simul Advantage', 'If player KOed', 'Default Values', 'Return to Options'];
/** OptionsState.menus by OPTIONS_MENU_*. */
const MENUS = [MAIN_ITEMS, TEAM_ITEMS, INPUT_ITEMS];

type Rgb = [number, number, number];

/**
 * Font_DrawText (0x46D...; Font_DrawLines): (x, y) is the baseline; a
 * right-aligned line starts at x - width + 1, a centred one at x - width *
 * 0.5 (truncated). r, g, b multiply the glyphs in 1/256 (0x100 unchanged);
 * a TrueType line is rendered whole in that colour (clamped to 0xFF) and
 * measured without the font's spacing.
 */
export function fontDrawText(r: Renderer, font: Font, text: string, x: number, y: number, align: number, rgb: Rgb): void {
  if (!text) return;
  if (!font.trueType) {
    const w = textWidth(font, text);
    const x0 = align === ALIGN_LEFT ? x : align === ALIGN_RIGHT ? x - w + 1 : Math.trunc(x - w * 0.5);
    drawText(r, font, text, x0, y, 0, ALIGN_LEFT, [1, 1], rgb.map((c) => (c * 255) / 256) as Rgb);
    return;
  }
  // Glyphs at the advances of the string's prefixes (the browser lays the line out as SDL_ttf would).
  const advance = (t: string) => (font.measure ? Math.round(font.measure(t)) : [...t].reduce((a, ch) => a + (font.glyph(ch)?.width ?? font.spaceWidth), 0));
  const w = advance(text);
  const x0 = Math.trunc(align === ALIGN_LEFT ? x : align === ALIGN_RIGHT ? x - w + 1 : x - w * 0.5) + font.offset[0];
  const mul = rgb.map((c) => Math.min(c, 0xff) / 255) as Rgb;
  const palfx = { add: [0, 0, 0] as Rgb, mul, color: 1, invertAll: false };
  const top = y - font.height + font.offset[1];
  let prefix = '';
  for (const ch of text) {
    const g = font.glyph(ch);
    if (g) r.draw({ sprite: g.sprite, x: x0 + advance(prefix), y: top, scaleX: 1, scaleY: 1, palfx });
    prefix += ch;
  }
}

/** The renderer's rectangles take inclusive corners in any order (Prim_ClipRect). */
function fillRect(r: Renderer, x1: number, y1: number, x2: number, y2: number, rgb: Rgb, blend?: 'add' | 'sub'): void {
  const b = blend === 'add' ? ({ kind: 'add', src: 256, dst: 256 } as const) : blend === 'sub' ? ({ kind: 'sub' } as const) : undefined;
  r.rect(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2) + 1, Math.max(y1, y2) + 1, [rgb[0], rgb[1], rgb[2], 255], b);
}

/** title.c KEYCONFIG_*: up, down, left, right, a, b, c, x, y, z, start between "Config all" and "Default", then "Exit". */
const KEYCONFIG_ENTRIES = 11;
const KEYCONFIG_ITEMS = 14;
const KEYCONFIG_DEFAULT = 12;
const KEYCONFIG_EXIT = 13;
const KEYCONFIG_NAMES = ['Config all', 'Up', 'Down', 'Left', 'Right', 'A', 'B', 'C', 'X', 'Y', 'Z', 'Start', 'Default', 'Exit'];
/** .rdata 0x4F2038: the "Default" keys of each player (not mugen.cfg's, nor the browser's). */
const KEYCONFIG_DEFAULT_KEYS = [
  [SDLK_UP, SDLK_DOWN, SDLK_LEFT, SDLK_RIGHT, sdlk(','), sdlk('.'), sdlk('/'), sdlk('l'), sdlk(';'), sdlk("'"), SDLK_RETURN],
  [...'wsadfghrtyu'].map(sdlk),
];
/** .rdata 0x4F2090: the "Default" joystick buttons of each player (pad << 5 | button). */
const KEYCONFIG_DEFAULT_JOY = [
  [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b],
  [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b],
];

/** KeyConfig_KeyName: the name of a configured key or joystick button. */
export function keyConfigKeyName(joystick: boolean, v: number, none: number): string {
  if (v === none) return 'Not used';
  if (!joystick) return v < SDLK_LAST ? sdlKeyName(v) : '';
  return `${String.fromCharCode(65 + ((v >> 5) & 3))}-${String(v & ~0x60).padStart(2, '0')}`;
}

/**
 * KeyConfig_Run (0x42BA60): the key (joystick = false) or joystick button
 * (true) configuration of both players over the options background. The
 * original runs its own 60 fps loop inside Options_Update; here OptionsScreen
 * hands it its frames. It reads the raw key and pad queues, one code of each
 * per frame (a key's release uses up a frame too).
 * Not ported: Alt+Enter (Video_HandleFullscreenKey) and g_quitRequested.
 */
export class KeyConfig {
  /** The frames counter, shared with the options screen (the cursor's blink). */
  ticks: number;
  /** Set on the frame "Exit" was chosen: that frame is still drawn. */
  done = false;
  /** 0 browsing, 1 or 2: assigning the entries of that player. */
  state = 0;
  /** Column of the cursor. */
  player = 0;
  item = 0;
  /** Next entry to assign. */
  entry = 0;
  readonly cur: number[][];
  private backup: number[][] = [[], []];
  private none: number;

  constructor(
    private ctx: AppContext,
    private font: Font,
    private opts: GameOptions,
    private bg: MotifBackground,
    private joystick: boolean,
    ticks: number,
  ) {
    this.ticks = ticks;
    this.none = joystick ? JOY_NONE : KEY_NONE;
    this.cur = (joystick ? opts.joyKeys : opts.keys).map((k) => [...k]);
    ctx.keys.resetQueues();
    ctx.keys.capture = true;
  }

  tick(): void {
    this.ticks++;
    const keys = this.ctx.keys;
    let key = keys.popKey();
    let pad = keys.popPad();
    const button = pad & ~0x60;
    let accept = key === SDLK_RETURN || (button >= 5 && button <= 31);
    let up = key === SDLK_UP || button === 1;
    let down = key === SDLK_DOWN || button === 2;
    let left = key === SDLK_LEFT || button === 3;
    let right = key === SDLK_RIGHT || button === 4;
    if (this.state !== 0) up = down = left = right = accept = false;
    if (key === SDLK_F1 || key === SDLK_F2) {
      this.player = key !== SDLK_F1 ? 1 : 0;
      this.item = 0;
      accept = true;
    }
    if (key === SDLK_F3 || key === SDLK_F4) {
      this.player = key !== SDLK_F3 ? 1 : 0;
      this.item = KEYCONFIG_DEFAULT;
      accept = true;
    }
    if (key === SDLK_ESCAPE && this.state === 0) {
      this.item = KEYCONFIG_EXIT;
      accept = true;
    }
    if (key === SDLK_ESCAPE && this.state !== 0) {
      // cancel "Config all"
      this.item = 0;
      accept = false;
      this.state = 0;
      this.cur[this.player] = [...this.backup[this.player]!];
    }
    // The cursor only stops on "Config all", "Default" and "Exit".
    if (up) {
      if (this.item <= 0) this.item = KEYCONFIG_EXIT;
      else {
        this.item--;
        if (this.item >= 1 && this.item < KEYCONFIG_DEFAULT) this.item = 0;
      }
    }
    if (down) {
      if (this.item >= KEYCONFIG_EXIT) this.item = 0;
      else {
        this.item++;
        if (this.item >= 1 && this.item <= 11) this.item = KEYCONFIG_DEFAULT;
      }
    }
    if (left) this.player = 0;
    if (right) this.player = 1;
    if (accept && this.item === 0) {
      // "Config all": the following key presses fill the entries
      this.backup[this.player] = [...this.cur[this.player]!];
      this.state = this.player + 1;
      this.entry = 0;
      key = 0;
      pad = 0;
    } else if (this.item === KEYCONFIG_DEFAULT && accept) {
      this.cur[this.player] = [...(this.joystick ? KEYCONFIG_DEFAULT_JOY : KEYCONFIG_DEFAULT_KEYS)[this.player]!];
    }
    if (this.state !== 0 && key !== SDLK_ESCAPE) {
      let assigned = true;
      const target = this.cur[this.state - 1]!;
      if (!this.joystick && key !== 0 && !(key & KEYBOARD_RELEASE)) target[this.entry] = key === SDLK_SPACE ? this.none : key;
      else if (this.joystick && pad !== 0 && !(pad & PAD_RELEASE)) target[this.entry] = key === SDLK_SPACE ? this.none : pad;
      else if (key === SDLK_SPACE) target[this.entry] = this.none;
      else assigned = false;
      if (assigned && ++this.entry >= KEYCONFIG_ENTRIES) this.state = 0;
    }
    this.bg.tick();
    if (accept && this.item === KEYCONFIG_EXIT) this.finish();
  }

  /** The end of KeyConfig_Run: the map takes the new values, then Input_Remap. */
  private finish(): void {
    const o = this.opts;
    if (this.joystick) o.joyKeys = this.cur;
    else o.keys = this.cur;
    o.remap();
    this.ctx.keys.capture = false;
    this.done = true;
  }

  draw(): void {
    const r = this.ctx.renderer;
    const [mw, mh] = this.ctx.motif.localCoord;
    r.setProjection(mw, mh);
    this.bg.drawBack();
    this.drawPanel(r);
    r.setProjection(mw, mh);
    this.bg.drawFront();
  }

  private drawPanel(r: Renderer): void {
    const [W, H] = OPTIONS_GAME_SIZE;
    r.setProjection(W, H);
    const font = this.font;
    const lineH = font.spacing[1] + font.height;
    const charW = font.spacing[0] + font.spaceWidth;
    const lineGap = Math.trunc(lineH / 6);
    const rowH = lineGap + lineH;
    const boxH = rowH * 16 + lineH;
    const valueX = charW * 14;
    const boxW = charW * 32;
    const boxX = Math.trunc((W - boxW) / 2);
    const halfW = Math.trunc(boxW / 2);
    const boxY = lineH + 40;
    const colX = halfW + 15;
    const { joystick, none, state, player, item, entry, cur, ticks } = this;

    const x2 = boxX + boxW + 15;
    const y2 = boxY + boxH;
    const bgColor: Rgb = [0x80, 0x60, 0x40];
    const border: Rgb = [0x40, 0x30, 0x20];
    fillRect(r, boxX - 15, boxY - 14, x2 - 1, y2 - 1, bgColor, 'sub');
    fillRect(r, boxX - 16, boxY - 13, boxX - 16, y2 - 2, border, 'sub');
    fillRect(r, x2, boxY - 13, x2, y2 - 2, border, 'sub');
    fillRect(r, boxX - 14, boxY - 15, x2 - 2, boxY - 15, border, 'sub');
    fillRect(r, boxX - 14, y2, x2 - 2, y2, border, 'sub');

    fontDrawText(r, font, joystick ? 'JOYSTICK CONFIG' : 'KEY CONFIG', Math.trunc(W / 2), boxY - 30, ALIGN_CENTER, [0x100, 0x100, 0x100]);
    const py = boxY - lineGap + lineH;
    fontDrawText(r, font, 'PLAYER 1', Math.trunc(boxW / 4) + boxX, py, ALIGN_CENTER, [0x80, 0x100, 0x100]);
    fontDrawText(r, font, 'PLAYER 2', Math.trunc((boxW * 3) / 4) + boxX, py, ALIGN_CENTER, [0x100, 0x80, 0x80]);
    const help = ticks % 450 < 150 ? 'Press a key to assign to entry' : ticks % 450 < 300 ? 'Press spacebar to disable entry' : 'Press esc to cancel';
    const helpY = rowH * 15 + boxY + lineH;
    if (state === 1) fontDrawText(r, font, help, boxX, helpY, ALIGN_LEFT, [0xc0, 0xc0, 0xc0]);
    else if (state === 2) fontDrawText(r, font, help, boxX + boxW, helpY, ALIGN_RIGHT, [0xc0, 0xc0, 0xc0]);

    const pulse = titlePulse(ticks * 4, 64, 32);
    const hintColor: Rgb = [0x100, 0x100, 0x80];
    let gaps = 0;
    for (let i = 0; i < KEYCONFIG_ITEMS; i++) {
      let label: Rgb = [0xc0, 0xc0, 0xc0]; // player 1
      let value: Rgb = [0xc0, 0xc0, 0xc0]; // player 2
      if (i === KEYCONFIG_DEFAULT || i === 0) gaps++;
      const y = (i + gaps) * rowH + boxY + lineH;
      if (i === item) {
        const c: Rgb = state === 0 ? [pulse, pulse, pulse] : [0x60, 0x60, 0x60];
        const x = i < KEYCONFIG_EXIT ? player * colX + boxX : boxX;
        fillRect(r, x - 5, y - lineH, x + halfW - 15, y + lineGap, c, 'add');
        if (player !== 0 && item !== KEYCONFIG_EXIT) value = [0xf8, 0x100, 0x100];
        else label = [0xf8, 0x100, 0x100];
      }
      if (i > 11 && state !== 0) break; // "Default" and "Exit" are hidden while assigning
      fontDrawText(r, font, KEYCONFIG_NAMES[i]!, boxX, y, ALIGN_LEFT, label);
      if (i <= KEYCONFIG_DEFAULT) fontDrawText(r, font, KEYCONFIG_NAMES[i]!, boxX + colX, y, ALIGN_LEFT, value);
      let hint: string | undefined;
      if (i === 0) {
        fontDrawText(r, font, '(F1)', boxX + valueX, y, ALIGN_RIGHT, hintColor);
        hint = '(F2)';
      } else if (i === KEYCONFIG_DEFAULT) {
        fontDrawText(r, font, '(F3)', boxX + valueX, y, ALIGN_RIGHT, hintColor);
        hint = '(F4)';
      } else if (i === KEYCONFIG_EXIT) {
        fontDrawText(r, font, '(Esc)', boxX + valueX, y, ALIGN_RIGHT, hintColor);
      } else {
        fontDrawText(r, font, keyConfigKeyName(joystick, cur[0]![i - 1]!, none), boxX + valueX, y, ALIGN_RIGHT, label);
        fontDrawText(r, font, keyConfigKeyName(joystick, cur[1]![i - 1]!, none), boxX + valueX + colX, y, ALIGN_RIGHT, value);
      }
      if (hint !== undefined) fontDrawText(r, font, hint, boxX + valueX + colX, y, ALIGN_RIGHT, hintColor);
    }
    if (state !== 0) {
      // the bar on the entry being assigned
      const y = (entry + 2) * rowH + boxY + lineH;
      const x = state === 1 ? boxX : boxX + colX;
      fillRect(r, x - 5, y - lineH, x + halfW - 15, y + lineGap, [pulse, 0x60 - pulse, 0x60 - Math.trunc(pulse / 2)], 'add');
    }
  }
}

export class OptionsScreen implements Screen {
  result: true | undefined;
  /** KeyConfig_Run while it runs, inside the frame of Options_Update that started it. */
  private keyConfig: KeyConfig | undefined;
  private bg: MotifBackground;
  private fade: Fader;
  private title: ElementInstance | undefined;
  // OptionsState
  private lineH: number;
  private charW: number;
  private lineGap: number;
  private boxX = 0;
  private boxY = 0;
  private boxW = 0;
  private boxH = 0;
  private rowH = 0;
  private valueX = 0;
  private margin = 15;
  private bgColor: Rgb = [0x80, 0x60, 0x40];
  private borderColor: Rgb = [0x40, 0x30, 0x20];
  /** The next Options_Draw draws nothing (the menu changed). */
  private skipDraw = false;
  /** skip_draw as this frame's draw sees it. */
  private hidePanel = false;
  private cursor = [0, 0];
  private accept = false;
  private lockFrames = 0;
  prompt = false;
  promptYes = false;
  promptDone = false;
  private itemCount = OPTIONS_MAIN_COUNT;
  private columns = 1;
  menu = OPTIONS_MENU_MAIN;
  private mainCursor = [0, 0];
  /** ScreenLoop.ticks: frames of the screen before this one. */
  private ticks = -1;
  /** ScreenLoop.input_side of the frame (Options_Draw's prompt reads the cursor of that side). */
  private inputSide = 0;

  constructor(
    private ctx: AppContext,
    private font: Font,
    private opts: GameOptions,
  ) {
    this.bg = new MotifBackground(ctx, 'option');
    this.fade = fader(ctx, 'Option Info');
    const el = parseElement(ctx.motif.section('Option Info'), 'title');
    if (el) this.title = new ElementInstance(el, ctx.motif.assets);
    // Options_Init: line height and character width from the font.
    this.lineH = font.spacing[1] + font.height;
    this.charW = font.spacing[0] + font.spaceWidth;
    this.lineGap = Math.trunc(this.lineH / 6);
    this.opts.main[OPTIONS_LOAD_SAVE] = 0;
  }

  private v(k: string): string | undefined {
    return this.ctx.motif.value('Option Info', k);
  }

  /** The cursor of a side ([0] / [1]); public for tests. */
  cursorOf(side: number): number {
    return this.cursor[side]!;
  }

  /** The running key configuration, if any; public for tests. */
  get activeKeyConfig(): KeyConfig | undefined {
    return this.keyConfig;
  }

  tick(): void {
    const kc = this.keyConfig;
    if (kc && !kc.done) {
      kc.tick();
      return;
    }
    if (kc) {
      // KeyConfig_Run returned: the rest of the frame that started it.
      this.keyConfig = undefined;
      this.ticks = kc.ticks + 1;
      this.snd('cancel.snd');
    } else {
      this.ticks++;
      this.update();
      if (this.keyConfig) {
        this.keyConfig.tick();
        return;
      }
    }
    this.bg.tick();
    this.title?.tick();
    this.fade.tick();
    this.hidePanel = this.skipDraw;
    this.skipDraw = false;
    if (this.fade.done) this.result = true;
  }

  /** Screen_ReadInput for the menu: the first side with a direction or a button this frame, and the key. */
  private readInput(): { input: number; side: number; key: string | undefined } {
    const keys = this.ctx.keys;
    let key: string | undefined;
    if (keys.escape) key = 'Escape';
    else if (keys.pressed?.includes('F1')) key = 'F1';
    else if (keys.pressed?.includes('F2')) key = 'F2';
    for (let side = 0; side < keys.pads.length; side++) {
      const p = keys.pads[side]!;
      let input = 0;
      if (p.pressed(IN_U)) input |= SCREEN_IN_UP;
      if (p.pressed(IN_R)) input |= SCREEN_IN_RIGHT;
      if (p.pressed(IN_D)) input |= SCREEN_IN_DOWN;
      if (p.pressed(IN_L)) input |= SCREEN_IN_LEFT;
      if (p.pressed(BUTTONS | IN_S)) input |= TITLE_IN_BUTTONS;
      if (input) return { input, side, key };
    }
    return { input: 0, side: 0, key };
  }

  private snd(k: string): void {
    motifSound(this.ctx, this.v(k));
  }

  /** Options_ReturnToMain */
  private returnToMain(): void {
    this.cursor[0] = this.mainCursor[0]!;
    this.cursor[1] = this.mainCursor[1]!;
    this.menu = OPTIONS_MENU_MAIN;
    this.accept = false;
    this.skipDraw = true;
  }

  /** Options_EnterMenu */
  private enterMenu(menu: number): void {
    this.mainCursor[0] = this.cursor[0]!;
    this.mainCursor[1] = this.cursor[1]!;
    this.menu = menu;
    this.cursor[0] = this.cursor[1] = 0;
    this.accept = false;
    this.skipDraw = true;
  }

  /**
   * Options_SetJoystick: the joystick type of a side changed. Every side
   * with a type uses its pad, then the pads are opened; this port has no
   * pads (Pads_Init finds none), so both sides lose them again and the
   * type shows greyed out, as mugen.exe does without a joystick.
   */
  private setJoystick(): void {
    const o = this.opts;
    o.useJoystick[0] = o.input[0]![1] !== 0;
    o.useJoystick[1] = o.input[1]![1] !== 0;
    if (o.useJoystick[0] || o.useJoystick[1]) {
      // TODO: Gamepad API pads (Pads_Init / Input_Remap).
      o.useJoystick[0] = o.useJoystick[1] = false;
    }
  }

  /**
   * Options_RunKeyConfig: the key or joystick configuration between the done
   * and cancel sounds (played when it returns, see tick).
   */
  private runKeyConfig(joystick: boolean): void {
    this.snd('cursor.done.snd');
    this.keyConfig = new KeyConfig(this.ctx, this.font, this.opts, this.bg, joystick, this.ticks - 1);
  }

  /** Values the rest of the app reads straight from the context. */
  private publish(): void {
    this.ctx.aiLevel = Math.max(1, Math.min(8, this.opts.difficulty));
  }

  /**
   * Options_Update (0x429F90). Quirk kept: in the input and team menus, a
   * button on an item without an action ("Joystick", the team values)
   * leaves accept set, which fades the options screen out like "Return to
   * Main Menu".
   */
  private update(): void {
    const o = this.opts;
    let { input, side, key } = this.readInput();
    const oldAccept = this.accept;
    const cursor = this.cursor;
    if (this.lockFrames > 0) {
      input = 0;
      side = 0;
      key = undefined;
      this.lockFrames--;
    }
    this.inputSide = side;
    const lineH = this.lineH;
    switch (this.menu) {
      case OPTIONS_MENU_MAIN:
        this.rowH = this.lineGap + lineH;
        this.itemCount = OPTIONS_MAIN_COUNT;
        this.boxH = lineH + this.rowH * 14;
        this.columns = 1;
        this.boxW = this.charW * 26;
        this.valueX = this.boxW;
        break;
      case OPTIONS_MENU_TEAM:
        this.itemCount = 4;
        this.rowH = this.lineGap + lineH;
        this.boxH = lineH + this.rowH * 5;
        this.columns = 1;
        this.boxW = this.charW * 32;
        this.valueX = this.boxW;
        break;
      case OPTIONS_MENU_INPUT:
        this.boxW = this.charW * 40;
        this.boxH = lineH + (this.lineGap + lineH) * 8;
        this.itemCount = 5;
        this.rowH = this.lineGap + lineH;
        this.columns = 2;
        this.valueX = Math.trunc(this.boxW / 2);
        break;
    }
    this.boxX = Math.trunc((OPTIONS_GAME_SIZE[0] - this.boxW) / 2);
    this.boxY = lineH + 40;

    if (!this.prompt || (cursor[side] === OPTIONS_LOAD_SAVE && this.menu === OPTIONS_MENU_MAIN)) {
      if (input & SCREEN_IN_UP) {
        if (--cursor[side]! < 0) cursor[side] = this.itemCount - 1;
        this.promptDone = false;
        this.prompt = false;
        this.snd('cursor.move.snd');
      }
      if (input & SCREEN_IN_DOWN) {
        if (++cursor[side]! >= this.itemCount) cursor[side] = 0;
        this.promptDone = false;
        this.prompt = false;
        this.snd('cursor.move.snd');
      }
    }
    if (this.columns === 1) cursor[1 - side] = cursor[side]!;
    // (OptionsState.accept_side is set too, but never read.)
    this.accept = (input & TITLE_IN_BUTTONS) !== 0;
    let right = (input & SCREEN_IN_RIGHT) !== 0;
    let left = (input & SCREEN_IN_LEFT) !== 0;
    const prompt = this.prompt;
    if (prompt) {
      // left / right choose No / Yes, a button or escape answers
      if (left || key === 'Escape') this.promptYes = false;
      if (right) this.promptYes = true;
      if (this.accept || key === 'Escape') this.promptDone = true;
      right = left = false;
      this.accept = false;
      if (key === 'Escape') key = undefined;
    }

    switch (this.menu) {
      case OPTIONS_MENU_MAIN: {
        const item = cursor[side]!;
        o.main[item] = optionsChangeMain(this, item, o.main[item]!, left, right, prompt, () => o.setDefaults());
        if (!this.prompt) {
          if (key === 'Escape') {
            cursor[side] = OPTIONS_RETURN;
            this.accept = true;
          }
          if (key === 'F1') {
            cursor[side] = OPTIONS_INPUT_CONFIG;
            this.accept = true;
          } else if (key === 'F2') {
            cursor[side] = OPTIONS_TEAM_CONFIG;
            this.accept = true;
          }
        }
        if (!this.accept) break;
        switch (cursor[side]) {
          case OPTIONS_INPUT_CONFIG:
            this.snd('cursor.done.snd');
            this.enterMenu(OPTIONS_MENU_INPUT);
            break;
          case OPTIONS_TEAM_CONFIG:
            this.snd('cursor.done.snd');
            this.enterMenu(OPTIONS_MENU_TEAM);
            break;
          case OPTIONS_LOAD_SAVE:
            this.snd('cursor.done.snd');
            if (o.main[OPTIONS_LOAD_SAVE] === 0) o.load();
            else {
              o.save();
              // Options_Save: the sounds play at the new volumes.
              this.ctx.mixer.volume = o.wavGain;
            }
            this.prompt = true; // shows "Options Loaded/Saved"
            this.lockFrames = 1;
            this.accept = false;
            break;
          case OPTIONS_DEFAULTS:
            this.snd('cursor.done.snd');
            this.prompt = true; // "Reset default values?"
            this.promptYes = false;
            this.accept = false;
            break;
          case OPTIONS_RETURN:
            break; // fades out below
          default:
            this.accept = false;
        }
        break;
      }

      case OPTIONS_MENU_INPUT: {
        const item = cursor[side]!;
        let v = o.input[side]![item]!;
        const old = v;
        if (item === 1) {
          // joystick on / off
          if (left && v !== 0) v = 0;
          if (right && v === 0) v = 1;
          if (v !== old) {
            o.input[side]![item] = v;
            this.setJoystick();
          }
        }
        o.input[side]![cursor[side]!] = v;
        if (key === 'Escape') {
          cursor[0] = cursor[1] = 4;
          this.accept = true;
        }
        if (key === 'F1') {
          cursor[0] = cursor[1] = 0;
          this.accept = true;
        } else if (key === 'F2') {
          cursor[0] = cursor[1] = 2;
          this.accept = true;
        }
        if (!this.accept) break;
        switch (cursor[side]) {
          case 0:
            this.runKeyConfig(false);
            this.accept = false;
            break;
          case 2:
            if (o.useJoystick[0] || o.useJoystick[1]) this.runKeyConfig(true);
            this.accept = false;
            break;
          case 3:
            // Quirk kept: the type is cleared without Options_SetJoystick.
            this.snd('cursor.done.snd');
            o.input[side]![1] = 0;
            this.accept = false;
            break;
          case 4:
            this.snd('cancel.snd');
            this.returnToMain();
            break;
        }
        break;
      }

      case OPTIONS_MENU_TEAM: {
        const item = cursor[side]!;
        let v = o.team[item]!;
        if (item === 0) {
          if (left && v > 100) v -= 10;
          if (right && v < 300) v += 10;
        } else if (item === 1) {
          if (left && v > 0) v--;
          if (right && v < 1) v++;
        }
        o.team[item] = v;
        if (key === 'Escape') {
          cursor[side] = 3;
          this.accept = true;
        }
        if (!this.accept) break;
        if (cursor[side] === 2) {
          // "Default Values": 200%, not mugen.cfg's 150.
          this.snd('cursor.done.snd');
          o.team[0] = 200;
          o.team[1] = 0;
          this.accept = false;
        } else if (cursor[side] === 3) {
          this.snd('cancel.snd');
          this.returnToMain();
        }
        break;
      }
    }

    if (this.accept && oldAccept !== this.accept && !this.fade.fadingOut) {
      // Title_FadeOut with [Option Info] fadeout.time
      this.fade.fadeOut();
      this.snd('cancel.snd');
    }
    this.publish();
  }

  draw(): void {
    if (this.keyConfig) {
      this.keyConfig.draw();
      return;
    }
    const r = this.ctx.renderer;
    const [mw, mh] = this.ctx.motif.localCoord;
    r.setProjection(mw, mh);
    this.bg.drawBack();
    if (!this.hidePanel) this.drawPanel(r);
    r.setProjection(mw, mh);
    this.bg.drawFront();
    this.fade.draw(r, mw, mh);
  }

  /** Options_Draw (0x42AB00), in game pixels. */
  private drawPanel(r: Renderer): void {
    const [W, H] = OPTIONS_GAME_SIZE;
    const font = this.font;
    const { lineH, charW, lineGap, boxX, boxY, boxW, boxH, rowH, valueX, margin, menu } = this;
    const o = this.opts;
    r.setProjection(W, H);

    // the panel (subtractive)
    {
      const x1 = boxX - margin;
      const x2 = boxW + margin + boxX;
      const y2 = boxH + boxY;
      const b = this.borderColor;
      fillRect(r, x1, boxY - 14, x2 - 1, y2 - 1, this.bgColor, 'sub');
      fillRect(r, x1 - 1, boxY - 13, x1 - 1, y2 - 2, b, 'sub');
      fillRect(r, x2, boxY - 13, x2, y2 - 2, b, 'sub');
      fillRect(r, x1 + 1, boxY - 15, x2 - 2, boxY - 15, b, 'sub');
      fillRect(r, x1 + 1, y2, x2 - 2, y2, b, 'sub');
    }
    // Uninitialised in the original before the first cursor bar (it holds
    // box_y - 13 there); every menu has a cursor row, so it is always set.
    let lastColor: Rgb = [0, 0, 0];

    // title
    let title = '';
    if (menu === OPTIONS_MENU_MAIN) title = 'OPTIONS';
    else if (menu === OPTIONS_MENU_INPUT) {
      const y = boxY - lineGap + lineH;
      title = 'INPUT CONFIG';
      fontDrawText(r, font, 'PLAYER 1', Math.trunc(boxW / 4) + boxX, y, ALIGN_CENTER, [0x80, 0x100, 0x100]);
      fontDrawText(r, font, 'PLAYER 2', Math.trunc((boxW * 3) / 4) + boxX, y, ALIGN_CENTER, [0x100, 0x80, 0x80]);
    } else if (menu === OPTIONS_MENU_TEAM) title = 'TEAM MODE CONFIG';
    if (this.title) {
      // [Option Info] title.*: a motif element (SysElem_DrawMotif) with the title as its text.
      const [mw, mh] = this.ctx.motif.localCoord;
      r.setProjection(mw, mh);
      this.title.draw(r, 0, 0, title);
      r.setProjection(W, H);
    } else fontDrawText(r, font, title, Math.trunc(W / 2), boxY - 30, ALIGN_CENTER, [0x100, 0x100, 0x100]);

    // items: one column, or one per player in the input menu
    for (let col = 0; ; ) {
      const x0 = Math.trunc((col * boxW) / 2) + boxX;
      const widthDiv = (this.columns !== 1 ? 1 : 0) + 1;
      let gaps = 0;
      for (let i = 0; i < this.itemCount; i++) {
        let x = x0;
        if (this.columns === 2) {
          const half = Math.trunc(margin / 2);
          x += col === 0 ? -half : half;
        }
        let c: Rgb = [0xc0, 0xc0, 0xc0];
        if (optionsHasGap(menu, i)) gaps++;
        const y = (i + gaps) * rowH + boxY + lineH;
        if (i === this.cursor[col]) {
          const p = titlePulse(this.ticks * 4, 64, 32);
          lastColor = [p, p, p];
          fillRect(r, x - 5, y - lineH, Math.trunc(boxW / widthDiv) + x + 4, y + lineGap, lastColor, 'add');
          c = [0xf8, 0x100, 0x100];
        }
        // "Joystick Config" without a joystick
        if (menu === OPTIONS_MENU_INPUT && i === 2 && !o.useJoystick[0] && !o.useJoystick[1]) c = [0x90, 0x80, 0x80];
        fontDrawText(r, font, MENUS[menu]![i]!, x, y, ALIGN_LEFT, c);
        let text = '';
        if (menu === OPTIONS_MENU_MAIN) text = optionsMainValueText(i, o.main[i]!);
        else if (menu === OPTIONS_MENU_INPUT) {
          const v = o.input[col]![i]!;
          if (i === 1) text = optionsJoystickText(v);
          if (!o.useJoystick[col] && v !== 0) c = [0x90, 0x80, 0x80];
        } else if (menu === OPTIONS_MENU_TEAM) {
          const v = o.team[i]!;
          if (i === 0) text = `${v}%`;
          else if (i === 1) text = v === 0 ? 'Team loses' : v === 1 ? 'AI keeps fighting' : v === 2 ? 'Control AI' : '';
        }
        fontDrawText(r, font, text, x + valueX, y, ALIGN_RIGHT, c);
        const hint = optionsHint(menu, col, i);
        if (hint !== undefined) fontDrawText(r, font, hint, x + valueX, y, ALIGN_RIGHT, [0x100, 0x100, 0x80]);
      }
      if (this.columns === 1 || ++col >= 2) break;
    }

    // prompt: "Reset default values?" or "Options Loaded/Saved"
    if (this.prompt) {
      const pw = charW * 32;
      const ph = lineH * 3;
      const px = Math.trunc((W - pw) / 2);
      const cy = Math.trunc(boxH / 2) + boxY;
      const half = Math.trunc(ph / 2);
      const ty = Math.trunc(lineH / 2) + half + cy - 1;
      const cx = Math.trunc(pw / 2) + px;
      const frame: Rgb = [0x38, 0x38, 0x60];
      fillRect(r, px, cy - 1, px + pw, cy - 1, frame);
      fillRect(r, px, cy + ph + 1, px + pw, cy + ph + 1, frame);
      fillRect(r, px - 1, cy, px - 1, cy + ph, frame);
      fillRect(r, px + pw + 1, cy, px + pw + 1, cy + ph, frame);
      fillRect(r, px, cy, px + pw, cy + ph, [0x54, 0x54, 0x88]);
      const item = this.cursor[this.inputSide];
      if (item === OPTIONS_DEFAULTS) {
        let no: Rgb = [0x100, 0x100, 0x100];
        let yes: Rgb = [0x100, 0x100, 0x100];
        // the bar goes from right to left (x1 > x2), as in the original
        if (!this.promptYes) {
          yes = [0xc0, 0xc0, 0xc0];
          fillRect(r, px - charW * 5 + pw, ty - lineH, px - charW * 9 + pw, ty + lineGap, lastColor, 'add');
        } else {
          no = [0xc0, 0xc0, 0xc0];
          fillRect(r, px - charW + pw, ty - lineH, px - charW * 4 + pw, ty + lineGap, lastColor, 'add');
        }
        fontDrawText(r, font, 'Reset default values?', charW * 2 + px, ty, ALIGN_LEFT, [0x100, 0x100, 0x100]);
        fontDrawText(r, font, 'No', px - charW * 6 + pw, ty, ALIGN_RIGHT, no);
        fontDrawText(r, font, 'Yes', px - charW * 2 + pw, ty, ALIGN_RIGHT, yes);
        return;
      }
      if (item === OPTIONS_LOAD_SAVE) {
        fontDrawText(r, font, o.main[OPTIONS_LOAD_SAVE] === 0 ? 'Options Loaded' : 'Options Saved', cx, ty, ALIGN_CENTER, [0x100, 0x100, 0x100]);
      }
    }
  }
}
