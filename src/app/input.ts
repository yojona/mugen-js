// Keyboard input for two players, with edge detection for menus.

import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_S, IN_U, IN_X, IN_Y, IN_Z } from '../engine/cmd';

export const BUTTONS = IN_A | IN_B | IN_C | IN_X | IN_Y | IN_Z;

const MAPS: Record<string, number>[] = [
  { ArrowUp: IN_U, ArrowDown: IN_D, ArrowLeft: IN_L, ArrowRight: IN_R, KeyA: IN_X, KeyS: IN_Y, KeyD: IN_Z, KeyZ: IN_A, KeyX: IN_B, KeyC: IN_C, Enter: IN_S },
  { KeyI: IN_U, KeyK: IN_D, KeyJ: IN_L, KeyL: IN_R, KeyU: IN_X, KeyO: IN_Y, KeyP: IN_Z, KeyM: IN_A, Comma: IN_B, Period: IN_C, Backspace: IN_S },
];

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
  private down = [0, 0];
  escape = false;
  private escapeDown = false;
  private escapePrev = false;
  /** Called on the first key press (audio unlock). */
  onFirstInput?: () => void;

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent;
      this.onFirstInput?.();
      if (e.code === 'Escape') this.escapeDown = true;
      MAPS.forEach((m, i) => {
        const b = m[e.code];
        if (b) {
          this.down[i]! |= b;
          e.preventDefault();
        }
      });
    });
    target.addEventListener('keyup', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.code === 'Escape') this.escapeDown = false;
      MAPS.forEach((m, i) => {
        const b = m[e.code];
        if (b) this.down[i]! &= ~b;
      });
    });
    target.addEventListener('blur', () => {
      this.down = [0, 0];
      this.escapeDown = false;
    });
  }

  /** Sample the keyboard for this tick. */
  poll(): void {
    this.pads.forEach((p, i) => {
      p.latch();
      p.bits = this.down[i]!;
    });
    this.escape = this.escapeDown && !this.escapePrev;
    this.escapePrev = this.escapeDown;
  }
}
