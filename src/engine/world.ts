// Match world: players, camera, stage bounds and the fixed 60 Hz tick.

import type { Player } from './player';

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

  /** Feed this tick's raw inputs (one bitmask per player) and advance one tick. */
  tick(inputs: number[]): void {
    this.players.forEach((p, i) => p.input.push(inputs[i] ?? 0));
    for (const p of this.players) p.runStates();
    for (const p of this.players) p.physicsStep();
    this.pushPlayers();
    this.clampToScreen();
    this.updateCamera();
    for (const p of this.players) {
      this.autoTurn(p);
      p.advance();
    }
    this.gameTime++;
  }

  /** Players with control turn to face the opponent (state 0/11 "turn" animations). */
  private autoTurn(p: Player): void {
    const e = this.enemyOf(p);
    if (!e || !p.ctrl || p.moveType !== 'i') return;
    if ((e.pos.x - p.pos.x) * p.facing >= 0) return;
    if (p.stateType === 's' && (p.stateNo === 0 || p.stateNo === 20)) {
      p.facing = -p.facing;
      if (p.hasAnim(5)) p.changeAnim(5);
    } else if (p.stateType === 'c' && p.stateNo === 11) {
      p.facing = -p.facing;
      if (p.hasAnim(6)) p.changeAnim(6);
    }
  }

  /** Simple ground push so players can't overlap (refined later with Width). */
  private pushPlayers(): void {
    const [a, b] = this.players;
    if (!a || !b) return;
    if (a.pos.y < -a.const('size.height') || b.pos.y < -b.const('size.height')) return;
    const aw = a.const('size.ground.front');
    const bw = b.const('size.ground.front');
    const dist = b.pos.x - a.pos.x;
    const min = aw + bw;
    if (Math.abs(dist) >= min) return;
    const overlap = (min - Math.abs(dist)) / 2;
    const dir = dist >= 0 ? 1 : -1;
    a.pos.x -= overlap * dir;
    b.pos.x += overlap * dir;
  }

  private clampToScreen(): void {
    const left = this.camera.x - this.screenWidth / 2;
    const right = this.camera.x + this.screenWidth / 2;
    for (const p of this.players) {
      const back = p.const('size.ground.back');
      const front = p.const('size.ground.front');
      const minX = left + (p.facing > 0 ? back : front);
      const maxX = right - (p.facing > 0 ? front : back);
      if (p.pos.x < minX) p.pos.x = minX;
      if (p.pos.x > maxX) p.pos.x = maxX;
    }
  }

  private updateCamera(): void {
    if (!this.players.length) return;
    const xs = this.players.map((p) => p.pos.x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    this.camera.x = Math.max(this.boundLeft, Math.min(this.boundRight, mid));
  }
}
