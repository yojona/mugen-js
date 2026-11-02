// Player runtime: state machine, physics and per-tick processing.

import { compileExprList, R, truthy, type Fn } from '../expr/compile';
import type { Animation } from '../formats/air';
import { parseIni } from '../formats/text';
import { AnimPlayer } from './anim';
import type { CharacterData } from './character';
import { activeCommands, InputHistory, parseCmd, type CommandSet } from './cmd';
import { parseConstants, parseStates, type Constants, type ControllerDef, type StateDef, type StateMap } from './cns';
import { compileController, type CompiledController } from './controllers';
import { emptyGetHitVars, type GetHitVars, type HitDefData } from './hitdef';
import { newAfterImage, newPalFx, type AfterImageState, type PalFxState } from './fx';
import type { Blend } from '../formats/air';
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
  /** [Quotes] victory1..victoryN from the constants file. */
  quotes: string[];
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
  const quotes: string[] = [];
  for (const doc of constDocs) {
    const q = doc.sections.find((s) => s.name.toLowerCase() === 'quotes');
    for (const e of q?.entries ?? []) if (/^victory\d+$/.test(e.key)) quotes.push(e.value.replace(/^"|"$/g, ''));
  }
  return { data, consts: parseConstants(constDocs), states, cmd, compiled: new Map(), quotes };
}

export interface Vec {
  x: number;
  y: number;
}

let nextId = 56; // MUGEN's first player ID

export class Player {
  readonly id = nextId++;
  /** Helpers with keyctrl share their root's input history. */
  input = new InputHistory();

  // Helper hierarchy
  isHelper = false;
  helperId = 0;
  parent: Player | undefined;
  /** Root player (self for root players). */
  root: Player = this;
  keyCtrl = true;
  /** Ticks this player may still move during a SuperPause / Pause. */
  superMoveTime = 0;
  pauseMoveTime = 0;
  /** Set by DestroySelf; the world removes the helper at end of tick. */
  destroyed = false;
  /** Projectile bookkeeping per ProjID (ticks since last hit/contact/guard/cancel). */
  projInfo = new Map<number, { hit: number; contact: number; guarded: number; cancel: number }>();
  commands = new Set<string>();

  /** Position and velocity in the character's own coordinate space (localcoord). */
  pos: Vec = { x: 0, y: 0 };
  vel: Vec = { x: 0, y: 0 };
  facing = 1;

  /**
   * World units per character unit: stage localcoord width / character
   * localcoord width (trigger.html Const240p: spaces convert by width ratio).
   */
  get scale(): number {
    return this.world.localWidth / (this.prog.data.def.localCoord[0] || 320);
  }
  /** Position in world (stage) units. */
  get wx(): number {
    return this.pos.x * this.scale;
  }
  get wy(): number {
    return this.pos.y * this.scale;
  }
  setWorldPos(x: number, y?: number): void {
    this.pos.x = x / this.scale;
    if (y !== undefined) this.pos.y = y / this.scale;
  }

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

  // Attacking
  hitDef: HitDefData | undefined;
  hitDefActive = false;
  /** Players already hit by the current HitDef. */
  hitTargets = new Set<Player>();
  /** P1 freeze after a hit (pausetime p1). */
  hitPause = 0;
  moveContact = 0;
  moveHit = 0;
  moveGuarded = 0;
  hitCount = 0;

  // Being hit
  ghv: GetHitVars = emptyGetHitVars();
  defenceMul = 1;
  /** NotHitBy / HitBy slots: allowed or blocked attributes for a time. */
  hitBy: { attrs: string[]; time: number; not: boolean }[] = [];
  /** HitOverride slots (0..7). */
  hitOverrides: ({ attrs: string[]; stateNo: number; time: number; forceAir: boolean } | undefined)[] = [];
  /** Juggle points left while airborne in a hit state. */
  juggleLeft = 0;
  /** Juggle cost of the current attack state (statedef `juggle`). */
  juggleCost = 0;
  posFreeze = false;
  alive = true;

  // Targets (players hit by this player's attacks), with the HitDef id.
  targets = new Map<Player, number>();
  /** TargetBind / BindTo*: position lock applied after physics. */
  bind: { to: Player; offset: [number, number]; time: number; byTarget?: boolean } | undefined;
  reversal: { attrs: string[]; hd: HitDefData } | undefined;

  /** When in another player's states (p2stateno / TargetState). */
  stateOwner: Player | undefined;

  // Per-tick flags (reset every tick before state processing)
  special = new Set<string>();
  trans: Blend | undefined;
  angleDraw = false;
  angle = 0;
  drawScale: [number, number] = [1, 1];
  drawOffset: [number, number] = [0, 0];
  width: { edge?: [number, number]; player?: [number, number] } = {};
  screenBound = true;
  moveCamera: [boolean, boolean] = [true, true];
  pushEnabled = true;

