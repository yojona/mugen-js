// Match world: players, camera, stage bounds and the fixed 60 Hz tick.

import { CommandInput } from './cmd';
import type { AnimationMap } from '../formats/air';
import type { Sff } from '../formats/sff';
import { clsn2TouchInternal, postResolvedMessages, Recorder } from './ai-learn';
import { applyHits, collideProjectiles, hitProjectilesByHitDefs, detectHits, detectProjectileHits } from './combat';
import { simpleExplod, updateExplod, type Explod } from './explod';
import { updateProjectile, type Projectile } from './projectile';
import { newPalFx, recordAfterImage, tickPalFx, type EnvShake, type PalFxState } from './fx';
import type { SoundRef, SparkRef } from './hitdef';
import type { Player } from './player';

/** Common effects (data/fightfx.air + .sff). */
export interface FightFx {
  anims: AnimationMap;
  sff: Sff;
}

interface PauseState {
  owner: Player;
  time: number;
  moveTime: number;
  fresh?: boolean;
  darken: boolean;
  unhittable: boolean;
  /** endcmdbuftime: in its last frames the paused players' commands stay active (floor 2). */
  endCmdBufTime: number;
}

export class World {
  players: Player[] = [];
  /** Stage localcoord width: the world's coordinate unit. */
  localWidth = 320;
  gameTime = 0;
  /**
   * mugen.exe's frame counter (g->frames), what the GameTime trigger reads:
   * it runs on through round intros, transitions and the KO slowdown. A Match
   * drives it once per frame; a bare World counts its own ticks.
   */
  frames = 0;
  framesDriven = false;
  roundState = 2; // 2 = fighting
  roundNo = 1;
  /** How the round ended (mugen.exe G win_type): 0 not yet, 1 KO, 2 time over. */
  winType: 0 | 1 | 2 = 0;
  /** Side (1 / 2) that won the round, 0 = none or draw. */
  roundWinnerSide = 0;
  camera = { x: 0, y: 0 };
  screenWidth = 320;
  /** mugen.cfg GameWidth: MUGEN's internal x units are this / screenWidth per stage unit. */
  gameWidth = 640;
  private aiRoundFight = false;
  /** Ticks since RoundState 2 began (the current tick included). */
  fightTime = 0;
  /**
   * round_state_time as the players' update sees it, when the match sets it
   * (RoundState 3 and 4 restart it); RoundState 2 uses fightTime.
   */
  roundClock: number | undefined;
  screenHeight = 240;
  /** Screen y of the ground line (stage zoffset). */
  groundY = 200;
  /** Stage bounds for the camera center. */
  boundLeft = -150;
  boundRight = 150;
  boundHigh = -25;
  boundLow = 0;
  /** Camera follows a player closer than this to a screen edge. */
  tension = 50;
  verticalFollow = 0.2;
  floorTension = 0;
  /** Players' x-range in the stage, and minimum distance to the screen edges. */
  leftBound = -1000;
  rightBound = 1000;
  screenLeft = 15;
  screenRight = 15;
  /** Set by the match flow outside RoundState 2. */
  inputLocked = false;
  /** hits_enabled: Players_CheckHits (push, hits, projectile hits) runs. */
  hitsEnabled = true;
  /** fight.def over.hittime: in RoundState 3 from then on the living take no damage. */
  overHitTime = Infinity;
  shadow: { intensity: number; color: [number, number, number]; yscale: number; fadeRange: [number, number] } | undefined;
  seed = 1;
  fightFx?: FightFx;
  explods: Explod[] = [];
  helpers: Player[] = [];
  projectiles: Projectile[] = [];
  /** Sounds requested this tick (common or player-owned), drained by the host. */
  sounds: { owner: Player | null; group: number; number: number }[] = [];
  envShake: EnvShake | undefined;
  bgPalFx: PalFxState = newPalFx();
  pause: PauseState | undefined;
  superPause: PauseState | undefined;
  /** A Pause requested during a SuperPause starts when the SuperPause ends. */
  private queuedPause: PauseState | undefined;

  /** Round_Reset: no pause, EnvShake or palette effect carries into a new round. */
  resetRoundFx(): void {
    this.pause = this.superPause = this.queuedPause = undefined;
    this.envShake = undefined;
    this.bgPalFx = newPalFx();
  }

  /** Root players followed by helpers. */
  allPlayers(): Player[] {
    return this.helpers.length ? [...this.players, ...this.helpers] : this.players;
  }

  /**
   * Helper player slots (index 5 up to HelperMax + 4 in mugen.exe): a new
   * helper takes the first free slot, so the update and hit order follows
   * the slots, not the creation order. `helpers` lists them in slot order.
   */
  helperSlots: (Player | null)[] = [];
  helperMax = 56;

  /** Returns false when every slot is taken (no helper is created). */
  addHelper(h: Player): boolean {
    let i = this.helperSlots.findIndex((x) => x === null || x.destroyed);
    if (i < 0) {
      if (this.helperSlots.length >= this.helperMax) return false;
      i = this.helperSlots.length;
    }
    this.helperSlots[i] = h;
    this.helpers = this.helperSlots.filter((x): x is Player => !!x && !x.destroyed);
    if (h.keyCtrl && h.root.cmdInput) h.cmdInput = h.root.cmdInput.clone();
    h.enemy = this.findEnemy(h) ?? null;
    return true;
  }

