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
      if (!best || Math.abs(q.pos.x - p.pos.x) < Math.abs(best.pos.x - p.pos.x)) best = q;
    }
    return best;
  }

  /** Distance from the player to the front (or back) screen edge. */
  edgeDist(p: Player, front: boolean): number {
    const left = this.camera.x - this.screenWidth / 2;
    const right = this.camera.x + this.screenWidth / 2;
    const towardRight = (p.facing > 0) === front;
    return towardRight ? right - p.pos.x : p.pos.x - left;
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
    this.players.forEach((p, i) => p.input.push(inputs[i] ?? 0));
    const active = this.allPlayers().filter((p) => !this.frozen(p));
    for (const p of active) p.advanceAnim();
    for (const p of active) p.runStates();
    for (const p of active) p.physicsStep();
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
      p.pos.x = b.to.pos.x + b.offset[0];
      p.pos.y = b.to.pos.y + b.offset[1];
      if (b.time > 0 && --b.time === 0) p.bind = undefined;
    }
  }

  /** Hit spark at the defender's front edge, facing the attacker (sctrls.html sparkxy). */
  spawnSpark(a: Player, d: Player, ref: SparkRef, xy: [number, number], src: { x: number; y: number } = a.pos): void {
    const anims = ref.own ? a.prog.data.anims : this.fightFx?.anims;
    const anim = anims?.get(ref.action);
    if (!anim) return;
    const dirToA = src.x >= d.pos.x ? 1 : -1;
    const width = dirToA === d.facing ? d.const('size.ground.front') : d.const('size.ground.back');
    const x = d.pos.x + dirToA * width + dirToA * xy[0];
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
    if ((e.pos.x - p.pos.x) * p.facing >= 0) return;
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
        if (a.pos.y - a.const('size.height') >= b.pos.y || b.pos.y - b.const('size.height') >= a.pos.y) continue;
        const dir = b.pos.x >= a.pos.x ? 1 : -1;
        const aw = a.bodyWidth(dir === a.facing ? 'front' : 'back', 'player');
        const bw = b.bodyWidth(-dir === b.facing ? 'front' : 'back', 'player');
        const dist = Math.abs(b.pos.x - a.pos.x);
        const min = aw + bw;
        if (dist >= min) continue;
        const overlap = (min - dist) / 2;
        a.pos.x -= overlap * dir;
        b.pos.x += overlap * dir;
      }
    }
  }

  private clampToScreen(): void {
    const left = this.camera.x - this.screenWidth / 2;
    const right = this.camera.x + this.screenWidth / 2;
    for (const p of this.players) {
      if (!p.screenBound) continue;
      const minX = left + p.bodyWidth(p.facing > 0 ? 'back' : 'front', 'edge');
      const maxX = right - p.bodyWidth(p.facing > 0 ? 'front' : 'back', 'edge');
      if (p.pos.x < minX) p.pos.x = minX;
      if (p.pos.x > maxX) p.pos.x = maxX;
    }
  }

  private updateCamera(): void {
    const ps = this.players.filter((p) => p.moveCamera[0]);
    if (!ps.length) return;
    const xs = ps.map((p) => p.pos.x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    // The camera can only move until a player reaches the opposite edge.
    this.camera.x = Math.max(this.boundLeft, Math.min(this.boundRight, mid));
  }
}
