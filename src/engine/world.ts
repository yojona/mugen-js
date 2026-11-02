// Match world: players, camera, stage bounds and the fixed 60 Hz tick.

import type { AnimationMap } from '../formats/air';
import type { Sff } from '../formats/sff';
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
  private seed = 0x1234567;
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
  random(n: number): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return ((this.seed >>> 16) & 0x7fff) % n;
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
    const left = this.camera.x - this.screenWidth / 2;
    const right = this.camera.x + this.screenWidth / 2;
    const towardRight = (p.facing > 0) === front;
    return (towardRight ? right - p.wx : p.wx - left) / p.scale;
  }

  /** Pause / SuperPause controllers. */
  startPause(owner: Player, time: number, moveTime: number, isSuper: boolean, opts: { darken?: boolean; unhittable?: boolean; p2defmul?: number } = {}): void {
    const st: PauseState = { owner, time, moveTime, darken: opts.darken ?? false, unhittable: opts.unhittable ?? false };
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
    this.players.forEach((p, i) => p.input.push(this.inputLocked ? 0 : (inputs[i] ?? 0)));
    const active = this.allPlayers().filter((p) => !this.frozen(p));
    for (const p of active) p.advanceAnim();
    // Each player runs its states and then moves before the next player is
    // processed: P2 sees P1's new position within the same tick (measured).
    for (const p of active) {
      p.runStates();
      if (this.inputLocked && !p.isHelper) p.ctrl = false;
      p.physicsStep();
    }
    applyHits(detectHits(active));
    if (!this.superPause && !this.pause) {
      for (const pr of this.projectiles) updateProjectile(pr);
    }
    applyHits(detectProjectileHits(this.projectiles, active));
    this.projectiles = this.projectiles.filter((pr) => pr.phase !== 'dead');
    this.applyBinds();
    this.pushPlayers();
    this.clampToScreen();
    this.updateCamera();
    for (const p of active) {
      this.autoTurn(p);
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
  private applyBinds(): void {
    for (const p of this.allPlayers()) {
      const b = p.bind;
      if (!b) continue;
      if (b.time === 0) {
        p.bind = undefined;
        continue;
      }
      // Bind offsets are stored in world units.
      p.setWorldPos(b.to.wx + b.offset[0], b.to.wy + b.offset[1]);
      if (b.time > 0 && --b.time === 0) p.bind = undefined;
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
  private autoTurn(p: Player): void {
    const e = this.enemyOf(p);
    if (!e || !p.ctrl || p.moveType !== 'i' || p.hitPause > 0 || p.special.has('noautoturn')) return;
    if ((e.wx - p.wx) * p.facing >= 0) return;
    if (p.stateType === 's' && (p.stateNo === 0 || p.stateNo === 20)) {
      p.facing = -p.facing;
      if (p.hasAnim(5)) p.changeAnim(5);
    } else if (p.stateType === 'c' && p.stateNo === 11) {
      p.facing = -p.facing;
      if (p.hasAnim(6)) p.changeAnim(6);
    }
  }

  /** Player push: players whose bodies overlap vertically are pushed apart. */
  private pushPlayers(): void {
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]!;
        const b = ps[j]!;
        if (a.side === b.side || !a.pushEnabled || !b.pushEnabled || a.bind || b.bind) continue;
        // Vertical overlap of the two bodies (height from [Size]).
        if (a.wy - a.const('size.height') * a.scale >= b.wy || b.wy - b.const('size.height') * b.scale >= a.wy) continue;
        const dir = b.wx >= a.wx ? 1 : -1;
        const aw = a.bodyWidth(dir === a.facing ? 'front' : 'back', 'player') * a.scale;
        const bw = b.bodyWidth(-dir === b.facing ? 'front' : 'back', 'player') * b.scale;
        const dist = Math.abs(b.wx - a.wx);
        const min = aw + bw;
        if (dist >= min) continue;
        const overlap = (min - dist) / 2;
        a.setWorldPos(a.wx - overlap * dir);
        b.setWorldPos(b.wx + overlap * dir);
      }
    }
  }

  private clampToScreen(): void {
    const left = this.camera.x - this.screenWidth / 2;
    const right = this.camera.x + this.screenWidth / 2;
    for (const p of this.players) {
      let x = Math.max(this.leftBound, Math.min(this.rightBound, p.wx));
      if (p.screenBound) {
        // Stage [Bound] screenleft/right, unless the Width controller sets an edge width.
        const leftDist = p.width.edge ? p.bodyWidth(p.facing > 0 ? 'back' : 'front', 'edge') * p.scale : this.screenLeft;
        const rightDist = p.width.edge ? p.bodyWidth(p.facing > 0 ? 'front' : 'back', 'edge') * p.scale : this.screenRight;
        x = Math.max(left + leftDist, Math.min(right - rightDist, x));
      }
      if (x !== p.wx) p.setWorldPos(x);
    }
  }

  /**
   * Horizontal: the camera scrolls when a player comes within `tension` of a
   * screen edge, unless another player is already at the opposite edge.
   * Vertical: follows the highest player above floortension (verticalfollow).
   */
  private updateCamera(): void {
    const ps = this.players.filter((p) => p.moveCamera[0]);
    if (ps.length) {
      const half = this.screenWidth / 2;
      const xs = ps.map((p) => p.wx);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      // Camera centres that keep every player out of the edge tension zones.
      const lo = maxX - half + this.tension;
      const hi = minX + half - this.tension;
      let cx = this.camera.x;
      if (lo <= hi) cx = Math.min(Math.max(cx, lo), hi); // move the minimum needed
      else cx = (minX + maxX) / 2; // too far apart: centre between them
      // Never push a player off the opposite edge.
      cx = Math.min(cx, minX - this.screenLeft + half);
      cx = Math.max(cx, maxX + this.screenRight - half);
      this.camera.x = Math.max(this.boundLeft, Math.min(this.boundRight, cx));
    }
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
