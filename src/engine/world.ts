// Match world: players, camera, stage bounds and the fixed 60 Hz tick.

import { CommandInput } from './cmd';
import type { AnimationMap } from '../formats/air';
import type { Sff } from '../formats/sff';
import { clsn2TouchInternal, postResolvedMessages, Recorder } from './ai-learn';
import { applyHits, detectHits, detectProjectileHits } from './combat';
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
}

export class World {
  players: Player[] = [];
  /** Stage localcoord width: the world's coordinate unit. */
  localWidth = 320;
  gameTime = 0;
  roundState = 2; // 2 = fighting
  roundNo = 1;
  camera = { x: 0, y: 0 };
  screenWidth = 320;
  /** mugen.cfg GameWidth: MUGEN's internal x units are this / screenWidth per stage unit. */
  gameWidth = 640;
  private aiRoundFight = false;
  /** Ticks since RoundState 2 began (the current tick included). */
  fightTime = 0;
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

  /** Root players followed by helpers. */
  allPlayers(): Player[] {
    return this.helpers.length ? [...this.players, ...this.helpers] : this.players;
  }

  addHelper(h: Player): void {
    this.helpers.push(h);
  }

  helpersOf(p: Player, id?: number): Player[] {
    return this.helpers.filter((h) => h.root === p.root && h !== p && (id === undefined || h.helperId === id) && !h.destroyed);
  }

