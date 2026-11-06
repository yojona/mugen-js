// Keyboard and gamepad input for two players, with edge detection for menus.
// The maps are mugen.exe's configured keys in SDL codes (GameVars.keys) and
// joystick codes (joy_keys_active), turned into targets by setMaps
// (Input_Remap). Pads are the Gamepad API's, read as pads.c reads SDL's.

import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_S, IN_U, IN_X, IN_Y, IN_Z } from '../engine/cmd';
import { BROWSER_DEFAULT_KEYS, JOY_NONE, KEYBOARD_RELEASE, PAD_RELEASE, browserToSdl, sdlToBrowser } from './sdl-keys';

export const BUTTONS = IN_A | IN_B | IN_C | IN_X | IN_Y | IN_Z;

/** The input bit of each key configuration entry (keyconfig_slots: up, down, left, right, a, b, c, x, y, z, start). */
export const ENTRY_BITS = [IN_U, IN_D, IN_L, IN_R, IN_A, IN_B, IN_C, IN_X, IN_Y, IN_Z, IN_S];

/** INPUT_RING_SIZE: the key queue drops its oldest code when full. */
const INPUT_RING_SIZE = 0x100;

type Target = { side: number; bit: number };

/** pads.c: PAD_MAX joysticks of PAD_BUTTONS buttons each (code = pad * PAD_BUTTONS + button). */
const PAD_MAX = 4;
const PAD_BUTTONS = 32;
/** PAD_AXIS_THRESHOLD: 16000 of SDL's +-32768. */
const PAD_AXIS_THRESHOLD = 16000 / 32768;
/** Gamepad.buttons of the "standard" mapping's D-pad (up, down, left, right), SDL's hat. */
const STANDARD_DPAD = [12, 13, 14, 15];

/** The part of the browser's Gamepad read here. */
export interface GamepadLike {
  mapping?: string;
  axes: readonly number[];
  buttons: readonly { pressed: boolean }[];
}
export type GamepadSource = () => readonly (GamepadLike | null)[];

/** navigator.getGamepads(), which a page's policy may refuse and Node lacks. */
function browserGamepads(): readonly (GamepadLike | null)[] {
  try {
    return typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  } catch {
    return [];
  }
}

/**
 * The buttons held on a pad, in pads.c's numbering (Pads_Init,
 * Pads_HandleEvent): each axis is two buttons from 1 (the first two axes
 * swapped, so axis 1 gives 1 up / 2 down and axis 0 gives 3 left / 4 right),
 * then the hat's four, then the buttons. The Gamepad API has no hats: a
 * standard pad's D-pad buttons stand in for one, which is what mugen.cfg's
 * [P1 Joystick] (Jump = 9) expects of a pad with four axes.
 */
export function padButtonsHeld(pad: GamepadLike): number[] {
  const held: number[] = [];
  pad.axes.forEach((value, a) => {
    const axis = a === 0 ? 1 : a === 1 ? 0 : a;
    if (value < -PAD_AXIS_THRESHOLD) held.push(axis * 2 + 1);
    else if (value > PAD_AXIS_THRESHOLD) held.push(axis * 2 + 2);
  });
  const hatBase = pad.axes.length * 2;
  const hat = pad.mapping === 'standard';
  const buttonBase = hatBase + (hat ? 4 : 0);
  let b = 0;
  pad.buttons.forEach((button, i) => {
    const dpad = hat ? STANDARD_DPAD.indexOf(i) : -1;
    if (dpad >= 0) {
      if (button.pressed) held.push(hatBase + 1 + dpad);
      return;
    }
    const code = buttonBase + 1 + b++;
    if (button.pressed && code < PAD_BUTTONS) held.push(code);
  });
  return held.filter((code) => code < PAD_BUTTONS);
}

export class Pad {
  bits = 0;
  private prev = 0;
  /** Set for one tick when the bit went down. */
  pressed(bit: number): boolean {
    return (this.bits & bit) !== 0 && (this.prev & bit) === 0;
  }
  latch(): void {
    this.prev = this.bits;
  }
}

export class Keyboard {
  readonly pads = [new Pad(), new Pad()];
  /** KeyboardEvent.code of the keys down. */
  private held = new Set<string>();
  private keyMap = new Map<string, Target>();
  private padMap = new Map<number, Target>();
  /** g_padsActive: Pads_Init found a pad and the options want one. */
  private padsActive = false;
  /** Pad codes (pad * PAD_BUTTONS + button) held at the last poll. */
  private padHeld = new Set<number>();
  private hadPads = false;
  /**
   * A pad appeared or went away. mugen.exe only looks in Pads_Init, but a
   * browser lists a pad after its first press, so the options re-open them.
   */
  onPadsChanged?: () => void;
  escape = false;
  /** Keys first pressed this tick (KeyboardEvent.code), for menus. */
  pressed: string[] = [];
  private pressQueue: string[] = [];
  private escapeDown = false;
  private escapePrev = false;
  /** Sees every key going down; true keeps the browser's shortcut for that key away. */
  onKeyDown?: (e: KeyboardEvent) => boolean;
  /** A key, click or touch: what browsers accept as a user gesture (audio unlock). */
  onFirstInput?: () => void;
  /** A pad button went down. Browsers don't take it as a gesture, but they honour an earlier one. */
  onPadPress?: () => void;
  /**
   * g_keyboardQueue: SDL codes in order, releases with KEYBOARD_RELEASE.
   * KeyConfig_Run reads one per frame. No auto-repeat: System_Init turns SDL's
   * off, and KeyConfig_Run's g_keyboardKeepRepeat only matters in Keyboard_Init.
   */
  private keyQueue: number[] = [];
  /** g_padQueue: joystick codes in order, releases with PAD_RELEASE. */
  private padQueue: number[] = [];
  /** Keys pressed since the last poll, released or not. */
  private tapped = new Set<string>();
  private listeners = new AbortController();
  /** While set (KeyConfig_Run), every key belongs to the game, not the browser's shortcuts. */
  capture = false;

