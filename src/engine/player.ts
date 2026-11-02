// Player runtime: state machine, physics and per-tick processing.

import { compileExprList, R, truthy, type Fn } from '../expr/compile';
import type { Animation } from '../formats/air';
import { parseIni } from '../formats/text';
import { AnimPlayer } from './anim';
import type { CharacterData } from './character';
import { CommandInput, InputHistory, parseCmd, type CommandSet } from './cmd';
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
  // MUGEN 1.1's load order (mugen.log): st files in order, then the cmd's
  // state entries, then stcommon. The first definition of any state wins,
  // special states included (measured: a second [Statedef -2] is ignored).
  // The cns file only provides constants.
  let cmd: CommandSet = { commands: [], names: new Set(), slots: 0 };
  if (f.cns) constDocs.push(parseIni(await vfs.text(f.cns, dir)));
  for (const st of f.st) parseStates(await vfs.text(st, dir), st, states);
  if (f.cmd) {
    const text = await vfs.text(f.cmd, dir);
    cmd = parseCmd(text);
    parseStates(text, f.cmd, states);
  }
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
  /** MUGEN's command pipeline (root players; World.tick feeds it every tick). */
  cmdInput?: CommandInput;

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
  /** Set on the tick a hit pause starts: that tick still advances normally. */
  hitPauseFresh = false;
  /** Damage from a hit, applied at the end of the next tick (measured). */
  pendingDamage: { amount: number; kill: boolean; delay: number } | undefined;
  shakeFresh = false;
  private pauseAtLastTickStart = 0;
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
  /** Set by ChangeState; World clears it each tick (auto-turn on entering a state). */
  changedStateThisTick = false;

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
    // Supersedes a built-in transition still waiting to apply its statedef.
    this.pendingEntry = false;
    // Entered from outside controller processing (landing, being hit): the new
    // state's controllers first run next tick, still at Time = 0.
    if (!this.inStates) this.freshState = true;
    this.resetPersist(cs);
    // Lying down: the get-up countdown starts when 5110 is entered.
    if (no === 5110) this.ghv.recovertime = this.const('data.liedown.time');
    this.stateChanged = true;
    this.changedStateThisTick = true;
    this.pendingStateType = undefined;
    this.applyStatedef(cs);
    if (ctrl !== undefined) this.ctrl = ctrl;
    if (anim !== undefined) this.changeAnim(anim);
  }
  /**
   * A hit changes state but keeps the old statetype until the new state first
   * runs (measured: a trip into 5070, type A, still shows S next tick).
   */
  pendingStateType: StateType | undefined;

  /** Statedef *persist flags: what carries over from the previous state. */
  private resetPersist(cs: CompiledState): void {
    const d = cs.def.params;
    const flag = (k: string) => (parseInt(d.get(k) ?? '0', 10) || 0) !== 0;
    if (!flag('hitdefpersist')) {
      this.hitDefActive = false;
      this.hitTargets.clear();
    }
    if (!flag('movehitpersist')) this.moveContact = this.moveHit = this.moveGuarded = 0;
    if (!flag('hitcountpersist')) this.hitCount = 0;
    this.reversal = undefined;
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

  /** Apply damage held back during the hit shake. */
  applyPendingDamage(): void {
    const d = this.pendingDamage;
    if (!d) return;
    this.pendingDamage = undefined;
    this.life = Math.max(d.kill ? 0 : Math.min(this.life, 1), this.life - d.amount);
    if (this.life <= 0) {
      this.alive = false;
      this.ghv.fall = 1;
    }
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
    // Helpers with keyctrl read their root's command buffer.
    if (this.isHelper) this.commands = this.keyCtrl ? this.root.commands : new Set();
    if (this.hitPause > 0) {
      // Frozen by hit pause: only ignorehitpause controllers run.
      const sp = this.isHelper ? (this.keyCtrl ? [-1] : []) : [-3, -2, -1];
      for (const special of [...sp, this.stateNo]) this.runState(special);
      return;
    }
    // Helpers skip -3/-2, and -1 unless they read input (cns.html).
    const specials = this.isHelper ? (this.keyCtrl ? [-1] : []) : [-3, -2, -1];
    let changed = false;
    for (const special of specials) {
      if (this.runState(special)) {
        changed = true;
        break;
      }
    }
    // Get-up from lying down happens after the special states and before the
    // current state runs (measured: 5110 Time = 60 is visible in -2).
    if (!changed) this.engineHitTransitions();
    this.runCurrent();
  }

  /**
   * Built-in transitions: the state number changes now; the statedef is
   * applied when the state runs later this tick (special states still see
   * the old statetype).
   */
  private enterLater(no: number): void {
    if (!this.compiledState(no)) return;
    this.prevStateNo = this.stateNo;
    this.stateNo = no;
    this.time = 0;
    this.persist.clear();
    this.pendingEntry = true;
  }
  private pendingEntry = false;

  private runCurrent(): void {
    if (this.pendingEntry) {
      this.pendingEntry = false;
      const cs = this.compiledState(this.stateNo);
      // Built-in transitions apply the new statedef when it first runs, so a
      // capture before that still sees the old MoveContact (measured: 400 -> 12).
      if (cs) {
        this.resetPersist(cs);
        this.applyStatedef(cs);
      }
    }
    // A ChangeState inside the new state restarts processing (bounded to avoid loops).
    for (let guard = 0; guard < 16; guard++) {
      if (!this.runState(this.stateNo)) return;
    }
    this.warn(`Bucle de ChangeState en el estado ${this.stateNo}`);
  }

  /**
   * Engine rules for downed players: lying in state 5110 counts down
   * data.liedown.time (shortened by key events), then gets up via 5120.
   */
  private engineHitTransitions(): void {
    // Guard end (140) has no exit in common1.cns: when its animation ends the
    // engine returns to standing, crouching or falling, and the new state runs
    // this same tick (measured: Time = 1 on the next tick).
    if (this.stateNo === 140 && this.ctrl && this.anim.animTime() >= 0) {
      this.changeState(this.stateType === 'c' ? 11 : this.stateType === 'a' ? 51 : 0);
      return;
    }
    if (this.stateNo !== 5110 || !this.alive) return;
    const g = this.ghv;
    // Every key event the player's input consumes this tick shortens the
    // wait to 75% (mugen.exe 0x43557f, truncated).
    if (this.cmdInput?.lastEvent) g.recovertime = Math.trunc(g.recovertime * 0.75);
    g.recovertime -= 1;
    if (g.recovertime <= 0 && this.time > 0) this.changeState(5120);
  }

  /**
   * Built-in transitions (walk, crouch, stand up, jump, guard...). The world
   * runs them for every player at the start of the tick, before anyone's
   * states (measured: P2's guard check does not see an attack P1 starts in
   * the same tick). The new state shows Time = 0 and its statedef is applied
   * when it runs.
   */
  startOfTick(): void {
    if (this.hitPause > 0) return;
    this.engineTransitions();
  }

  /** Hard-coded transitions MUGEN performs for players with control. */
  private engineTransitions(): void {
    if (!this.ctrl || this.isHelper) return;
    const cmd = this.commands;
    const no = this.stateNo;
    // Guard: holding back with an attacker in range.
    const guardOk = !this.special.has(this.stateType === 'a' ? 'noairguard' : this.stateType === 'c' ? 'nocrouchguard' : 'nostandguard');
    if (guardOk && cmd.has('holdback') && this.inGuardDist() && this.moveType === 'i' && (no < 120 || no > 155)) {
      // Starting to guard stops a backward walk at once (measured: vel x = 0).
      this.vel.x = 0;
      return this.enterLater(120);
    }
    const guarding = no >= 120 && no <= 155;
    if (this.stateType === 's' && !guarding) {
      // Any standing state with control, not just 0/20 (measured: holding
      // forward in 12 with control walks on the next tick).
      if (cmd.has('holdup')) return this.enterLater(40);
      if (cmd.has('holddown')) {
        // Crouching from a walk stops at once, like starting to guard (measured).
        this.vel.x = 0;
        return this.enterLater(10);
      }
      const walk = cmd.has('holdfwd') || cmd.has('holdback');
      if (walk && no !== 20 && !this.special.has('nowalk')) return this.enterLater(20);
      if (!walk && no === 20) return this.enterLater(0);
    } else if (this.stateType === 'c' && !guarding) {
      // Releasing down stands up from any crouching state with control
      // (measured: 10 -> 12, and 400 -> 12 once its CtrlSet gives control).
      if (!cmd.has('holddown')) return this.enterLater(12);
    } else if (this.stateType === 'a' && no === 50) {
      // Air jump.
      const n = this.const('movement.airjump.num');
      if (cmd.has('holdup') && n > 0 && this.airJumps < n && -this.pos.y >= this.const('movement.airjump.height') && this.input.raw(1) !== this.input.raw(0)) {
        this.airJumps++;
        return this.enterLater(45);
      }
    }
  }
  airJumps = 0;

  // -------------------------------------------------------------------------
  // Physics, run after states each tick.

  /**
   * Body half-width toward the front or back, for edges or player push.
   * Width controller values are added to the defaults (measured: KFM's
   * `Width value = 15,0` grows the push distance from 32 to 47). Edge widths
   * default to 0 on top of the stage's screenleft/screenright.
   */
  bodyWidth(side: 'front' | 'back', kind: 'edge' | 'player'): number {
    const o = kind === 'edge' ? this.width.edge : this.width.player;
    const extra = o ? (side === 'front' ? o[0] : o[1]) : 0;
    if (kind === 'edge') return extra;
    const air = this.stateType === 'a';
    return this.const(`size.${air ? 'air' : 'ground'}.${side}`) + extra;
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
        // Get-hit slides stop once friction takes the speed below 1 (measured
        // with KFM's 200/210/240/400 hits: the slide ends at 0.905, 0.920,
        // 0.853 and 0.543 while 1.004 and 1.065 still slide). Normal states
        // stop earlier through common1's friction.threshold VelSets.
        if (this.moveType === 'h' && Math.abs(this.vel.x) < 1) this.vel.x = 0;
        break;
      case 'c':
        this.vel.x = Math.fround(this.vel.x * this.const('movement.crouch.friction'));
        break;
      case 'a':
        this.vel.y = Math.fround(this.vel.y + this.const('movement.yaccel'));
        if (this.pos.y >= 0 && this.vel.y > 0 && this.moveType !== 'h') {
          this.pos.y = 0;
          this.airJumps = 0;
          // Landing enters state 52 and runs it in the same tick (measured:
          // MUGEN shows Time = 1 and vel y = 0 on the next tick).
          this.inStates = true;
          try {
            this.changeState(52);
            this.runCurrent();
          } finally {
            this.inStates = false;
          }
          // The new state's physics also runs this tick: MUGEN moves again
          // and applies stand friction on the landing tick (measured).
          this.physicsStep();
          return;
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
    // Only the attacker's hit pause freezes the animation (the defender's shake
    // is common1 re-setting the anim each tick). Measured against MUGEN 1.1, the
    // freeze lags the pause by one tick at both ends: the animation is frozen
    // this tick if a pause was running at the start of the previous tick.
    const frozen = this.pauseAtLastTickStart > 0;
    this.pauseAtLastTickStart = this.hitPause;
    if (frozen) return;
    this.anim.tick();
  }

  /** End of tick: advance state time. */
  advance(): void {
    for (const s of this.hitBy) if (s.time > 0) s.time--;
    for (const o of this.hitOverrides) if (o && o.time > 0) o.time--;
    if (this.pendingDamage && this.pendingDamage.delay-- <= 0) this.applyPendingDamage();
    if (this.hitPause > 0 && !this.hitPauseFresh) {
      this.hitPause--;
      return;
    }
    const fresh = this.hitPauseFresh;
    this.hitPauseFresh = false;
    const g = this.ghv;
    if (g.hitshaketime > 0) {
      // Like the attacker's pause, the shake starts counting next tick.
      if (this.shakeFresh) this.shakeFresh = false;
      else g.hitshaketime--;
    }
    else if (this.moveType === 'h') {
      if (g.hittime > 0) g.hittime--;
      if (g['fall.recovertime'] > 0) g['fall.recovertime']--;
    }
    for (const info of this.projInfo.values()) {
      for (const k of ['hit', 'contact', 'guarded', 'cancel'] as const) if (info[k] >= 0) info[k]++;
    }
    if (!fresh) {
      if (this.moveContact) this.moveContact++;
      if (this.moveHit) this.moveHit++;
      if (this.moveGuarded) this.moveGuarded++;
    }
    if (this.freshState) {
      this.freshState = false;
      return;
    }
    this.time++;
  }
  private freshState = false;
}

export type { ControllerDef };
