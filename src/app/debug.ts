// mugen.exe's debug mode, as mugen.cfg's [Debug] section sets it up: the keys of Game_ReadInput, Game_DebugKeys and the console's
// bindings (console.c con_keys), and the display of Debug_Draw.

import { MugenAI } from '../engine/ai';
import { findSection, getValue, type IniDoc } from '../formats/text';
import type { Player } from '../engine/player';
import { drawText, fontColor } from '../motif/element';
import type { Font } from '../motif/font';
import type { Renderer } from '../render/renderer';
import type { FightScreen } from './fight-screen';

type Command = (fight: FightScreen) => void;

const STATE_TYPES: Record<string, number> = { s: 1, c: 2, a: 3, l: 4 };
const MOVE_TYPES: Record<string, number> = { i: 0, a: 1, h: 2 };

function fighters(fight: FightScreen): Player[] {
  return fight.world.players.filter((p) => !p.isHelper);
}

function fillPower(p: Player): void {
  p.power = p.const('data.power');
}

/** The player of slot n and its partner (slot n + 2), as "setlife" takes them. */
function setLife(fight: FightScreen, slot: number, life: number): void {
  for (const p of fighters(fight)) if (p.slotNo === slot || p.slotNo === slot + 2) p.setLife(life);
}

/** Debug_ResetLifePowerTime: life, power and the round's time back, and up from a lie down. */
function lifeReset(fight: FightScreen): void {
  for (const p of fighters(fight)) {
    if (p.stateNo === 5150) p.changeState(5120);
    p.life = p.lifeMax;
    p.alive = true;
    fillPower(p);
  }
  fight.match.resetClock();
}

/** Con_CmdForceStand: back in the own states, standing, with control and at rest. */
function forceStand(fight: FightScreen): void {
  for (const p of fighters(fight)) {
    p.returnToOwnStates();
    p.changeState(0);
    p.ctrl = true;
    p.vel.x = p.vel.y = 0;
  }
}

/** mugen.cfg's [Debug] section (Config_Load). */
export interface DebugConfig {
  /** Debug: every match starts with the display on. */
  debug: boolean;
  /** AllowDebugMode: Ctrl+D turns the display on (always, with Debug = 1). */
  allowDebugMode: boolean;
  /** AllowDebugKeys: the debug keys work with the display off too. */
  allowDebugKeys: boolean;
  /** Speedup: no frame limit. */
  speedup: boolean;
}

export function readDebugConfig(cfg: IniDoc | undefined): DebugConfig {
  const section = cfg && findSection(cfg, 'Debug');
  const flag = (key: string, d: boolean) => {
    const n = parseInt(getValue(section, key) ?? '', 10);
    return Number.isFinite(n) ? n !== 0 : d;
  };
  const debug = flag('debug', false);
  return {
    debug,
    allowDebugMode: debug || flag('allowdebugmode', false),
    allowDebugKeys: flag('allowdebugkeys', false),
    speedup: flag('speedup', false),
  };
}

/** AnimState.time as the display shows it: from 1 up to the action's length, again from 1 in a loop. */
function animTime(time: number, total: number): number {
  return total > 0 ? (time % total) + 1 : time + 1;
}

export class DebugMode {
  /** GameVars.debug: the display is on. */
  private on: boolean;
  /** GameVars.debug_player: the index of the player on display, 0 for none. */
  private player = 0;
  /** The life on the bars (the display being on), in this font. */
  get lifeFont(): Font | undefined {
    return this.on ? this.font : undefined;
  }
  /** GameVars.clsn_draw_mode: 0 off, 1 outlines, 2 filled. */
  clsnMode = 0;
  /** GameVars.hud_enabled. */
  hud = true;
  /** GameVars.speedup: the host runs as many ticks as it can. */
  speedup: boolean;
  private maxPower = false;
  private paused = false;
  private step = false;
  private queue: Command[] = [];
  private fpsFrames = 0;
  private fpsSince = 0;
  private fps = 0;

  constructor(
    private config: DebugConfig,
    /** font/f-4x6.def (GameVars.font_small). */
    readonly font: Font | undefined,
    /** font/f-6x9.def (GameVars.font_medium). */
    private mediumFont: Font | undefined,
    private aiLevel: number,
  ) {
    this.on = config.debug;
    this.speedup = config.speedup;
  }

  /** Match_Load: debug_player starts with the display's state, and old keys are gone. */
  matchLoaded(): void {
    this.player = this.on ? 1 : 0;
    this.queue.length = 0;
  }

  /** Con_DebugAllowed. */
  private get keysAllowed(): boolean {
    return this.player !== 0 || this.config.allowDebugKeys;
  }