  constructor(
    target: EventTarget = window,
    private gamepads: GamepadSource = browserGamepads,
  ) {
    this.setMaps(BROWSER_DEFAULT_KEYS);
    const { signal } = this.listeners;
    target.addEventListener(
      'keydown',
      (ev) => {
        const e = ev as KeyboardEvent;
        this.onFirstInput?.();
        if (e.code === 'Escape') this.escapeDown = true;
        if (!e.repeat) {
          this.pressQueue.push(e.code);
          this.queueKey(e.code, 0);
        }
        this.held.add(e.code);
        this.tapped.add(e.code);
        const shortcut = !this.capture && this.onKeyDown?.(e);
        if (shortcut || this.keyMap.has(e.code) || (this.capture && !e.metaKey && !e.ctrlKey)) e.preventDefault();
      },
      { signal },
    );
    for (const gesture of ['pointerdown', 'touchend']) {
      target.addEventListener(gesture, () => this.onFirstInput?.(), { signal });
    }
    target.addEventListener(
      'keyup',
      (ev) => {
        const e = ev as KeyboardEvent;
        if (e.code === 'Escape') this.escapeDown = false;
        this.queueKey(e.code, KEYBOARD_RELEASE);
        this.held.delete(e.code);
      },
      { signal },
    );
    target.addEventListener(
      'blur',
      () => {
        this.held.clear();
        this.escapeDown = false;
      },
      { signal },
    );
  }

  /** Removes the event listeners. */
  dispose(): void {
    this.listeners.abort();
  }

  private queueKey(code: string, flag: number): void {
    const sdl = browserToSdl(code);
    if (sdl === undefined) return;
    this.keyQueue.push(sdl | flag);
    if (this.keyQueue.length >= INPUT_RING_SIZE) this.keyQueue.shift();
  }

  /**
   * Input_Remap (0x41B380): which player's input each configured key drives.
   * Quirk kept: g_keyMap holds one target per key and P2's entries are written
   * after P1's, so a key both players have (or an entry's duplicate) drives
   * only the last one. Held keys carry over (Input_ResetState).
   */
  setMaps(keys: readonly (readonly number[])[], joyKeys?: readonly (readonly number[])[], padsActive = false): void {
    const map = new Map<string, Target>();
    keys.forEach((entries, side) =>
      entries.forEach((sdl, i) => {
        const code = sdlToBrowser(sdl);
        if (code) map.set(code, { side, bit: ENTRY_BITS[i]! });
      }),
    );
    this.keyMap = map;
    const pads = new Map<number, Target>();
    joyKeys?.forEach((entries, side) =>
      entries.forEach((code, i) => {
        if (code !== JOY_NONE && code !== 0) pads.set(code, { side, bit: ENTRY_BITS[i]! });
      }),
    );
    this.padMap = pads;
    this.padsActive = padsActive;
  }

  /** Pads_Init: how many pads the browser lists. */
  padCount(): number {
    return this.gamepads().filter((p) => p).length;
  }

  /** Pads_HandleEvent, from the Gamepad API's state: queues the changes (Pads_SetButton). */
  private pollPads(): void {
    const list = this.gamepads();
    const has = list.some((p) => p);
    if (has !== this.hadPads) {
      this.hadPads = has;
      this.onPadsChanged?.();
    }
    const held = new Set<number>();
    if (this.padsActive) {
      list.slice(0, PAD_MAX).forEach((pad, i) => {
        if (pad) for (const button of padButtonsHeld(pad)) held.add(i * PAD_BUTTONS + button);
      });
    }
    for (const code of held) {
      if (this.padHeld.has(code)) continue;
      this.queuePad(code);
      this.onPadPress?.();
    }
    for (const code of this.padHeld) if (!held.has(code)) this.queuePad(code | PAD_RELEASE);
    this.padHeld = held;
  }

  private queuePad(code: number): void {
    this.padQueue.push(code);
    if (this.padQueue.length >= INPUT_RING_SIZE) this.padQueue.shift();
  }

  /** The oldest code of g_keyboardQueue, 0 when empty. */
  popKey(): number {
    return this.keyQueue.shift() ?? 0;
  }

  /** The oldest code of g_padQueue, 0 when empty. */
  popPad(): number {
    return this.padQueue.shift() ?? 0;
  }

  /** KeyConfig_Run's start: empties the queues. */
  resetQueues(): void {
    this.keyQueue = [];
    this.padQueue = [];
  }

  /** Sample the keyboard and the pads for this tick. */
  poll(): void {
    this.pollPads();
    const down = [0, 0];
    // A key pressed and released between two ticks still counts for one:
    // the reference gets every change as an event.
    for (const code of [...this.held, ...this.tapped]) {
      const t = this.keyMap.get(code);
      if (t) down[t.side]! |= t.bit;
    }
    this.tapped.clear();
    for (const code of this.padHeld) {
      const t = this.padMap.get(code);
      if (t) down[t.side]! |= t.bit;
    }
    this.pads.forEach((p, i) => {
      p.latch();
      p.bits = down[i]!;
    });
    this.pressed = this.pressQueue;
    this.pressQueue = [];
    this.escape = this.escapeDown && !this.escapePrev;
    this.escapePrev = this.escapeDown;
  }
}