  helpersOf(p: Player, id?: number): Player[] {
    // Helpers_Count / Helper_Find: every helper of p's root (p itself
    // included), any of them for ID 0.
    return this.helpers.filter((h) => h.root === p.root && (id === undefined || id === 0 || h.helperId === id) && !h.destroyed);
  }

  /** Deterministic RNG in [0, n). MUGEN's generator still has to be matched. */
  /**
   * MUGEN's generator (mugen.exe 0x42e7e0): Park-Miller "minimal standard",
   * seed = seed * 16807 mod (2^31 - 1), value = seed % n. 16807 * seed stays
   * below 2^46, so doubles are exact.
   */
  /** Debugging: where each RNG draw comes from (set randomTrace to collect). */
  randomTrace: string[] | undefined;
  traceCtx = '';
  random(n: number): number {
    if (this.randomTrace) this.randomTrace.push(this.traceCtx);
    this.seed = (this.seed * 16807) % 2147483647;
    return n > 0 ? this.seed % n : 0;
  }

  /** P2: the enemy picked at the start of the tick (Round_Tick), or now when there is none yet. */
  enemyOf(p: Player): Player | undefined {
    return p.enemy === undefined ? this.findEnemy(p) : (p.enemy ?? undefined);
  }

  /**
   * Player_FindEnemy: the nearest (BodyDistX) enemy, among its targets first
   * while attacking. A player lying dead (state 5150 past its first tick) is
   * nobody's enemy. Quirk kept: the best distance is never updated after the
   * first candidate.
   */
  findEnemy(p: Player): Player | undefined {
    const side = p.root.side;
    let found: Player | undefined;
    let best = 0;
    const consider = (t: Player) => {
      if (t === p || t.destroyed || t.isHelper || t.side === side) return;
      if (t.stateNo === 5150 && t.time !== 0) return;
      const d = Math.abs(bodyDistX(p, t));
      if (!found) {
        found = t;
        best = d;
      } else if (best > d) found = t;
    };
    if (p.moveType === 'a') for (const [t] of p.targets) consider(t);
    if (found) return found;
    for (const t of this.allPlayers()) consider(t);
    return found;
  }

  /** Every player's enemy for this tick (Round_Tick, before the AI and the states). */
  updateEnemies(): void {
    for (const p of this.allPlayers()) p.enemy = this.findEnemy(p) ?? null;
  }

  /** Distance from the player to the front (or back) screen edge, in the player's units. */
  edgeDist(p: Player, front: boolean): number {
    // Like EdgeBodyDist (mugen.exe 0x4343d0): from the camera target, to the
    // stage's screenleft/right limit (measured: KFM's 1028 turns 16 units
    // from that limit, 31 from the screen edge, with BackEdgeDist < 30).
    const cam = this.camTarget ?? this.camera.x;
    const left = cam - this.screenWidth / 2 + this.screenLeft;
    const right = cam + this.screenWidth / 2 - this.screenRight;
    const towardRight = (p.facing > 0) === front;
    return (towardRight ? right - p.wx : p.wx - left) / p.scale;
  }

  /** FrontEdgeBodyDist / BackEdgeBodyDist, in the player's units. */
  edgeBodyDist(p: Player, front: boolean): number {
    // Measured from the camera's target, not from where the camera is
    // (0x4343d0 reads G+0x11f10), less 1 internal unit in the air and 2
    // lying down (measured: KFM's 1027 at 20.146 and 9.596 units).
    const cam = this.camTarget ?? this.camera.x;
    const extra = ((p.stateType === 'a' ? 1 : p.stateType === 'l' ? 2 : 0) * p.prog.data.def.localCoord[0]) / this.gameWidth;
    const left = cam - this.screenWidth / 2 + this.screenLeft + p.bodyWidth(p.facing > 0 ? 'back' : 'front', 'edge') * p.scale;
    const right = cam + this.screenWidth / 2 - this.screenRight - p.bodyWidth(p.facing > 0 ? 'front' : 'back', 'edge') * p.scale;
    const towardRight = (p.facing > 0) === front;
    return (towardRight ? right - p.wx : p.wx - left) / p.scale - extra;
  }

  /** Pause / SuperPause controllers. */
  startPause(owner: Player, time: number, moveTime: number, isSuper: boolean, opts: { darken?: boolean; unhittable?: boolean; p2defmul?: number; endCmdBufTime?: number } = {}): void {
    const e = opts.endCmdBufTime ?? 0;
    // Pause_Apply: time < 0 is 0; a movetime below 0 or past time is 0.
    if (time < 0) time = 0;
    if (moveTime < 0 || moveTime > time) moveTime = 0;
    // The owner's movetime is its pause_movetime for that kind.
    if (isSuper) owner.superMoveTime = moveTime;
    else owner.pauseMoveTime = moveTime;
    const st: PauseState = { owner, time, moveTime, fresh: true, darken: opts.darken ?? false, unhittable: opts.unhittable ?? false, endCmdBufTime: e < 0 || e > time ? 0 : e };
    if (isSuper) this.superPause = time > 0 ? st : undefined;
    else if (this.superPause) this.queuedPause = st;
    else this.pause = time > 0 ? st : undefined;
  }

  /**
   * Command timers of a paused player stop at 2 (char.c floor) only in the
   * pause's last endcmdbuftime frames: by default they run out as usual.
   */
  cmdFloor(p: Player): boolean {
    const ps = this.superPause ?? this.pause;
    return !!ps && this.frozen(p) && ps.time < ps.endCmdBufTime;
  }

