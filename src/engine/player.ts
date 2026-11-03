// Player runtime: state machine, physics and per-tick processing.

import { hitDefAttrBits } from './hitdef';
import { STATEDEF_SPEC } from './sctrl-spec';
import { compileExprList, R, truthy, type Fn } from '../expr/compile';
import type { Animation } from '../formats/air';
import { parseIni } from '../formats/text';
import { AnimPlayer } from './anim';
import { parseAiFile } from './ai-learn';
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
  /** CPU AI move records kept for the session (mugen.exe chardata+0x64c). */
  aiRecords?: { sc: import('./ai-learn').RecordTable; air: import('./ai-learn').RecordTable };
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
  let cmd: CommandSet = { commands: [], names: new Set(), slots: 0, size: 0 };
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
  // Learned AI shipped with the character (<def name>.ai), like mugen.exe.
  const aiPath = data.defPath.replace(/\.def$/i, '.ai');
  const aiRecords = vfs.resolve(aiPath) ? parseAiFile(await vfs.read(aiPath)) : undefined;
  return { data, consts: parseConstants(constDocs), states, cmd, compiled: new Map(), quotes, aiRecords };
}

export interface Vec {
  x: number;
  y: number;
}

let nextId = 56; // MUGEN's first player ID

/** [Statedef] keys holding expressions (sctrl-spec.ts STATEDEF_SPEC). */
const STATEDEF_EXPR_KEYS = new Set(STATEDEF_SPEC.filter((s) => s.kind.k !== 'word').map((s) => s.key));

export class Player {
  readonly id = nextId++;
  /** Helpers with keyctrl share their root's input history. */
  input = new InputHistory();
  /** Corner push (HitDef *.cornerpush.veloff): facing-relative x per tick. */
  cornerPushVel = 0;
  /** HitDef snap/mindist/maxdist, applied when this player next updates. */
  pendingPlacement: (() => void) | undefined;
  /** Hit pause seen by the previous tick's input processing. */
  hitPauseLastTick = false;
  /** CPU control (MUGEN's AI); undefined for human players. */
  ai?: import('./ai').MugenAI;
  /** AI learning recorder (every root player, CPU or human). */
  recorder?: import('./ai-learn').Recorder;
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
  /**
   * The last projectile contact (mugen.exe keeps one): 0 none, 1 guarded,
   * 2 hit, 3 cancelled; the projectile's ID and the ticks since.
   */
  projContact = 0;
  projContactId = 0;
  projContactTime = 0;
  commands = new Set<string>();

  /** Position and velocity in the character's own coordinate space (localcoord). */
  pos: Vec = { x: 0, y: 0 };
  vel: Vec = { x: 0, y: 0 };
  private facingValue = 1;
  /**
   * mugen.exe keeps velocities in world space (VelSet multiplies by facing),
   * so turning around does not change where a player is moving. Ours are
   * relative to facing: a turn flips the x velocity to keep it in place.
   */
  get facing(): number {
    return this.facingValue;
  }
  set facing(v: number) {
    if (v !== this.facingValue) this.vel.x = -this.vel.x;
    this.facingValue = v;
  }

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
  /**
   * A HitDef was set in this state and not reset by a state change; unlike
   * hitDefActive it survives the hit (the AI recorder's p+0x1230).
   */
  hitDefSet = false;
  /** Players already hit by the current HitDef. */
  hitTargets = new Set<Player>();
  /** P1 freeze after a hit (pausetime p1). */
  hitPause = 0;
  /** Set on the tick a hit pause starts: that tick still advances normally. */
  hitPauseFresh = false;
  /** Damage from a hit, applied at the end of the next tick (measured). */
  /**
   * Damage held back until the defender's next update (Player_Update
   * applies gethit_damage), stamped with the tick of the hit.
   */
  pendingDamage: { amount: number; kill: boolean; tick: number } | undefined;
  /** Tick of the last hit: the shake starts counting at the next update. */
  shakeTick = -1;
  private pauseAtLastTickStart = 0;
  moveContact = 0;
  moveHit = 0;
  moveGuarded = 0;
  hitCount = 0;

