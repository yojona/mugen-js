// Keyboard input for two players, with edge detection for menus. The key maps
// are mugen.exe's configured keys in SDL codes (GameVars.keys), turned into
// KeyboardEvent codes by setMaps (Input_Remap).

import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_S, IN_U, IN_X, IN_Y, IN_Z } from '../engine/cmd';
import { BROWSER_DEFAULT_KEYS, KEYBOARD_RELEASE, browserToSdl, sdlToBrowser } from './sdl-keys';

export const BUTTONS = IN_A | IN_B | IN_C | IN_X | IN_Y | IN_Z;

/** The input bit of each key configuration entry (keyconfig_slots: up, down, left, right, a, b, c, x, y, z, start). */
export const ENTRY_BITS = [IN_U, IN_D, IN_L, IN_R, IN_A, IN_B, IN_C, IN_X, IN_Y, IN_Z, IN_S];

/** INPUT_RING_SIZE: the key queue drops its oldest code when full. */
const INPUT_RING_SIZE = 0x100;

type Target = { side: number; bit: number };

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
  escape = false;
  /** Keys first pressed this tick (KeyboardEvent.code), for menus. */
  pressed: string[] = [];
  private pressQueue: string[] = [];
  private escapeDown = false;
  private escapePrev = false;
  /** Called on the first key press (audio unlock). */
  onFirstInput?: () => void;
  /**
   * g_keyboardQueue: SDL codes in order, releases with KEYBOARD_RELEASE.
   * KeyConfig_Run reads one per frame. No auto-repeat: System_Init turns SDL's
   * off, and KeyConfig_Run's g_keyboardKeepRepeat only matters in Keyboard_Init.
   */
  private keyQueue: number[] = [];
  /** g_padQueue: joystick codes in order, releases with PAD_RELEASE. */
  private padQueue: number[] = [];
  /** While set (KeyConfig_Run), every key belongs to the game, not the browser's shortcuts. */
  capture = false;

  constructor(target: EventTarget = window) {
    this.setMaps(BROWSER_DEFAULT_KEYS);
    target.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent;
      this.onFirstInput?.();
      if (e.code === 'Escape') this.escapeDown = true;
      if (!e.repeat) {
        this.pressQueue.push(e.code);
        this.queueKey(e.code, 0);
      }
      this.held.add(e.code);
      if (this.keyMap.has(e.code) || (this.capture && !e.metaKey && !e.ctrlKey)) e.preventDefault();
    });
    target.addEventListener('keyup', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.code === 'Escape') this.escapeDown = false;
      this.queueKey(e.code, KEYBOARD_RELEASE);
      this.held.delete(e.code);
    });
    target.addEventListener('blur', () => {
      this.held.clear();
      this.escapeDown = false;
    });
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
  setMaps(keys: readonly (readonly number[])[]): void {
    const map = new Map<string, Target>();
    keys.forEach((entries, side) =>
      entries.forEach((sdl, i) => {
        const code = sdlToBrowser(sdl);
        if (code) map.set(code, { side, bit: ENTRY_BITS[i]! });
      }),
    );
    this.keyMap = map;
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

  /** Sample the keyboard for this tick. */
  poll(): void {
    const down = [0, 0];
    for (const code of this.held) {
      const t = this.keyMap.get(code);
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