  /** Is the player frozen by a Pause/SuperPause this tick? */
  private frozen(p: Player): boolean {
    const ps = this.superPause ?? this.pause;
    if (!ps) return false;
    if (this.superPause ? p.superMoveTime !== 0 : p.pauseMoveTime !== 0) return false;
    return true;
  }

  get darkened(): boolean {
    return !!this.superPause?.darken;
  }

  /** Feed this tick's raw inputs (one bitmask per player) and advance one tick. */
  tick(inputs: number[]): void {
    // Before the round starts (and after it ends) input is ignored and nobody has control.
    if (this.roundState === 2) this.fightTime++;
    const active = this.allPlayers().filter((p) => !this.frozen(p));
    // MUGEN advances animations at the end of each player's update; here it
    // runs at the start of the next tick.
    for (const p of active) p.advanceAnim();
    const dustX = new Map(this.allPlayers().map((p) => [p, this.internalX(p)] as const));
    // MUGEN picks the pause owner before the tick (mugen.exe 0x40cc73): a
    // pause that starts during this tick does not stop its floor dust.
    const pausedAtStart = !!(this.pause || this.superPause);
    this.updateEnemies();
    // MUGEN's order (main tick 0x4130xx): facing sync and human key events,
    // then the CPU AI pass, then every player's input processing.
    this.players.forEach((p, i) => {
      const raw = this.inputLocked || p.ai ? 0 : (inputs[i] ?? 0);
      p.input.push(raw);
      p.cmdInput ??= new CommandInput(p.prog.cmd);
      p.recorder ??= new Recorder(p);
      p.cmdInput.ingest(raw, p.facing, !p.ai);
    });
    // The AI pass sees the RoundState of the previous tick (measured: it does
    // not act on the first tick of RoundState 2).
    // The AI runs through Pause/SuperPause too (mugen.exe 0x41357b only
    // checks the pause menu; measured: AI state time keeps counting).
    {
      postResolvedMessages(this.players);
      for (const p of this.players) p.ai?.tick(process.env.AIEXP ? this.roundState === 2 : this.aiRoundFight);
      for (const p of this.players) if (p.ai) p.ai.msgs.length = 0;
    }
    // Automatic turn, after the AI and before input processing (mugen.exe
    // 0x4137dd): standing, walking, crouching, jump start, or at the end of
    // the landing animation. A player that changed state also turns right
    // after its states (measured: landing with control).
    for (const p of this.players) {
      if (this.frozen(p)) continue;
      const no = p.stateNo;
      // Landing (52) turns on the last tick of its animation: time >= total - 1.
      const landEnd = p.anim.totalTime === -1 || p.anim.animTime() >= -1;
      if (no === 0 || no === 11 || no === 20 || no === 40 || (no === 52 && landEnd)) this.tickTurn(p);
    }
    this.aiRoundFight = this.roundState === 2;
    for (const p of this.players) {
      // Every player's input is processed each tick, frozen or in hit pause.
      // MUGEN's pause counter (p+0xef0) lags the hit pause by a tick.
      // The hold follows the previous tick's pause: it starts and ends a
      // tick late (measured: an AI.Cheat command injected as the pause begins
      // expires).
      const hold = p.hitPauseLastTick;
      p.hitPauseLastTick = p.hitPause > 0;
      p.cmdInput!.update(this.gameTime, this.cmdFloor(p), p.ai?.cmds, hold);
      p.commands = p.noInputStates ? new Set() : p.cmdInput!.active();
      p.keyEventRecovery();
    }
    // Keyctrl helpers read the keys into their own command state (copied
    // from the root's when created): the AI's commands never reach them, so
    // a CPU root's helper sees none (what characters' AI detectors test).
    for (const h of this.helpers) {
      if (!h.keyCtrl || h.destroyed || !h.cmdInput) continue;
      const i = this.players.indexOf(h.root);
      const raw = this.inputLocked || h.root.ai ? 0 : (inputs[i] ?? 0);
      h.cmdInput.ingest(raw, h.facing, !h.root.ai);
      h.cmdInput.update(this.gameTime, this.cmdFloor(h));
      h.commands = h.cmdInput.active();
    }
    // Built-in transitions for everyone first, then each player runs its
    // states and moves before the next one (both measured against MUGEN 1.1).
    // They are part of input processing, so a player frozen by a SuperPause
    // still takes them (measured: the CPU's jump input during the pause
    // enters 40 twice, prevstateno 40).
    for (const p of this.allPlayers()) p.startOfTick();
    // Attacking players update first (measured: an opponent's P2Dist already
    // sees an attacking P2's movement of this tick).
    const order = [...active.filter((p) => p.moveType === 'a'), ...active.filter((p) => p.moveType !== 'a')];
    const update = (p: Player) => {
      p.changedStateThisTick = false;
      p.projHitBlock = false;
      // Player_Update: a player shaking from a hit has no hit pause of its
      // own (a trade's attacker pause is dropped).
      if (p.ghv.hitshaketime > 0) {
        p.hitPause = 0;
        p.hitPauseFresh = false;
      }
      // BindToTarget/Parent/Root: the player is moved at the start of its
      // own update (TargetBind targets are placed by their binder).
      if (!p.bind?.byTarget) this.placeBound(p);
      const frozen = p.hitPause > 0;
      p.runStates();
      // mugen.exe Player_Update: the projectile contact clock runs after the
      // states, unless in hit pause.
      if (!frozen) p.projContactTime++;
      if (this.inputLocked && !p.isHelper) p.ctrl = false;
      p.physicsStep();
      // Screen bounds apply as part of the player's movement, before the
      // camera follows it.
      if (!p.isHelper) this.clampPlayer(p);
      // MUGEN moves the camera after every player's physics, then once more
      // at the end of the tick (mugen.exe 0x43d43a / 0x413d95).
      this.stepCameraX();
      // Player_Update ends placing the targets it binds (TargetBind) that are
      // being hit: position, the binder's velocity, pos_freeze, and their
      // pending mindist/maxdist offsets dropped.
      for (const t of p.targets.keys()) {
        const b = t.bind;
        if (!b?.byTarget || b.to !== p || b.time === 0 || t.moveType !== 'h') continue;
        this.placeBound(t);
        const k = p.scale / t.scale;
        t.vel.x = p.vel.x * p.facing * t.facing * k;
        t.vel.y = p.vel.y * k;
        t.posFreeze = true;
        t.pendingPlacement = undefined;
        // The bind time only runs out while it places a target being hit.
        if (b.time > 0) b.time--;
      }
    };
    // Players that existed when the tick began (frozen ones included).
    const updated = new Set<Player>(this.allPlayers());
    for (const p of order) update(p);
    // Helpers created during the updates are updated in the same tick, again
    // until no more appear (round.c: the player_tick[64] loop).
    for (;;) {
      const fresh = this.helpers.filter((h) => !updated.has(h) && !h.destroyed);
      if (!fresh.length) break;
      for (const h of fresh) {
        updated.add(h);
        active.push(h);
        update(h);
      }
    }
    // BindToTarget/Parent/Root place before the hits (round.c: Player_UpdateBind
    // then Players_CheckHits).
    this.applyBinds();
    // Projectiles_Update (before Players_CheckHits) runs for each player that ran this tick (run[i],
    // decided before the updates): a Pause started during the tick does not
    // stop its owner's projectiles until the next one.
    for (const pr of this.projectiles) if (active.includes(pr.owner)) updateProjectile(pr);
    // Players_CheckHits pushes the players apart before the hits (and once
    // more after them), clamping to the screen each time.
    const hitsOn = this.hitsEnabled;
    if (hitsOn) {
      this.pushPlayers();
      this.clampToScreen();
      // Every player takes part, paused ones too (Players_CheckHits only skips
      // inactive players; a Pause stops updates, not hits).
      const hitters = this.allPlayers().filter((p) => !p.destroyed);
      // Players_CheckHits: nohit_time runs out first.
      for (const p of hitters) if (p.nohitTime > 0) p.nohitTime--;
      applyHits(detectHits(hitters), hitters, this.frames);
      // HitDefs against projectiles (hitflag P).
      hitProjectilesByHitDefs(this.projectiles, hitters);
    }
    if (hitsOn) {
      applyHits(detectProjectileHits(this.projectiles, active));
      // Players_CheckHits: projectiles against projectiles come after.
      collideProjectiles(this.projectiles, this.allPlayers().filter((p) => !p.destroyed));
    }
    this.projectiles = this.projectiles.filter((pr) => pr.phase !== 'dead');
    // The second push pass (mugen.exe 0x43de16; measured: walking into a
    // cornered opponent closes 3/4 of the overlap per tick).
    if (hitsOn) {
      this.pushPlayers();
      this.clampToScreen();
    }
    this.spawnDust(dustX, pausedAtStart);
    // AI move recorders, last player first (mugen.exe 0x413d81).
    // The recording clock stands still in hit pause, a tick late like the
    // pause flag p+0xef8 (measured: KFM's 640 records its last active tick
    // exactly its 12 pause ticks earlier than counting them).
    for (const p of [...this.players].reverse()) p.recorder?.tick(!this.frozen(p) && !p.hitPauseLastTick);
    this.updateCamera();
    for (const p of active) {
      recordAfterImage(p.afterImage, p.drawFrame());
      tickPalFx(p.palFx);
      p.advance();
      p.pruneTargets();
    }
    // A frozen player hit or hitting this tick (hitpause_next) is in hit
    // pause from its next update on: nothing of this tick is left to run.
    for (const p of this.allPlayers()) if (!active.includes(p)) p.hitPauseFresh = false;
    for (const p of this.allPlayers()) {
      for (const e of p.events) this.sounds.push({ owner: e.common ? null : p, group: e.group, number: e.number });
      p.events.length = 0;
      // Player_Update's end: with a pause running (not one starting this
      // tick) the player's movetime for it counts down; with none, a player
      // being hit loses its movetimes (a Pause owner hit into H included).
      const sp = this.superPause && !this.superPause.fresh;
      const pz = !this.superPause && this.pause && !this.pause.fresh;
      if (sp) {
        if (p.superMoveTime > 0 && active.includes(p)) p.superMoveTime--;
      } else if (pz) {
        if (p.pauseMoveTime > 0 && active.includes(p)) p.pauseMoveTime--;
      } else if (p.moveType === 'h') p.superMoveTime = p.pauseMoveTime = 0;
    }
    if (this.helperSlots.some((h) => h?.destroyed)) {
      this.helperSlots = this.helperSlots.map((h) => (h && !h.destroyed ? h : null));
      this.helpers = this.helperSlots.filter((x): x is Player => !!x);
    }
    this.updateExplods();
    this.tickPauses();
    tickPalFx(this.bgPalFx);
    if (this.envShake && this.envShake.time > 0) this.envShake.time--;
    this.gameTime++;
    if (!this.framesDriven) this.frames++;
  }