  /** The command bound to a key, by con_keys' modifiers: exactly the ones listed. */
  private command(e: KeyboardEvent): Command | undefined {
    const ctrl = e.ctrlKey && !e.shiftKey && !e.altKey;
    const none = !e.ctrlKey && !e.shiftKey && !e.altKey;
    // Game_ReadInput: these two have no gate.
    if (none && e.code === 'Pause') return () => (this.paused = !this.paused);
    if (none && e.code === 'ScrollLock') {
      return () => {
        this.paused = true;
        this.step = true;
      };
    }
    if (ctrl && e.code === 'KeyD') return this.config.allowDebugMode ? (f) => this.nextPlayer(f) : undefined;
    // Con_CmdForceStand only checks its arguments with the gate.
    if (ctrl && e.code === 'KeyI') return forceStand;
    if (!this.keysAllowed) return undefined;
    const digit = /^Digit([1-4])$/.exec(e.code);
    if (ctrl && digit) {
      const n = Number(digit[1]);
      return (f) => this.toggleAi(f, n);
    }
    if (ctrl) {
      switch (e.code) {
        case 'KeyS':
          return () => (this.speedup = !this.speedup);
        case 'KeyC':
          return () => (this.clsnMode = (this.clsnMode + 1) % 3);
        case 'KeyL':
          return () => (this.hud = !this.hud);
        case 'F1':
          return (f) => setLife(f, 1, 0);
        case 'F2':
          return (f) => setLife(f, 1, 1);
      }
      return undefined;
    }
    if (none) {
      switch (e.code) {
        case 'Space':
          return lifeReset;
        case 'F1':
          return (f) => setLife(f, 2, 0);
        case 'F2':
          return (f) => setLife(f, 2, 1);
        case 'F3':
          return (f) =>
            fighters(f)
              .filter((p) => p.slotNo <= 2)
              .forEach(fillPower);
        case 'F4':
          return (f) => f.match.resetRound();
        case 'F5':
          return (f) => f.match.setClock(1);
      }
      return undefined;
    }
    if (e.shiftKey && !e.altKey && e.code === 'F4' && !e.ctrlKey) return (f) => f.match.resetMatch();
    if (e.shiftKey && e.ctrlKey && !e.altKey && e.code === 'F3') return () => (this.maxPower = !this.maxPower);
    return undefined;
  }

  /** A key went down: whether it's bound, so the browser's shortcut stays out of the way. */
  keyDown(e: KeyboardEvent): boolean {
    const command = this.command(e);
    if (!command) return false;
    if (!e.repeat) this.queue.push(command);
    return true;
  }

  /** Game_DebugKeys, Ctrl+D: the next player on the display, or none after the last. */
  private nextPlayer(fight: FightScreen): void {
    this.player++;
    this.on = true;
    if (this.player > fight.world.allPlayers().length) {
      this.player = 0;
      this.on = false;
    }
  }

  /** Debug_ToggleAi: the AI starts or stops driving the player of that slot. */
  private toggleAi(fight: FightScreen, slot: number): void {
    for (const p of fighters(fight)) {
      if (p.slotNo === slot) p.ai = p.ai ? undefined : new MugenAI(p, this.aiLevel);
    }
  }

  /** Runs the fight's commands; false while paused, when the fight stands still this tick. */
  update(fight: FightScreen): boolean {
    for (const command of this.queue) command(fight);
    this.queue.length = 0;
    if (this.maxPower) for (const p of fighters(fight)) if (p.slotNo <= 2) fillPower(p);
    if (this.paused && !this.step) return false;
    this.step = false;
    return true;
  }

  /** Debug_Draw, in game pixels, and the pause box. */
  draw(r: Renderer, fight: FightScreen, frames: number, width: number, height: number): void {
    if (this.paused && this.mediumFont) {
      const cx = Math.trunc(width / 2);
      r.rect(cx - 25, 10, cx + 25, 25, [0, 0, 0x18, 128]);
      drawText(r, this.mediumFont, 'PAUSED', cx, 20, 0, 0);
    }
    const now = performance.now();
    this.fpsFrames++;
    if (now - this.fpsSince >= 500) {
      this.fps = (this.fpsFrames * 1000) / (now - this.fpsSince);
      this.fpsFrames = 0;
      this.fpsSince = now;
    }
    const font = this.font;
    if (this.player === 0 || !font) return;
    const y = height - 39;
    const text = (s: string, x: number, line: number, color?: [number, number, number]) =>
      drawText(r, font, s, x, y + line, 0, 1, [1, 1], color);
    text(`Frames: ${frames} (${this.fps.toFixed(1)} FPS)`, 10, 0);
    text(`VRet: 1, Speed: ${this.speedup ? 1 : 0}, Skip: a`, 110, 0);
    const nameColor = fontColor(0xc8, 0xc8, 0xdc);
    const p = fight.world.allPlayers()[this.player - 1];
    if (!p) {
      text(`Player ${this.player - 1} Disabled`, 10, 8, nameColor);
      return;
    }
    const index = this.player - 1;
    let name = p.id === index ? `${p.name} ${p.id}` : `${p.name} ${p.id} (${index})`;
    const owner = p.stateOwner;
    if (owner) name += ` (in ${owner.name} ${owner.id}'s state rc)`;
    text(name, 10, 8, nameColor);
    const a = p.anim;
    const elem = a.current;
    const fromOwner = fontColor(0x100, 0x100, 0x80);
    text(
      `ActionID: ${p.animNo}; Spr: ${elem?.group ?? -1},${elem?.number ?? -1}; Elemno: ${a.elem + 1}/${a.anim.elements.length}; Time: ${animTime(a.time, a.totalTime)}/${a.totalTime}`,
      10,
      15,
      p.animProg && p.animProg !== p.prog ? fromOwner : undefined,
    );
    const invalid = !p.compiledState(p.stateNo) && p.stateNo >= 200 ? ' (invalid)' : '';
    text(
      `State no: ${p.stateNo}; Ctrl: ${p.ctrl ? 1 : 0}; Type: ${STATE_TYPES[p.stateType] ?? 0}; Movetype ${MOVE_TYPES[p.moveType] ?? 0}; Time: ${p.time - 1}${invalid}`,
      10,
      22,
      owner ? fromOwner : undefined,
    );
    // Clipboard_Draw: the player's lines under the rest.
    const line = font.height + font.spacing[1];
    let at = height - 10;
    for (const entry of p.clipboard) {
      for (const part of entry.split('\n')) {
        drawText(r, font, part, 10, at, 0, 1);
        at += line;
      }
    }
  }
}