  // Being hit
  ghv: GetHitVars = emptyGetHitVars();
  defenceMul = 1;
  /** Rounds this player has played to their end (RoundsExisted). */
  roundsExisted = 0;
  /**
   * hitdef.guard_dist: reset to size.attack.dist on entering a state
   * without hitdefpersist, set by a HitDef's guard.dist and AttackDist; it
   * counts whenever the player is attacking (Player_InGuardDist).
   */
  guardDist = 0;
  /** AttackMulSet's multiplier (value * data.attack / 100); unset = data.attack / 100. */
  attackMul: number | undefined;
  /** mugen.exe's defence_mul: 100 / defence, DefenceMulSet, SuperPause p2defmul. */
  get defenceFactor(): number {
    return Math.fround((Math.fround(100 / Math.max(1, this.const('data.defence'))) * this.defenceMul) / this.superDefMul);
  }
  /**
   * Player_ApplyDamage (0x43F8xx), for LifeAdd and TargetLifeAdd: a negative
   * amount is scaled by the defence unless absolute (at least 1), and it
   * leaves 1 life when it cannot kill.
   */
  applyLifeAdd(v: number, kill: boolean, absolute: boolean): void {
    let d = v;
    if (!absolute) {
      if (v < 0) d = Math.trunc(this.defenceFactor * v - 0.5);
      if (v <= -1 && d === 0) d = -1;
    }
    d += this.life;
    if (d < 1 && !kill) d = 1;
    this.life = Math.min(this.const('data.life'), Math.max(0, d));
    if (this.life <= 0) this.alive = false;
  }
  get attackFactor(): number {
    return this.attackMul ?? this.const('data.attack') / 100;
  }
  /** SuperPause p2defmul on a target, until it recovers from the hit. */
  superDefMul = 1;
  /** NotHitBy / HitBy slots: allowed or blocked attributes for a time. */
  /** HitBy / NotHitBy attribute masks (hitby_attr, nothitby_attr) and their times. */
  hitBy: { mask: number; time: number }[] = [];
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
  /** P2 for this tick (World.updateEnemies); null: none, undefined: not picked yet. */
  enemy: Player | null | undefined = undefined;
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
    this.guardDist = this.const('size.attack.dist');
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