  private tickPauses(): void {
    const sp = this.superPause;
    if (sp?.fresh) {
      sp.fresh = false;
      return;
    }
    if (sp) {
      if (sp.moveTime > 0) sp.moveTime--;
      if (--sp.time <= 0) {
        this.superPause = undefined;
        if (this.queuedPause) {
          this.pause = this.queuedPause;
          this.queuedPause = undefined;
        }
      }
      return;
    }
    const pz = this.pause;
    // A Pause starts counting at the next frame (gameloop: pauses[k][6] is
    // decremented at the start of each frame), so time = 1 freezes one frame.
    if (pz?.fresh) {
      pz.fresh = false;
      return;
    }
    if (pz) {
      if (pz.moveTime > 0) pz.moveTime--;
      if (--pz.time <= 0) this.pause = undefined;
    }
  }

  private updateExplods(): void {
    this.explods = this.explods.filter((e) => {
      // During a pause an explod moves while its age is within its move time
      // (SysDraw_Start: pause_movetime against the frames shown so far).
      // A pause counts from the frame after the one that starts it.
      const sp = this.superPause && !this.superPause.fresh ? this.superPause : undefined;
      const pz = !sp && this.pause && !this.pause.fresh ? this.pause : undefined;
      const t = sp ? e.superMoveTime : pz ? e.pauseMoveTime : -1;
      if ((sp || pz) && t !== -1 && e.age > t) return true;
      if (!e.ignoreHitPause && e.owner.hitPause > 0) return true;
      return updateExplod(e);
    });
  }

