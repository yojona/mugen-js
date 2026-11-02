// Player runtime: state machine, physics and per-tick processing.

import { compileExprList, R, truthy, type Fn } from '../expr/compile';
import type { Animation } from '../formats/air';
import { parseIni } from '../formats/text';
import { AnimPlayer } from './anim';
import type { CharacterData } from './character';
import { activeCommands, InputHistory, parseCmd, type CommandSet } from './cmd';
import { parseConstants, parseStates, type Constants, type ControllerDef, type StateDef, type StateMap } from './cns';
import { compileController, type CompiledController } from './controllers';
import { playerEnv } from './triggers';
import type { Vfs } from './vfs';
import type { World } from './world';

export type StateType = 's' | 'c' | 'a' | 'l' | 'u';
export type MoveType = 'i' | 'a' | 'h' | 'u';
export type Physics = 's' | 'c' | 'a' | 'n' | 'u';

/** Everything loaded from disk for one character (shared between instances). */
export interface CharacterProgram {
  data: CharacterData;
  consts: Constants;
  states: StateMap;
  cmd: CommandSet;
  /** Compiled controllers, built lazily per state. */
  compiled: Map<number, CompiledState>;
}

export interface CompiledState {
  def: StateDef;
  controllers: CompiledController[];
  /** Statedef parameters, compiled. */
  params: Map<string, Fn<Player>[]>;
}

export async function loadProgram(vfs: Vfs, data: CharacterData): Promise<CharacterProgram> {
  const f = data.def.files;
  const dir = data.dir;
  const states: StateMap = new Map();
  const constDocs = [];
  // Priority: cmd (state -1), st files in order, then stcommon.
  let cmd: CommandSet = { commands: [], names: new Set() };
  if (f.cmd) {
    const text = await vfs.text(f.cmd, dir);
    cmd = parseCmd(text);
    parseStates(text, f.cmd, states);
  }
  if (f.cns) {
    const text = await vfs.text(f.cns, dir);
    constDocs.push(parseIni(text));
    if (!f.st.some((s) => s.toLowerCase() === f.cns!.toLowerCase())) parseStates(text, f.cns, states);
  }
  for (const st of f.st) parseStates(await vfs.text(st, dir), st, states);
  if (f.stcommon) parseStates(await vfs.text(f.stcommon, dir, 'data'), f.stcommon, states);
  return { data, consts: parseConstants(constDocs), states, cmd, compiled: new Map() };
}

export interface Vec {
  x: number;
  y: number;
}

let nextId = 56; // MUGEN's first player ID

export class Player {
  readonly id = nextId++;
  readonly input = new InputHistory();
  commands = new Set<string>();

  pos: Vec = { x: 0, y: 0 };
  vel: Vec = { x: 0, y: 0 };
  facing = 1;

  stateNo = 0;
  prevStateNo = 0;
  /** Time in current state (the `Time` trigger). */
  time = 0;
  stateType: StateType = 's';
  moveType: MoveType = 'i';
  physics: Physics = 's';
  ctrl = true;

  animNo = 0;
  anim: AnimPlayer;

  life: number;
  power = 0;
  vars = new Int32Array(60);
  fvars = new Float32Array(40);
  sysVars = new Int32Array(5);
  sysFvars = new Float32Array(5);

  sprPriority = 0;
  palNo = 1;
  posFreeze = false;
  alive = true;

  /** Events for the audio/visual layers (PlaySnd etc.), drained by the host. */
  events: { kind: 'sound'; group: number; number: number; common: boolean; channel: number }[] = [];
  warnings: string[] = [];

  /** Persistence counters for controllers of the current state. */
  private persist = new Map<CompiledController, number>();
  private stateChanged = false;

  constructor(
    readonly prog: CharacterProgram,
    readonly world: World,
    readonly side: number,
  ) {
    this.life = this.const('data.life');
    const first = prog.data.anims.get(0) ?? prog.data.anims.values().next().value;
    if (!first) throw new Error(`${prog.data.def.name}: sin animaciones`);
    this.anim = new AnimPlayer(first);
  }