  // Visual effects
  palFx: PalFxState = newPalFx();
  afterImage: AfterImageState = newAfterImage();
  /** RemapPal: palette slot to draw with instead of palNo. */
  palRemap: number | undefined;

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
    return this.helperName ?? this.prog.data.def.name;
  }
  helperName: string | undefined;

  const(name: string): number {
    return this.prog.consts.get(name) ?? 0;
  }

  warn(msg: string): void {
    if (this.warnings.length < 200) this.warnings.push(msg);
  }

  // -------------------------------------------------------------------------
  // States

  /** Program whose states are running (own, or the attacker's for custom states). */
  get stateProg(): CharacterProgram {
    return this.stateOwner?.prog ?? this.prog;
  }

  compiledState(no: number): CompiledState | undefined {
    const prog = this.stateProg;
    let cs = prog.compiled.get(no);
    if (cs) return cs;
    const def = prog.states.get(no);
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
    prog.compiled.set(no, cs);
    return cs;
  }

  hasAnim(no: number): boolean {
    return this.prog.data.anims.has(no);
  }

  /** Change action; `fromOwner` uses the state owner's AIR (ChangeAnim2, custom-state statedef anim). */
  changeAnim(no: number, elem = 0, fromOwner = false): void {
    const src = fromOwner && this.stateOwner ? this.stateOwner.prog : this.prog;
    const a: Animation | undefined = src.data.anims.get(no);
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
    // Entered from outside controller processing (landing, being hit): the new
    // state's controllers first run next tick, still at Time = 0.
    if (!this.inStates) this.freshState = true;
    const d = cs.def.params;
    const flag = (k: string) => (parseInt(d.get(k) ?? '0', 10) || 0) !== 0;
    if (!flag('hitdefpersist')) {
      this.hitDefActive = false;
      this.hitTargets.clear();
    }
    if (!flag('movehitpersist')) this.moveContact = this.moveHit = this.moveGuarded = 0;
    if (!flag('hitcountpersist')) this.hitCount = 0;
    this.reversal = undefined;
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
      if (e && (e.wx - this.wx) * this.facing < 0) this.facing = -this.facing;
    }
    const juggle = num('juggle');
    if (juggle !== undefined) this.juggleCost = juggle;
    const anim = num('anim');
    if (anim !== undefined) this.changeAnim(anim, 0, true);
  }

  /** SelfState / being hit normally: return to own states. */
  returnToOwnStates(): void {
    this.stateOwner = undefined;
  }

  /** Drop targets that are no longer being hit. */
  pruneTargets(): void {
    for (const [t] of this.targets) if (t.moveType !== 'h' || t.world !== this.world) this.targets.delete(t);
  }

  addPower(v: number): void {
    this.power = Math.max(0, Math.min(this.const('data.power'), Math.trunc(this.power + v)));
  }

  /** Is this player immune to the given HitDef (NotHitBy / HitBy)? */
  immuneTo(hd: HitDefData): boolean {
    const st = hd.attrState;
    const ty = hd.attrType;
    for (const slot of this.hitBy) {
      if (slot.time <= 0) continue;
      // An empty state field (", NT, ST") means every state.
      const stateOk = slot.attrs[0] === '' || slot.attrs[0]!.includes(st);
      const typeOk = slot.attrs.slice(1).some((a) => a === ty || (a[0] === 'a' && a[1] === ty[1]) || (a[1] === 'a' && a[0] === ty[0]) || a === 'aa');
      const match = stateOk && (slot.attrs.length === 1 || typeOk);
      if (slot.not ? match : !match) return true;
    }
    return false;
  }

  /** Run one state's controllers. Returns true if the state was changed. */
  private runState(no: number): boolean {
    const cs = this.compiledState(no);
    if (!cs) return false;
    const paused = this.hitPause > 0;
    for (const c of cs.controllers) {
      if (paused && !c.ignoreHitPause) continue;
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
  private inStates = false;

  runStates(): void {
    // The pending Time = 0 pass happens now; time advances normally after it.
    this.freshState = false;
    this.inStates = true;
    try {
      this.runStatesInner();
    } finally {
      this.inStates = false;
    }
  }

  /** Reset effects that last a single tick unless re-asserted. */
  private resetTickFlags(): void {
    this.special.clear();
    this.trans = undefined;
    this.angleDraw = false;
    this.drawScale = [1, 1];
    this.drawOffset = [0, 0];
    this.width = {};
    this.screenBound = true;
    this.moveCamera = [true, true];
    this.pushEnabled = true;
  }

  private runStatesInner(): void {
    this.resetTickFlags();
    this.commands = activeCommands(this.prog.cmd, this.input, this.facing);
    if (this.hitPause > 0) {
      // Frozen by hit pause: only ignorehitpause controllers run.
      const sp = this.isHelper ? (this.keyCtrl ? [-1] : []) : [-3, -2, -1];
      for (const special of [...sp, this.stateNo]) this.runState(special);
      return;
    }
    this.engineHitTransitions();
    // Helpers skip -3/-2, and -1 unless they read input (cns.html).
    const specials = this.isHelper ? (this.keyCtrl ? [-1] : []) : [-3, -2, -1];
    for (const special of specials) {
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

  /**
   * Engine rules for downed players: lying in state 5110 counts down
   * data.liedown.time (faster when buttons are pressed), then gets up via 5120.
   */
  private engineHitTransitions(): void {
    if (this.stateNo !== 5110 || !this.alive) return;
    const g = this.ghv;
    if (this.time === 0) g.recovertime = this.const('data.liedown.time');
    const newly = this.input.at(0) & ~this.input.at(1) & ~0xf;
    g.recovertime -= newly ? 2 : 1;
    if (g.recovertime <= 0 && this.time > 0) this.changeState(5120);
  }

  /** Hard-coded transitions MUGEN performs for players with control. */
  private engineTransitions(): void {
    if (!this.ctrl || this.isHelper) return;
    const cmd = this.commands;
    const no = this.stateNo;
    // Guard: holding back with an attacker in range.
    const guardOk = !this.special.has(this.stateType === 'a' ? 'noairguard' : this.stateType === 'c' ? 'nocrouchguard' : 'nostandguard');
    if (guardOk && cmd.has('holdback') && this.inGuardDist() && this.moveType === 'i' && (no < 120 || no > 155)) {
      return this.changeState(120);
    }
    if (this.stateType === 's' && (no === 0 || no === 20)) {
      if (cmd.has('holdup')) return this.changeState(40);
      if (cmd.has('holddown')) return this.changeState(10);
      const walk = cmd.has('holdfwd') || cmd.has('holdback');
      if (walk && no === 0 && !this.special.has('nowalk')) return this.changeState(20);
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

  /** Body half-width toward the front or back, for edges or player push. */
  bodyWidth(side: 'front' | 'back', kind: 'edge' | 'player'): number {
    const o = kind === 'edge' ? this.width.edge : this.width.player;
    if (o) return side === 'front' ? o[0] : o[1];
    const air = this.stateType === 'a';
    return this.const(`size.${air ? 'air' : 'ground'}.${side}`);
  }

  /** Current drawn frame (for AfterImage history), in world units. */
  drawFrame(): import('./fx').AfterImageFrame | undefined {
    const v = this.anim.view();
    if (!v || v.element.group < 0) return undefined;
    const sprite = this.prog.data.sff.get(v.element.group, v.element.number);
    if (!sprite) return undefined;
    const k = this.scale;
    return {
      sprite,
      palette: this.prog.data.paletteFor(sprite, this.palRemap ?? this.palNo),
      x: (this.pos.x + this.facing * v.x) * k,
      y: (this.pos.y + v.y) * k,
      scaleX: this.facing * (v.element.flipH ? -1 : 1) * v.scaleX * k * this.const('size.xscale'),
      scaleY: (v.element.flipV ? -1 : 1) * v.scaleY * k * this.const('size.yscale'),
      angle: this.facing * v.angle,
    };
  }

  /** InGuardDist: an opponent is attacking within its guard distance. */
  inGuardDist(): boolean {
    for (const e of this.world.players) {
      if (e.side === this.side || e.moveType !== 'a') continue;
      const dist = e.hitDefActive && e.hitDef ? e.hitDef.guardDist : e.const('size.attack.dist');
      // Distance in the attacker's units.
      const dx = ((this.wx - e.wx) * e.facing) / e.scale;
      if (dx >= 0 && dx <= dist) return true;
    }
    return false;
  }

  physicsStep(): void {
    if (this.hitPause > 0 || this.ghv.hitshaketime > 0) return;
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
    if (this.hitPause > 0 || (this.moveType === 'h' && this.ghv.hitshaketime > 0)) return;
    this.anim.tick();
  }

  /** End of tick: advance state time. */
  advance(): void {
    for (const s of this.hitBy) if (s.time > 0) s.time--;
    for (const o of this.hitOverrides) if (o && o.time > 0) o.time--;
    if (this.hitPause > 0) {
      this.hitPause--;
      return;
    }
    const g = this.ghv;
    if (g.hitshaketime > 0) g.hitshaketime--;
    else if (this.moveType === 'h') {
      if (g.hittime > 0) g.hittime--;
      if (g['fall.recovertime'] > 0) g['fall.recovertime']--;
    }
    for (const info of this.projInfo.values()) {
      for (const k of ['hit', 'contact', 'guarded', 'cancel'] as const) if (info[k] >= 0) info[k]++;
    }
    if (this.moveContact) this.moveContact++;
    if (this.moveHit) this.moveHit++;
    if (this.moveGuarded) this.moveGuarded++;
    if (this.freshState) {
      this.freshState = false;
      return;
    }
    this.time++;
  }
  private freshState = false;
}

export type { ControllerDef };