  compiledState(no: number, own = false): CompiledState | undefined {
    const prog = own ? this.prog : this.stateProg;
    let cs = prog.compiled.get(no);
    if (cs) return cs;
    const def = prog.states.get(no);
    if (!def) return undefined;
    const env = playerEnv;
    const params = new Map<string, Fn<Player>[]>();
    for (const [k, v] of def.params) {
      // Only the keys mugen.exe reads (StateDef_Parse); the words are read elsewhere.
      if (!STATEDEF_EXPR_KEYS.has(k)) continue;
      try {
        params.set(k, compileExprList(v, env));
      } catch (e) {
        this.warn(`Statedef ${no}: ${k}: ${(e as Error).message}`);
      }
    }
    const controllers: CompiledController[] = [];
    for (const c of def.controllers) {
      try {
        controllers.push(compileController(c, env, prog.data.def.mugenVersion));
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
    if (!cs && no !== 0) {
      // mugen.exe (Player_ChangeState 0x43BF40) changes to a missing state
      // anyway, with a warning: the state number moves and nothing runs.
      this.warn(`Estado ${no} no existe`);
      this.prevStateNo = this.stateNo;
      this.stateNo = no;
      this.time = 0;
      this.persist.clear();
      this.pendingEntry = false;
      if (!this.inStates) this.freshState = true;
      this.stateChanged = true;
      this.changedStateThisTick = true;
      this.pendingStateType = undefined;
      this.pendingVel = undefined;
      if (ctrl !== undefined) this.ctrl = ctrl;
      if (anim !== undefined) this.changeAnim(anim);
      return;
    }
    if (!cs) return;
    this.prevStateNo = this.stateNo;
    this.stateNo = no;
    this.time = 0;
    this.persist.clear();
    // mugen.exe (Player_ChangeState) only moves the state number; the
    // statedef (persist flags, type, physics, velset, anim, ctrl...) applies
    // when the state first runs (Player_RunState at Time = 0), so the special
    // states after a ChangeState in -2 still see the old ctrl.
    this.pendingEntry = true;
    // Entered from outside controller processing (landing, being hit): the new
    // state's controllers first run next tick, still at Time = 0.
    if (!this.inStates) this.freshState = true;
    // Lying down: the get-up countdown starts when 5110 is entered.
    // The get-up count starts with a falling hit and again on hitting the
    // ground (5100); lying down (5110) counts its entry tick (measured).
    if (no === 5100) {
      this.ghv.recovertime = this.const('data.liedown.time');
    }
    if (no === 5110) this.ghv.recovertime -= 1;
    this.stateChanged = true;
    this.changedStateThisTick = true;
    this.pendingStateType = undefined;
    this.pendingVel = undefined;
    // The controller's ctrl and anim come first; the statedef's win when it
    // applies (measured: 5210's ChangeState to 52 with ctrl = 1 lands without it).
    if (ctrl !== undefined) this.ctrl = ctrl;
    // Changes from outside the state machine (hits, landing) apply the
    // statedef now (measured; the hit code defers the statetype itself).
    if (!this.inStates) this.enterIfPending();
    if (anim !== undefined) this.changeAnim(anim);
  }
  /**
   * A hit changes state but keeps the old statetype until the new state first
   * runs (measured: a trip into 5070, type A, still shows S next tick).
   */
  pendingStateType: StateType | undefined;
  /** Statedef velset of a hit state, applied when the state first runs. */
  pendingVel: { x: number; y: number } | undefined;

  /** Statedef *persist flags: what carries over from the previous state. */
  private resetPersist(cs: CompiledState): void {
    const d = cs.def.params;
    const flag = (k: string) => (parseInt(d.get(k) ?? '0', 10) || 0) !== 0;
    if (!flag('hitdefpersist')) {
      this.guardDist = this.const('size.attack.dist');
      this.hitDefActive = false;
      this.hitDefSet = false;
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

  /**
   * Rd_ResetToOwnStates: back to the player's own state 0 by number; its
   * statedef applies when it runs (this tick: the round code runs first).
   */
  resetToOwnState0(): void {
    this.stateOwner = undefined;
    this.prevStateNo = this.stateNo;
    this.stateNo = 0;
    this.time = 0;
    this.persist.clear();
    this.pendingEntry = true;
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
    // Player_HitByAllows: both masks and the HitDef's attr must share a
    // state bit and an attack bit.
    let m = hitDefAttrBits(hd.attrState, hd.attrType);
    for (const slot of this.hitBy) if (slot && slot.time > 0) m &= slot.mask;
    return (m & 7) === 0 || (m & ~7) === 0;
  }

  /** Run one state's controllers. Returns true if the state was changed. */
  /** The statedef of a newly entered state, applied when it first runs. */
  private enterIfPending(): void {
    // Not during a hit pause (Player_RunState: hitpause_time <= 0).
    if (!this.pendingEntry || this.hitPause > 0) return;
    this.pendingEntry = false;
    const cs = this.compiledState(this.stateNo);
    // A capture before that still sees the old MoveContact (measured: 400 -> 12).
    if (cs) {
      this.resetPersist(cs);
      this.applyStatedef(cs);
    }
  }

  private runState(no: number): boolean {
    if (no === this.stateNo && no >= 0) this.enterIfPending();
    // Special states always come from the player's own files
    // (Player_RunSpecialState RUNSTATE_OWN).
    const cs = this.compiledState(no, no < 0);
    if (!cs) {
      // A missing current state (Player_RunState): on its first tick the hit
      // counts, move contact and HitDef attr are cleared; nothing else runs.
      if (no === this.stateNo && no >= 0 && this.time === 0 && this.hitPause <= 0) {
        this.hitCount = 0;
        this.moveContact = this.moveHit = this.moveGuarded = 0;
        if (this.hitDef) this.hitDef.attrType = '';
        this.hitDefActive = false;
      }
      return false;
    }
    const paused = this.hitPause > 0;
    const rec = this.recorder;
    const isCurrent = no === this.stateNo;
    for (const c of cs.controllers) {
      if (paused && !c.ignoreHitPause) continue;
      // Player_RunState: a controller of the current state waits out its
      // persistence timer (frames, not firings) without testing its
      // triggers; the special states (-1/-2/-3) have no timers.
      const wait = isCurrent && c.persistent !== 1 ? this.persist.get(c) ?? 0 : 0;
      const tick = () => {
        if (!isCurrent || c.persistent <= 0) return;
        const t = ((this.persist.get(c) ?? 0) - 1) & 0xff;
        this.persist.set(c, t & 0x80 ? 0 : t);
      };
      if (wait !== 0) {
        tick();
        continue;
      }
      // mugen.exe 0x45c209: the command= triggers seen by this controller.
      rec?.beforeController();
      if (this.world.randomTrace) this.world.traceCtx = `${this.name}${this.isHelper ? ' helper' : ''} ${no} ${c.def.file}:${c.def.line}`;
      if (!this.triggered(c)) {
        this.world.traceCtx = '';
        tick();
        continue;
      }
      if (isCurrent && c.persistent !== 1) this.persist.set(c, c.persistent > 0 ? c.persistent & 0xff : 1);
      this.stateChanged = false;
      const custom = !!this.stateOwner;
      c.run(this);
      if (this.world.randomTrace) {
        if (this.stateChanged) this.world.randomTrace.push(`=> ${this.stateNo} by ${this.world.traceCtx}`);
        this.world.traceCtx = '';
      }
      if (this.stateChanged) {
        // 0x448f50: a command-triggered state change starts a move record
        // and tells the CPU players (not from or into custom states).
        if (rec && !custom && !this.stateOwner) rec.afterStateChange();
        return true;
      }
      tick();
    }
    return false;
  }

  private triggered(c: CompiledController): boolean {
    const w = this.world;
    const tr = w.randomTrace !== undefined;
    const base = tr ? w.traceCtx : '';
    for (let i = 0; i < c.triggerAll.length; i++) {
      if (tr) w.traceCtx = `${base} ta${i}`;
      if (!truthy(c.triggerAll[i]!, this)) return false;
    }
    for (let g = 0; g < c.triggers.length; g++) {
      const group = c.triggers[g]!;
      let ok = true;
      for (let j = 0; j < group.length; j++) {
        if (tr) w.traceCtx = `${base} t${g + 1}.${j}`;
        if (!truthy(group[j]!, this)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        if (tr) w.traceCtx = `${base} run`;
        return true;
      }
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

  /**
   * Player_Update: -3 and -2 for players (not normal helpers), -1 with key
   * control; in someone else's states only -2 runs (-3 and -1 lack
   * RUNSTATE_CUSTOM).
   */
  private specialStates(): number[] {
    const custom = !!this.stateOwner;
    const out: number[] = [];
    if (!this.isHelper) {
      if (!custom) out.push(-3);
      out.push(-2);
    }
    if (this.keyCtrl && !custom) out.push(-1);
    return out;
  }

  private runStatesInner(): void {
    this.resetTickFlags();
    // Helpers with keyctrl read their root's command buffer.
    if (this.isHelper) this.commands = this.keyCtrl ? this.root.commands : new Set();
    if (this.hitPause > 0) {
      // Frozen by hit pause: only ignorehitpause controllers run.
      for (const special of this.specialStates()) this.runState(special);
      this.runState(this.stateNo);
      return;
    }
    // Helpers skip -3/-2, and -1 unless they read input (cns.html).
    const specials = this.specialStates();
    // A ChangeState ends only the pass of its own special state; the next
    // one still runs (mugen.exe Player_Update: -3, -2 and -1 are separate
    // Player_RunSpecialState calls).
    let changed = false;
    for (const special of specials) if (this.runState(special)) changed = true;
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
  enterLater(no: number): void {
    if (!this.compiledState(no)) return;
    this.prevStateNo = this.stateNo;
    this.stateNo = no;
    this.time = 0;
    this.persist.clear();
    // The state change itself drops "HitDef set in this state" (measured:
    // KFM's 800 throw, sent to 810 by p1stateno, is never recorded by the
    // CPU's learning in mugen.exe).
    this.hitDefSet = false;
    this.pendingEntry = true;
    // Entered from outside controller processing (a hit's p1stateno): Time
    // stays 0 until the state first runs, as with changeState.
    if (!this.inStates) this.freshState = true;
  }
  private pendingEntry = false;

  private runCurrent(): void {
    if (this.pendingStateType) {
      this.stateType = this.pendingStateType;
      this.pendingStateType = undefined;
    }
    if (this.pendingVel) {
      this.vel.x = this.pendingVel.x;
      this.vel.y = this.pendingVel.y;
      this.pendingVel = undefined;
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
  /**
   * Every key event the player's input consumes shortens the get-up wait
   * (mugen.exe 0x43557f, truncated): to 75% lying down, else to 90% while
   * falling. Part of input processing, so it runs every tick, hit pause
   * included (measured: a CPU mashing while knocked down).
   */
  keyEventRecovery(): void {
    const g = this.ghv;
    // Not on the first tick after the hit (measured: a CPU mashing through a
    // trip gets up a tick later than counting that tick).
    const fresh = this.recoverFresh;
    this.recoverFresh = false;
    if (fresh || !this.cmdInput?.lastEvent || this.moveType !== 'h') return;
    if (this.stateType === 'l') g.recovertime = Math.trunc(g.recovertime * 0.75);
    // p+0x110c is GetHitVar(fallcount).
    else if (g.fallcount > 0) g.recovertime = Math.trunc(g.recovertime * 0.9);
  }

  private engineHitTransitions(): void {
    // Guard end (140) has no exit in common1.cns: when its animation ends the
    // engine returns to standing, crouching or falling, and the new state runs
    // this same tick (measured: Time = 1 on the next tick).
    if (this.stateNo === 140 && this.ctrl && this.anim.animTime() >= 0) {
      this.changeState(this.stateType === 'c' ? 11 : this.stateType === 'a' ? 51 : 0);
      return;
    }
    const g = this.ghv;
    if (this.stateNo !== 5110 || !this.alive) return;
    // mugen.exe 0x43cb34: get up once the count is spent, else count down.
    if (g.recovertime <= 0 && this.time > 0) this.changeState(5120);
    else g.recovertime -= 1;
  }

  /**
   * Built-in transitions (walk, crouch, stand up, jump, guard...). The world
   * runs them for every player at the start of the tick, before anyone's
   * states (measured: P2's guard check does not see an attack P1 starts in
   * the same tick). The new state shows Time = 0 and its statedef is applied
   * when it runs.
   */
  startOfTick(): void {
    this.updateGuardFlag();
    // Built-in transitions run in hit pause too (mugen.exe 0x434db0 has no
    // pause check; measured: a crouch attack's CPU stands up mid-pause).
    this.engineTransitions();
  }

  /**
   * p+0xee8, read by the CPU AI: recomputed every tick (mugen.exe 0x4351de):
   * holding back (not up), able to guard, and an opponent attacking or with
   * a projectile out, in range or not. Guarding a hit also sets it.
   */
  guardFlag = false;
  /** Hit this tick: the next input's key event does not shorten the get-up wait. */
  recoverFresh = false;
  private updateGuardFlag(): void {
    this.guardFlag = false;
    if (this.isHelper) return;
    const no = this.stateNo;
    const st = this.stateType;
    const ci = this.cmdInput;
    const back = ci ? ci.heldAt(4) !== 0 : this.commands.has('holdback');
    const up = ci ? ci.heldAt(1) !== 0 : this.commands.has('holdup');
    if (!back || up) return;
    if (!((this.moveType === 'i' && this.ctrl) || no === 52 || no === 151 || no === 153 || no === 155)) return;
    if (this.special.has(st === 'a' ? 'noairguard' : st === 'c' ? 'nocrouchguard' : 'nostandguard')) return;
    for (const e of this.world.players) {
      if (e.side === this.side) continue;
      if (e.moveType === 'a' || this.world.projectiles.some((pr) => pr.owner === e)) this.guardFlag = true;
    }
  }

  /** Hard-coded transitions MUGEN performs for players with control. */
  private engineTransitions(): void {
    if (this.isHelper) return;
    // mugen.exe 0x435144: one action from the held directions.
    const cmd = this.commands;
    const no = this.stateNo;
    const st = this.stateType;
    // Held keys (p+0x390..0x39c), not commands: an AI.Cheat "holdup" does
    // not jump (measured).
    const held = (k: number) => (this.cmdInput ? this.cmdInput.heldAt(k) !== 0 : cmd.has(['', 'holdup', 'holdfwd', 'holddown', 'holdback'][k]!));
    const up = held(1);
    const down = held(3);
    const fwd = held(2);
    const back = held(4);
    let action: 'walk' | 'jump' | 'crouch' | 'airjump' | 'guard' | 'none' = 'none';
    if (st === 's') {
      if (fwd !== back) action = 'walk';
      if (down) action = 'crouch';
      if (up) action = 'jump';
    } else if (st === 'a' && this.cmdInput?.upPressed) action = 'airjump';
    // Guard: holding back (not up) with an attacker in range.
    const guardOk = !this.special.has(st === 'a' ? 'noairguard' : st === 'c' ? 'nocrouchguard' : 'nostandguard');
    if (back && !up && guardOk && ((this.moveType === 'i' && this.ctrl) || no === 52 || no === 151 || no === 153 || no === 155) && this.inGuardDist()) {
      action = 'guard';
    }
    if (fwd && back) action = 'none';
    if (!this.ctrl) {
      if (action === 'none' && no === 20) this.enterLater(0);
      return;
    }
    switch (action) {
      case 'guard':
        if (this.moveType !== 'i' || [120, 130, 131, 132, 140].includes(no)) return;
        // Starting to guard stops the player, except in the air or running
        // (measured: a backward walk stops at once, a jump keeps its speed).
        if (st !== 'a' && no !== 100) this.vel.x = 0;
        return this.enterLater(120);
      case 'walk':
        if (no !== 20 && !this.special.has('nowalk')) this.enterLater(20);
        return;
      case 'jump':
        if (this.world.roundState !== 3) this.enterLater(40);
        return;
      case 'crouch':
        // Crouching from a walk stops at once (measured).
        if (no !== 100) this.vel.x = 0;
        if (no !== 10 && no !== 11) this.enterLater(10);
        return;
      case 'airjump': {
        // The height is compared with y in internal (GameWidth) units, the
        // constant unscaled (mugen.exe 0x43539f; measured: KFM air-jumps 32
        // units up with airjump.height = 35).
        const yInternal = -this.wy * (this.world.gameWidth / this.world.screenWidth);
        if (this.airJumpsLeft > 0 && yInternal > this.const('movement.airjump.height')) {
          this.airJumpsLeft--;
          this.enterLater(45);
        }
        return;
      }
      default:
        if (no === 20) return this.enterLater(0);
        // Releasing down stands up from any crouching state with control
        // (measured: 10 -> 12, and 400 -> 12 once its CtrlSet gives control).
        if (st === 'c' && !down) this.enterLater(12);
    }
  }
  /**
   * Air jumps left (p+0x278): airjump.num on the first tick of state 40,
   * none after a hit or at round start (mugen.exe 0x43c972 / 0x43f6d4).
   */
  airJumpsLeft = 0;

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
    // Player_InEnemyGuardDist / Player_InGuardDist (0x4347A0): any enemy
    // player or helper that is attacking, or any of its projectiles with an
    // active HitDef, with this player in front within the guard distance.
    for (const e of this.world.allPlayers()) {
      if (e.side === this.side || e.destroyed) continue;
      if (e.moveType === 'a') {
        const dist = e.guardDist;
        // Distance in the attacker's units.
        const dx = ((this.wx - e.wx) * e.facing) / e.scale;
        if (dx >= 0 && dist > dx) return true;
      }
    }
    for (const pr of this.world.projectiles) {
      const e = pr.owner;
      // Until removed (hit/remove anims too): its HitDef stays active.
      if (e.side === this.side || pr.phase === 'dead') continue;
      const dx = ((this.wx - pr.x) * pr.facing) / e.scale;
      if (dx >= 0 && pr.hd.guardDist > dx) return true;
    }
    return false;
  }

  physicsStep(): void {
    // Guard states keep the guard flag up (mugen.exe 0x43c980 / 0x43ca01).
    const no = this.stateNo;
    if (no === 120 || (no >= 130 && no <= 132) || no === 140 || (no >= 150 && no <= 155)) this.guardFlag = true;
    if (no === 40 && this.time === 0) this.airJumpsLeft = this.const('movement.airjump.num');
    // HitDef placement lands after P2's next states (measured: one tick later).
    if (this.pendingPlacement) {
      this.pendingPlacement();
      this.pendingPlacement = undefined;
    }
    if (this.hitPause > 0 || (this.ghv.hitshaketime > 1 && this.moveType === 'h')) return;
    // The corner push waits out a SuperPause (mugen.exe: pause_kind != 1,
    // from the frame after the one that starts it).
    if (this.cornerPushVel && !(this.world.superPause && !this.world.superPause.fresh)) {
      this.pos.x = this.pos.x + this.cornerPushVel * this.facing;
      this.cornerPushVel *= 0.7;
      if (Math.abs(this.cornerPushVel) < 0.5) this.cornerPushVel = 0;
    }
    if (!this.posFreeze) {
      this.pos.x = this.pos.x + this.vel.x * this.facing;
      this.pos.y = this.pos.y + this.vel.y;
    }
    this.posFreeze = false;
    switch (this.physics) {
      case 's':
        this.vel.x = this.vel.x * Math.fround(this.const('movement.stand.friction'));
        // Standing friction stops the player once the speed drops below 1
        // (measured: KFM's 200/210/240/400 hit slides end at 0.905, 0.920,
        // 0.853 and 0.543 while 1.004 and 1.065 still slide; the Triple Kung
        // Fu Palm's lunge stops the same way).
        if (Math.abs(this.vel.x) < 1) this.vel.x = 0;
        break;
      case 'c':
        this.vel.x = this.vel.x * Math.fround(this.const('movement.crouch.friction'));
        break;
      case 'a':
        this.vel.y = this.vel.y + Math.fround(this.const('movement.yaccel'));
        // State 105 (hop back) is exempt: it lands through its own
        // ChangeState (mugen.exe 0x43cd63 compares stateno with 105).
        if (this.pos.y >= 0 && this.vel.y > 0 && this.stateNo !== 105) {
          this.pos.y = 0;
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
    if (this.moveType !== 'h') this.superDefMul = 1;
    for (const s of this.hitBy) if (s.time > 0) s.time--;
    for (const o of this.hitOverrides) if (o && o.time > 0) o.time--;
    if (this.pendingDamage && this.pendingDamage.tick < this.world.gameTime) this.applyPendingDamage();
    if (this.hitPause > 0 && !this.hitPauseFresh) {
      this.hitPause--;
      return;
    }
    const fresh = this.hitPauseFresh;
    this.hitPauseFresh = false;
    const g = this.ghv;
    // The hit time counts down from the tick the shake ends, down to -1
    // (HitOver is hittime < 0, mugen.exe 0x4574d8), and keeps running out
    // after control returns (measured: a guard hit's HitOver turns 1 three
    // ticks into the jump that ended it; a throw with hittime 0 is not over
    // during its shake).
    const shakeFresh = this.shakeTick === this.world.gameTime;
    // Like the attacker's pause, the shake starts counting next tick.
    if (g.hitshaketime > 0 && !shakeFresh) g.hitshaketime--;
    if (g.hitshaketime <= 0 && !shakeFresh && g.hittime >= 0) g.hittime--;
    // fall.recovertime also counts down during the hit shake (measured: a
    // CPU recovers from 5050 one tick earlier than counting after it).
    if (this.moveType === 'h' && g['fall.recovertime'] > 0) g['fall.recovertime']--;
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