  get name(): string {
    return this.prog.data.def.name;
  }

  const(name: string): number {
    return this.prog.consts.get(name) ?? 0;
  }

  warn(msg: string): void {
    if (this.warnings.length < 200) this.warnings.push(msg);
  }

  // -------------------------------------------------------------------------
  // States

  compiledState(no: number): CompiledState | undefined {
    let cs = this.prog.compiled.get(no);
    if (cs) return cs;
    const def = this.prog.states.get(no);
    if (!def) return undefined;
    const env = playerEnv;
    const params = new Map<string, Fn<Player>[]>();
    for (const [k, v] of def.params) {
      if (['type', 'movetype', 'physics'].includes(k)) continue;
      try {
        params.set(k, compileExprList(v, env));
      } catch (e) {
        this.warn(`Statedef ${no}: ${k}: ${(e as Error).message}`);
      }
    }
    const controllers: CompiledController[] = [];
    for (const c of def.controllers) {
      try {
        controllers.push(compileController(c, env));
      } catch (e) {
        this.warn(`${c.file}:${c.line} [State ${no}, ${c.label}] ${c.type}: ${(e as Error).message}`);
      }
    }
    cs = { def, controllers, params };
    this.prog.compiled.set(no, cs);
    return cs;
  }

  hasAnim(no: number): boolean {
    return this.prog.data.anims.has(no);
  }

  changeAnim(no: number, elem = 0): void {
    const a: Animation | undefined = this.prog.data.anims.get(no);
    if (!a) {
      this.warn(`Animación ${no} no existe`);
      return;
    }
    this.animNo = no;
    this.anim.set(a, elem);
  }

  /** ChangeState: enter `no`; controllers of the new state run this same tick. */
  changeState(no: number, ctrl?: boolean, anim?: number): void {
    const cs = this.compiledState(no);
    if (!cs) {
      this.warn(`Estado ${no} no existe`);
      return;
    }
    this.prevStateNo = this.stateNo;
    this.stateNo = no;
    this.time = 0;
    this.persist.clear();
    this.stateChanged = true;
    this.applyStatedef(cs);
    if (ctrl !== undefined) this.ctrl = ctrl;
    if (anim !== undefined) this.changeAnim(anim);
  }

  private applyStatedef(cs: CompiledState): void {
    const d = cs.def.params;
    const letter = (k: string, def: string) => (d.get(k)?.trim().toLowerCase()[0] ?? def) as never;
    const st = letter('type', 's') as StateType;
    const mt = letter('movetype', 'i') as MoveType;
    const ph = letter('physics', 'n') as Physics;
    if (st !== 'u') this.stateType = st;
    if (mt !== 'u') this.moveType = mt;
    if (ph !== 'u') this.physics = ph;
    const num = (k: string, i = 0): number | undefined => {
      const fns = cs.params.get(k);
      const fn = fns?.[i];
      if (!fn) return undefined;
      const v = fn(this);
      return R.t === 2 ? undefined : v;
    };
    const v0 = num('velset', 0);
    if (v0 !== undefined) {
      this.vel.x = v0;
      this.vel.y = num('velset', 1) ?? 0;
    }
    const ctrl = num('ctrl');
    if (ctrl !== undefined) this.ctrl = ctrl !== 0;
    const pa = num('poweradd');
    if (pa !== undefined) this.addPower(pa);
    const spr = num('sprpriority');
    if (spr !== undefined) this.sprPriority = spr;
    if ((num('facep2') ?? 0) !== 0) {
      const e = this.world.enemyOf(this);
      if (e && (e.pos.x - this.pos.x) * this.facing < 0) this.facing = -this.facing;
    }
    const anim = num('anim');
    if (anim !== undefined) this.changeAnim(anim);
  }

  addPower(v: number): void {
    this.power = Math.max(0, Math.min(this.const('data.power'), Math.trunc(this.power + v)));
  }