  /** TargetBind / BindToTarget position locks. */
  /** End of tick: bound players follow their binds; bind times run out. */
  private applyBinds(): void {
    for (const p of this.allPlayers()) {
      const b = p.bind;
      if (!b) continue;
      // BindToTarget/Parent/Root place after every update (Player_UpdateBind);
      // a TargetBind target is not put back (its own PosSet wins: Iori's
      // 3120 lands Kyo at y = 0 in mugen.exe).
      // Player_UpdateBind ends with a Camera_Update for each bound player.
      if (!b.byTarget && this.placeBound(p)) this.stepCameraX();
      // The bind (and GetHitVar(isbound)) lasts the whole tick. A TargetBind
      // runs out in its binder's update (only while placing a target being hit).
      if (b.time === 0 || (!b.byTarget && b.time > 0 && --b.time === 0)) p.bind = undefined;
    }
  }

  private placeBound(p: Player): boolean {
    const b = p.bind;
    if (!b || b.time === 0) return false;
    // Bind offsets are stored in world units. BindToParent/Root read the
    // anchor through PlayerRef_GetPos, as floats (internal units).
    const k = this.gameWidth / this.screenWidth;
    const ax = b.byTarget ? b.to.wx : Math.fround(b.to.wx * k) / k;
    const ay = b.byTarget ? b.to.wy : Math.fround(b.to.wy * k) / k;
    p.setWorldPos(ax + b.offset[0] * (b.byTarget ? b.to.facing : 1), ay + b.offset[1]);
    return true;
  }

  /** Player x in MUGEN's internal (GameWidth-based) units, truncated. */
  private internalX(p: Player): number {
    return Math.trunc(p.wx * (this.gameWidth / this.screenWidth));
  }