  /** Deterministic RNG in [0, n). MUGEN's generator still has to be matched. */
  /**
   * MUGEN's generator (mugen.exe 0x42e7e0): Park-Miller "minimal standard",
   * seed = seed * 16807 mod (2^31 - 1), value = seed % n. 16807 * seed stays
   * below 2^46, so doubles are exact.
   */
  random(n: number): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return n > 0 ? this.seed % n : 0;
  }

  enemyOf(p: Player): Player | undefined {
    let best: Player | undefined;
    for (const q of this.players) {
      if (q.side === p.side) continue;
      if (!best || Math.abs(q.wx - p.wx) < Math.abs(best.wx - p.wx)) best = q;
    }
    return best;
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
  startPause(owner: Player, time: number, moveTime: number, isSuper: boolean, opts: { darken?: boolean; unhittable?: boolean; p2defmul?: number } = {}): void {
    const st: PauseState = { owner, time, moveTime, fresh: true, darken: opts.darken ?? false, unhittable: opts.unhittable ?? false };
    if (isSuper) this.superPause = time > 0 ? st : undefined;
    else if (this.superPause) this.queuedPause = st;
    else this.pause = time > 0 ? st : undefined;
  }

  /** Is the player frozen by a Pause/SuperPause this tick? */
  private frozen(p: Player): boolean {
    const ps = this.superPause ?? this.pause;
    if (!ps) return false;
    if (p === ps.owner && ps.moveTime > 0) return false;
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
      for (const p of this.players) p.ai?.tick(this.aiRoundFight);
      for (const p of this.players) if (p.ai) p.ai.msgs.length = 0;
    }
    // Automatic turn, after the AI and before input processing (mugen.exe
    // 0x4137dd): standing, walking, crouching, jump start, or at the end of
    // the landing animation. A player that changed state also turns right
    // after its states (measured: landing with control).
    for (const p of this.players) {
      if (this.frozen(p)) continue;
      const no = p.stateNo;
      const lastElem = p.anim.elem >= (p.anim.anim?.elements.length ?? 0) - 1;
      if (no === 0 || no === 11 || no === 20 || no === 40 || (no === 52 && lastElem)) this.tickTurn(p);
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
      p.cmdInput!.update(this.gameTime, this.frozen(p), p.ai?.cmds, hold);
      p.commands = p.cmdInput!.active();
      p.keyEventRecovery();
    }
    // Built-in transitions for everyone first, then each player runs its
    // states and moves before the next one (both measured against MUGEN 1.1).
    for (const p of active) p.startOfTick();
    // Attacking players update first (measured: an opponent's P2Dist already
    // sees an attacking P2's movement of this tick).
    const order = [...active.filter((p) => p.moveType === 'a'), ...active.filter((p) => p.moveType !== 'a')];
    for (const p of order) {
      p.changedStateThisTick = false;
      // A bound player is moved at the start of its own update (mugen.exe
      // 0x43c480 -> 0x4349b0; measured: a thrown P2 already shows the
      // TargetBind position its thrower set this tick).
      this.placeBound(p);
      p.runStates();
      if (this.inputLocked && !p.isHelper) p.ctrl = false;
      p.physicsStep();
      // Screen bounds apply as part of the player's movement, before the
      // camera follows it.
      if (!p.isHelper) this.clampPlayer(p);
      // MUGEN moves the camera after every player's physics, then once more
      // at the end of the tick (mugen.exe 0x43d43a / 0x413d95).
      this.stepCameraX();
    }
    applyHits(detectHits(active));
    if (!this.superPause && !this.pause) {
      for (const pr of this.projectiles) updateProjectile(pr);
    }
    applyHits(detectProjectileHits(this.projectiles, active));
    this.projectiles = this.projectiles.filter((pr) => pr.phase !== 'dead');
    this.applyBinds();
    // MUGEN resolves player push in two passes per tick, clamping to the
    // screen after each (mugen.exe 0x43da66 / 0x43de16; measured: walking
    // into a cornered opponent closes 3/4 of the overlap per tick).
    this.pushPlayers();
    this.clampToScreen();
    this.pushPlayers();
    this.clampToScreen();
    this.spawnDust(dustX);
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
    for (const p of this.allPlayers()) {
      for (const e of p.events) this.sounds.push({ owner: e.common ? null : p, group: e.group, number: e.number });
      p.events.length = 0;
      if (p.superMoveTime > 0 && this.superPause) p.superMoveTime--;
      if (p.pauseMoveTime > 0 && this.pause) p.pauseMoveTime--;
    }
    if (this.helpers.some((h) => h.destroyed)) this.helpers = this.helpers.filter((h) => !h.destroyed);
    this.updateExplods();
    this.tickPauses();
    tickPalFx(this.bgPalFx);
    if (this.envShake && this.envShake.time > 0) this.envShake.time--;
    this.gameTime++;
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
    if (pz) {
      if (pz.moveTime > 0) pz.moveTime--;
      if (--pz.time <= 0) this.pause = undefined;
    }
  }

  private updateExplods(): void {
    this.explods = this.explods.filter((e) => {
      if (this.superPause) {
        if (e.superMoveTime === 0) return true;
        if (e.superMoveTime > 0) e.superMoveTime--;
      } else if (this.pause) {
        if (e.pauseMoveTime === 0) return true;
        if (e.pauseMoveTime > 0) e.pauseMoveTime--;
      }
      if (!e.ignoreHitPause && e.owner.hitPause > 0) return true;
      return updateExplod(e);
    });
  }

  /** TargetBind / BindToTarget position locks. */
  /** End of tick: frozen players still follow their binds; bind times run out. */
  private applyBinds(): void {
    for (const p of this.allPlayers()) {
      const b = p.bind;
      if (!b) continue;
      if (this.frozen(p)) this.placeBound(p);
      // The bind (and GetHitVar(isbound)) lasts the whole tick.
      if (b.time === 0 || (b.time > 0 && --b.time === 0)) p.bind = undefined;
    }
  }

  private placeBound(p: Player): void {
    const b = p.bind;
    if (!b || b.time === 0) return;
    // Bind offsets are stored in world units.
    p.setWorldPos(b.to.wx + b.offset[0], b.to.wy + b.offset[1]);
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
  private spawnDust(before: Map<Player, number>): void {
    if (this.pause || this.superPause) return;
    // Every third tick of the round (MUGEN's G+0x12760; measured: dust only
    // on clocks divisible by 3 in two different captures).
    if (this.fightTime % 3 !== 0) return;
    const ps = this.allPlayers();
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]!;
      if (before.get(p) === undefined || before.get(p) === this.internalX(p)) continue;
      const hitOnGround = p.pos.y === 0 && (p.stateType === 's' || p.stateType === 'c') && p.moveType === 'h';
      if (!hitOnGround && p.stateNo !== 52) continue;
      const dx = this.random(3) - 1;
      const dy = this.random(3) - 1;
      const anim = this.fightFx?.anims.get(120);
      if (anim) this.explods.push(simpleExplod(p, anim, true, p.wx + dx, p.wy + dy, -1, 1));
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
    e.removeTime = -2;
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
    // Turning keeps the world velocity (vel x is facing-relative).
    p.facing = -p.facing;
    p.vel.x = -p.vel.x;
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
    // Left and right player; on the same spot the one facing right is left.
    let [l, r] = b.wx > a.wx ? [a, b] : [b, a];
    if (a.wx === b.wx && a.facing !== b.facing && b.facing === 1) [l, r] = [b, a];
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

  /** The x range the screen allows a player (screenleft/right plus edge widths). */
  screenLimits(p: Player): [number, number] {
    const left = this.camera.x - this.screenWidth / 2;
    const right = this.camera.x + this.screenWidth / 2;
    // Stage [Bound] screenleft/right plus any Width controller edge width.
    const leftDist = this.screenLeft + p.bodyWidth(p.facing > 0 ? 'back' : 'front', 'edge') * p.scale;
    const rightDist = this.screenRight + p.bodyWidth(p.facing > 0 ? 'front' : 'back', 'edge') * p.scale;
    return [left + leftDist, right - rightDist];
  }

  private clampPlayer(p: Player): void {
    let x = Math.max(this.leftBound, Math.min(this.rightBound, p.wx));
    if (p.screenBound) {
      const [lo, hi] = this.screenLimits(p);
      x = Math.max(lo, Math.min(hi, x));
    }
    if (x !== p.wx) p.setWorldPos(x);
  }

  /** Where the camera centre wants to be: keep players out of the tension zones. */
  private cameraTargetX(ps: Player[]): number {
    const half = this.screenWidth / 2;
    const xs = ps.map((p) => p.wx);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const lo = maxX - half + this.tension;
    const hi = minX + half - this.tension;
    // The previous target is kept (mugen.exe G+0x11f10/14) and only moved
    // as much as needed: the camera keeps easing towards it even after the
    // players are back between the tension zones (measured).
    let cx = this.camTarget ?? this.camera.x;
    if (lo <= hi) cx = Math.min(Math.max(cx, lo), hi); // move the minimum needed
    else cx = (minX + maxX) / 2; // too far apart: centre between them
    // Never push a player off the opposite edge.
    cx = Math.min(cx, minX - this.screenLeft + half);
    cx = Math.max(cx, maxX + this.screenRight - half);
    cx = Math.max(this.boundLeft, Math.min(this.boundRight, cx));
    this.camTarget = cx;
    return cx;
  }
  /** Camera target kept between steps; reset with the camera. */
  camTarget: number | undefined;

  /**
   * One horizontal camera step, as in mugen.exe (0x415ae0): the camera moves
   * 5% of the way to its target plus a minimum of 0.1 (per 320 pixels of
   * screen), never past the target, snapping to it once the rest is smaller
   * than the step. When the player on that side moves
   * outwards faster, the camera keeps up with that player's velocity.
   * MUGEN runs this after each player's physics and again at the end of the
   * tick, which gives the 0.95^3-per-tick easing measured with the harness.
   */
  private stepCameraX(): void {
    const ps = this.players.filter((p) => p.moveCamera[0]);
    if (!ps.length) return;
    const target = this.cameraTargetX(ps);
    const d = target - this.camera.x;
    if (d === 0) return;
    let speed = 0.05 * d + Math.sign(d) * 0.1 * (this.screenWidth / 320);
    const edge = d > 0 ? ps.reduce((a, b) => (b.wx > a.wx ? b : a)) : ps.reduce((a, b) => (b.wx < a.wx ? b : a));
    const v = edge.vel.x * edge.facing * edge.scale;
    if (d > 0 ? v > speed : v < speed) speed = v;
    let x = this.camera.x + speed;
    // Snap once what is left is smaller than the step just taken (0x4169b1).
    if (d > 0 ? x > target : x < target) x = target;
    if (Math.abs(target - x) < Math.abs(speed)) x = target;
    this.camera.x = x;
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