  /** Run one state's controllers. Returns true if the state was changed. */
  private runState(no: number): boolean {
    const cs = this.compiledState(no);
    if (!cs) return false;
    for (const c of cs.controllers) {
      if (!this.triggered(c)) continue;
      const isCurrent = no === this.stateNo;
      if (isCurrent && c.persistent !== 1) {
        const n = this.persist.get(c) ?? 0;
        this.persist.set(c, n + 1);
        if (c.persistent === 0 ? n > 0 : n % c.persistent !== 0) continue;
      }
      this.stateChanged = false;
      c.run(this);
      if (this.stateChanged) return true;
    }
    return false;
  }

  private triggered(c: CompiledController): boolean {
    for (const t of c.triggerAll) if (!truthy(t, this)) return false;
    for (const group of c.triggers) {
      let ok = true;
      for (const t of group) {
        if (!truthy(t, this)) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  /** Process states for this tick: -3, -2, -1, engine transitions, then current state. */
  runStates(): void {
    this.commands = activeCommands(this.prog.cmd, this.input, this.facing);
    for (const special of [-3, -2, -1]) {
      if (this.runState(special)) {
        this.runCurrent();
        return;
      }
    }
    this.engineTransitions();
    this.runCurrent();
  }

  private runCurrent(): void {
    // A ChangeState inside the new state restarts processing (bounded to avoid loops).
    for (let guard = 0; guard < 16; guard++) {
      if (!this.runState(this.stateNo)) return;
    }
    this.warn(`Bucle de ChangeState en el estado ${this.stateNo}`);
  }

  /** Hard-coded transitions MUGEN performs for players with control. */
  private engineTransitions(): void {
    if (!this.ctrl) return;
    const cmd = this.commands;
    const no = this.stateNo;
    if (this.stateType === 's' && (no === 0 || no === 20)) {
      if (cmd.has('holdup')) return this.changeState(40);
      if (cmd.has('holddown')) return this.changeState(10);
      const walk = cmd.has('holdfwd') || cmd.has('holdback');
      if (walk && no === 0) return this.changeState(20);
      if (!walk && no === 20) return this.changeState(0);
    } else if (this.stateType === 'c' && no === 11) {
      if (!cmd.has('holddown')) return this.changeState(12);
    } else if (this.stateType === 'a' && no === 50) {
      // Air jump.
      const n = this.const('movement.airjump.num');
      if (cmd.has('holdup') && n > 0 && this.airJumps < n && -this.pos.y >= this.const('movement.airjump.height') && this.input.at(1) !== this.input.at(0)) {
        this.airJumps++;
        return this.changeState(45);
      }
    }
  }
  airJumps = 0;

  // -------------------------------------------------------------------------
  // Physics, run after states each tick.

  physicsStep(): void {
    if (!this.posFreeze) {
      this.pos.x = Math.fround(this.pos.x + this.vel.x * this.facing);
      this.pos.y = Math.fround(this.pos.y + this.vel.y);
    }
    this.posFreeze = false;
    switch (this.physics) {
      case 's':
        this.vel.x = Math.fround(this.vel.x * this.const('movement.stand.friction'));
        break;
      case 'c':
        this.vel.x = Math.fround(this.vel.x * this.const('movement.crouch.friction'));
        break;
      case 'a':
        this.vel.y = Math.fround(this.vel.y + this.const('movement.yaccel'));
        if (this.pos.y >= 0 && this.vel.y > 0 && this.moveType !== 'h') {
          this.pos.y = 0;
          this.airJumps = 0;
          this.changeState(52);
          // Entered outside controller processing: the new state's Time = 0
          // controllers must still run next tick.
          this.freshState = true;
        }
        break;
    }
  }

  /**
   * Start of tick: advance the animation shown last tick. Doing this before
   * state processing (instead of after) means a newly set action is displayed
   * for exactly its element times, and `AnimTime = 0` fires on the tick the
   * action would wrap, so the wrapped frame is never drawn.
   */
  advanceAnim(): void {
    this.anim.tick();
  }

  /** End of tick: advance state time. */
  advance(): void {
    if (this.freshState) {
      this.freshState = false;
      return;
    }
    this.time++;
  }
  private freshState = false;
}

export type { ControllerDef };