  /**
   * Floor dust (mugen.exe 0x413d00 / 0x4415d0): players whose internal x
   * moved this tick, every third game tick, if on the ground standing or
   * crouching while being hit, or landing (52). Each puff draws two numbers.
   */
  private spawnDust(before: Map<Player, number>, paused: boolean): void {
    if (paused) return;
    // Every third tick of the round (MUGEN's G+0x12760; measured: dust only
    // on clocks divisible by 3 in two different captures).
    if ((this.roundClock ?? this.fightTime) % 3 !== 0) return;
    const ps = this.allPlayers();
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]!;
      if (before.get(p) === undefined || before.get(p) === this.internalX(p)) continue;
      const hitOnGround = p.pos.y === 0 && (p.stateType === 's' || p.stateType === 'c') && p.moveType === 'h';
      if (!hitOnGround && p.stateNo !== 52) continue;
      const dx = this.random(3) - 1;
      const dy = this.random(3) - 1;
      const anim = this.fightFx?.anims.get(120);
      if (!anim) continue;
      // Player_MakeDust: no owner and id 0, like a spark (but it stops in pauses).
      const e = simpleExplod(p, anim, true, p.wx + dx, p.wy + dy, -1, 1);
      e.id = 0;
      e.system = true;
      this.explods.push(e);
    }
  }

  /** Hit spark at the defender's front edge, facing the attacker (sctrls.html sparkxy). */
  /** `xy` and `src` are in world units. */
  spawnSpark(a: Player, d: Player, ref: SparkRef, xy: [number, number], src: { x: number; y: number } = { x: a.wx, y: a.wy }): void {
    const anims = ref.own ? a.prog.data.anims : this.fightFx?.anims;
    const anim = anims?.get(ref.action);
    if (!anim) return;
    const dirToA = src.x >= d.wx ? 1 : -1;
    const width = (dirToA === d.facing ? d.const('size.ground.front') : d.const('size.ground.back')) * d.scale;
    const x = d.wx + dirToA * width + dirToA * xy[0];
    const y = src.y + xy[1];
    const e = simpleExplod(a, anim, !ref.own, x, y, 9, -dirToA);
    // Player_MakeSpark: id 0, no owner, and it plays through pauses
    // (pause move times = its remove time).
    e.id = 0;
    e.system = true;
    e.removeTime = e.anim.totalTime;
    e.superMoveTime = e.pauseMoveTime = e.removeTime;
    this.explods.push(e);
  }

  playHitSound(a: Player, ref: SoundRef | undefined): void {
    if (ref) this.sounds.push({ owner: ref.own ? a : null, group: ref.group, number: ref.number });
  }

  /** Players with control turn to face the opponent (state 0/11 "turn" animations). */
  /** mugen.exe 0x43c390: turn to face the opponent once it is behind. */
  turnCheck(p: Player): void {
    this.tickTurn(p);
  }

  private tickTurn(p: Player): void {
    const e = this.enemyOf(p);
    if (!e || (!p.ctrl && this.roundState <= 2) || p.special.has('noautoturn')) return;
    if (!((p.wx - e.wx) * p.facing > 0)) return;
    // Turning keeps the world velocity (the facing setter flips vel x).
    p.facing = -p.facing;
    p.cmdInput?.syncFacing(p.facing < 0);
    if (p.stateType === 's' && p.hasAnim(5)) p.changeAnim(5);
    else if (p.stateType === 'c' && p.hasAnim(6)) p.changeAnim(6);
  }



  /** Player push: players whose bodies overlap vertically are pushed apart. */
  private pushPlayers(): void {
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]!;
        const b = ps[j]!;
        if (a.side === b.side || !a.pushEnabled || !b.pushEnabled || a.bind || b.bind) continue;
        // Push needs touching Clsn2 boxes first (mugen.exe 0x43de40), then the
        // size-based check below.
        if (!clsn2TouchInternal(a, b)) continue;
        // A standing player is not pushed by one more than its [Size] height
        // above it; crouching and airborne players skip this test
        // (mugen.exe 0x43df60).
        const above = (p: Player, q: Player) => p.stateType === 's' && p.wy - q.wy > p.const('size.height') * p.scale;
        if (above(a, b) || above(b, a)) continue;
        this.pushApart(a, b);
      }
    }
  }

  /**
   * mugen.exe 0x43df60, in internal (GameWidth) units: widths are rounded to
   * whole units; players closer than 10 (per 320 of GameWidth) are first
   * set 5 either side of their midpoint, then the remaining overlap with the
   * original distance is split between them (measured: a cross-up ends 2x5
   * further apart than the widths alone).
   */
  private pushApart(a: Player, b: Player): void {
    const f = Math.fround;
    const k = this.gameWidth / this.screenWidth;
    // Left and right player (Players_PushApart): on the same spot `a` is left
    // unless b faces right (opposite facings), or, facing the same way, the
    // one ahead is attacking or airborne.
    let [l, r] = b.wx < a.wx ? [b, a] : [a, b];
    if (a.wx === b.wx) {
      const busy = (p: Player) => p.moveType === 'a' || p.stateType === 'a';
      const swap = a.facing !== b.facing ? b.facing === 1 : a.facing === 1 ? busy(b) : busy(a);
      if (swap) [l, r] = [b, a];
    }
    const width = (p: Player, side: 'front' | 'back') => Math.floor(p.bodyWidth(side, 'player') * p.scale * k + 0.5);
    const wl = width(l, l.facing === 1 ? 'front' : 'back');
    const wr = width(r, r.facing === -1 ? 'front' : 'back');
    let lx = l.wx * k;
    let rx = r.wx * k;
    const d = f(rx - lx);
    if (f((this.gameWidth * 10) / 320) > d) {
      const mid = f((rx + lx) * 0.5);
      const q = f((this.gameWidth * 5) / 320);
      lx = mid - q;
      rx = mid + q;
    }
    const total = f(wl + wr);
    if (total > d) {
      const h = f((total - d) * 0.5);
      lx -= h;
      rx += h;
    }
    if (lx !== l.wx * k) l.setWorldPos(lx / k);
    if (rx !== r.wx * k) r.setWorldPos(rx / k);
  }

  private clampToScreen(): void {
    for (const p of this.players) this.clampPlayer(p);
  }

  /** Screen and stage bounds for one player (HitDef placement). */
  clampToScreenOne(p: Player): void {
    this.clampPlayer(p);
  }

  /**
   * Player.screen_left/right as Player_ScreenBound stores them: the target
   * edges and the stage's screenleft/right, without the Width edges (what
   * Player_AtScreenEdge compares with), in world units.
   */
  screenEdges(): [number, number] {
    const k = this.gameWidth / this.screenWidth;
    const ce = this.camEdges ?? this.camInit();
    return [Math.fround(this.screenLeft * k + ce.lt) / k, Math.fround(ce.rt - this.screenRight * k) / k];
  }

  /** The x range the screen allows a player (screenleft/right plus edge widths). */
  screenLimits(p: Player): [number, number] {
    // Player_ScreenBound: from the edges the camera is heading to
    // (screen_left/right_target), not where it is.
    const k = this.gameWidth / this.screenWidth;
    // In internal units: screen_left/right are floats (the stage's
    // screenleft/right from the target edges), the Width edges whole units.
    const ce = this.camEdges ?? this.camInit();
    const tl = ce.lt;
    const tr = ce.rt;
    const sl = Math.fround(this.screenLeft * k + tl);
    const sr = Math.fround(tr - this.screenRight * k);
    const edge = (side: 'front' | 'back') => Math.floor(Math.fround(p.bodyWidth(side, 'edge') * p.scale * k) + 0.5);
    return [(edge(p.facing > 0 ? 'back' : 'front') + sl) / k, (sr - edge(p.facing > 0 ? 'front' : 'back')) / k];
  }

  private clampPlayer(p: Player): void {
    let x = Math.max(this.leftBound, Math.min(this.rightBound, p.wx));
    if (p.screenBound) {
      const [lo, hi] = this.screenLimits(p);
      x = Math.max(lo, Math.min(hi, x));
    }
    // The clamped position is stored as a float (measured: x at a screen
    // edge reads back as an exact float32 in internal units).
    if (x !== p.wx) p.setWorldPos(x);
  }

  /** Where the camera centre wants to be: keep players out of the tension zones. */
  /** Camera_Update's mode (camera_mode): 0 and 1 hold still, 2 snaps. */
  cameraMode = 0;
  /**
   * Camera edges in internal units, as mugen.exe keeps them (floats):
   * screen_left/right and the targets they move towards.
   */
  camEdges: { l: number; r: number; lt: number; rt: number } | undefined;
  /** Centre of the target edges in world units (EdgeDist and the like). */
  camTarget: number | undefined;

  private camInit(): { l: number; r: number; lt: number; rt: number } {
    const k = this.gameWidth / this.screenWidth;
    const x = Math.fround(this.camera.x * k);
    const hw = Math.trunc(this.gameWidth) * 0.5;
    const l = Math.fround(x - hw);
    const r = Math.fround(hw + x);
    return { l, r, lt: l, rt: r };
  }

  /**
   * One horizontal step of Camera_Update (mugen.exe 0x415ae0), in internal
   * units and the original's float precision: the target edges follow the
   * outermost players with the tension and the stage bounds, the edges move
   * 5% of the way plus 0.1 per 320 pixels (or with the outer player's
   * speed), snapping when the rest is smaller than the step. MUGEN runs it
   * after every player's update and once more at the end of the tick.
   */
  private stepCameraX(): void {
    if (this.cameraMode <= 1) return;
    // Camera_Update starts with Player_UpdateDrawParams(p, 1) for every
    // active player: ScreenBound (only) for those with it on, so a player
    // that just turned is bound with its new edge widths before it moves.
    for (const p of this.allPlayers()) {
      if (p.destroyed || !p.screenBound) continue;
      const [lo, hi] = this.screenLimits(p);
      if (p.wx < lo) p.setWorldPos(lo);
      else if (p.wx > hi) p.setWorldPos(hi);
    }
    const snap = this.cameraMode === 2;
    const f = Math.fround;
    const k = this.gameWidth / this.screenWidth;
    const e = (this.camEdges ??= this.camInit());
    const tension = f(this.tension * k);
    const wf = f(Math.trunc(this.gameWidth));
    let speedL = f((f(0.1) * wf) / 320);
    let speedR = speedL;
    const camW = wf; // zoomin = zoomout = 1
    const zoomoutW = wf;
    const hz = 0.5 * zoomoutW;
    const ll = f(this.boundLeft * k - hz);
    const rl = f(this.boundRight * k + hz);
    let l = e.lt;
    let r = e.rt;
    // Every active player slot, helpers with movecamera included.
    const ps = this.allPlayers().filter((p) => !p.destroyed && p.moveCamera[0]);
    const edge = (p: Player, side: number) => {
      const w = p.bodyWidth(p.facing === side ? 'front' : 'back', 'edge') * p.scale * k;
      return Math.trunc(Math.floor(f(w) + 0.5));
    };
    let left: Player | undefined;
    let right: Player | undefined;
    for (const p of ps) {
      if (!left || left.wx * k - edge(left, -1) > p.wx * k - edge(p, -1)) left = p;
      if (!right || edge(right, 1) + right.wx * k < edge(p, 1) + p.wx * k) right = p;
    }
    if (left && right) {
      const xl = f(left.wx * k - f(edge(left, -1)));
      const xr = f(edge(right, 1) + right.wx * k);
      if (camW > r - l) {
        const mid = f((l + r) * 0.5);
        l = f(mid - camW * 0.5);
        r = f(camW * 0.5 + mid);
      }
      const width = xr - xl + (tension + tension);
      if (width < camW) {
        let dx = 0;
        if (r - l > camW) {
          const mid = f((l + r) * 0.5);
          l = f(mid - 0.5 * camW);
          r = f(0.5 * camW + mid);
        }
        if (xl - tension < l) dx = f(xl - tension - l);
        if (xr + tension > r) dx = f(xr + tension - r);
        l = f(l + dx);
        r = f(r + dx);
      } else {
        const mid = f((xl + xr) * 0.5);
        if (zoomoutW >= width) {
          l = f(xl - tension);
          r = f(xr + tension);
        } else {
          l = f(mid - hz);
          r = f(mid + hz);
        }
      }
      if (ll > l) {
        let sh = f(ll - l);
        l = ll;
        const xrt = xr + tension;
        if (sh + r > xrt) sh = f(xrt - r);
        if (sh + r - ll < camW) sh = f(camW - (r - ll));
        if (0 < sh) r = f(r + sh);
        if (rl < r) r = rl;
      }
      if (rl < r) {
        let sh = f(r - rl);
        r = rl;
        if (xl - tension > l - sh) sh = f(l - xl + tension);
        if (rl - (l - sh) < camW) sh = f(camW - (rl - l));
        if (0 < sh) l = f(l - sh);
        if (ll > l) l = ll;
      }
      if (l < r) {
        e.lt = l;
        e.rt = r;
      }
      const q1 = f(xl - e.l - tension);
      const q2 = f(e.r - xr - tension);
      let d = f(e.lt - e.l);
      speedL = f(e.lt * 0.05 + e.l * 0.95 - e.l + Math.sign(d) * speedL);
      d = f(e.rt - e.r);
      speedR = f(e.rt * 0.05 + e.r * 0.95 - e.r + Math.sign(d) * speedR);
      // World-space velocities in internal units.
      const lv = left.vel.x * left.facing * left.scale * k;
      if (speedL > lv && speedL < 0 && 0 > q1) {
        speedL = f(lv);
        if (speedR < 0 && speedL < speedR) speedR = speedL;
      }
      const rv = right.vel.x * right.facing * right.scale * k;
      if (speedR < rv && speedR > 0 && 0 > q2) {
        speedR = f(rv);
        if (speedL > 0 && speedR > speedL) speedL = speedR;
      }
    } else {
      speedL = 0;
      speedR = 0;
    }
    {
      const a = e.l;
      const t = e.lt;
      if (t < a) {
        const n = f(a + speedL);
        e.l = !(t <= n) ? t : n;
      } else if (t > a) {
        const n = f(a + speedL);
        e.l = !(t >= n) ? t : n;
      }
    }
    {
      const a = e.r;
      const t = e.rt;
      if (t > a) {
        const n = f(a + speedR);
        e.r = !(t >= n) ? t : n;
      } else if (t < a) {
        const n = f(a + speedR);
        e.r = !(t <= n) ? t : n;
      }
    }
    if (snap) {
      e.l = e.lt;
      e.r = e.rt;
    }
    if (f(Math.abs(speedL)) > f(Math.abs(e.l - e.lt))) e.l = e.lt;
    if (f(Math.abs(speedR)) > f(Math.abs(e.r - e.rt))) e.r = e.rt;
    if (zoomoutW < e.r - e.l) {
      if (e.rt >= e.r) e.l = f(e.r - zoomoutW);
      else if (e.lt <= e.l) e.r = f(zoomoutW + e.l);
    }
    if (ll > e.l) e.l = ll;
    if (rl < e.r) e.r = rl;
    this.camera.x = f((e.l + e.r) * 0.5) / k;
    this.camTarget = ((e.lt + e.rt) * 0.5) / k;
  }

  /**
   * Horizontal: eased towards the tension/centering target (stepCameraX).
   * Vertical: follows the highest player above floortension (verticalfollow).
   */
  private updateCamera(): void {
    this.stepCameraX();
    const vs = this.players.filter((p) => p.moveCamera[1] || p.moveCamera[0]);
    if (vs.length) {
      const highest = Math.min(...vs.map((p) => p.wy));
      const target = highest < -this.floorTension ? (highest + this.floorTension) * this.verticalFollow : 0;
      this.camera.y = Math.max(this.boundHigh, Math.min(this.boundLow, target));
    }
  }

  /** Apply stage settings (stage .def) to the world. */
  applyStage(info: import('../stage/stage').StageInfo): void {
    const c = info.camera;
    this.camera = { x: c.startX, y: c.startY };
    this.camTarget = undefined;
    this.camEdges = undefined;
    this.boundLeft = c.boundLeft;
    this.boundRight = c.boundRight;
    this.boundHigh = c.boundHigh;
    this.boundLow = c.boundLow;
    this.tension = c.tension;
    this.verticalFollow = c.verticalFollow;
    this.floorTension = c.floorTension;
    this.leftBound = info.leftBound;
    this.rightBound = info.rightBound;
    this.screenLeft = info.screenLeft;
    this.screenRight = info.screenRight;
    this.groundY = info.zoffset;
    this.localWidth = info.localCoord[0];
    this.screenWidth = info.localCoord[0];
    this.screenHeight = info.localCoord[1];
    this.shadow = info.shadow;
  }
}

/**
 * Player_BodyDistX, in world units: from p's front edge to e's front edge
 * when p is in front of it, else (level included) to its back edge.
 */
export function bodyDistX(p: Player, e: Player): number {
  const f = Math.fround;
  const front = f((p.stateType === 'a' ? p.const('size.air.front') : p.const('size.ground.front')) * p.scale * p.facing + p.wx);
  const side = f((p.wx - e.wx) * e.facing);
  const eEdge =
    side > 0
      ? f((e.stateType === 'a' ? e.const('size.air.front') : e.const('size.ground.front')) * e.scale * e.facing + e.wx)
      : f(e.wx - (e.stateType === 'a' ? e.const('size.air.back') : e.const('size.ground.back')) * e.scale * e.facing);
  return f((eEdge - front) * p.facing);
}
