// MUGEN 1.1's CPU AI, reverse-engineered from mugen.exe (0x42f640 and the
// 0x430800 state machine). It drives the player the way a human would, by
// pushing key events into the same input ring, plus "AI.Cheat" command
// injection straight into the command buffer.
//
// States: 0 idle, 1 move-to-waypoint (only when the opponent holds Start, so
// effectively unused), 2 attack, 3 guard, 4 pressure (random guarding,
// movement, buttons and commands). The learning layer that feeds states 2/3
// (per-move attack records) is not implemented yet: without it the AI never
// "watches" an opponent's move, as when no record exists for that move.

import type { Player } from './player';

const K_U = 1;
const K_F = 2;
const K_D = 3;
const K_B = 4;
const REL = 0x10;

/** Key event ring with MUGEN's layout, used for the AI's delayed keys (p+0x1d18). */
class DelayRing {
  private ring = new Int32Array(30);
  private r = 0;
  private w = 0;
  push(code: number): void {
    if (!(code & 0xf)) return;
    this.ring[this.w] = code;
    this.w = (this.w + 1) % 30;
    if (this.w === this.r) this.r = (this.r + 1) % 30;
  }
  pop(): number {
    if (this.r === this.w) return 0;
    const v = this.ring[this.r]!;
    this.r = (this.r + 1) % 30;
    return v;
  }
}

/** Truncation toward zero, like mugen.exe's float-to-int (0x4dc850). */
const ftoi = (x: number): number => Math.trunc(x);
// Temporary draw log for harness debugging (AIDEBUG=1).
export let DEBUG: string[] | null = null;
export function setAiDebug(v: string[] | null): void {
  DEBUG = v;
}

const STATETYPE: Record<string, number> = { s: 1, c: 2, a: 3, l: 4 };

export class MugenAI {
  state = 0;
  prevState = 0;
  stateTime = 0;
  cooldown = 0;
  watching = false;
  /** Command indices injected this tick (-1 terminated in MUGEN; max 9). */
  cmds: number[] = [];
  private delayed = new DelayRing();
  private inGuardDist = false;

  constructor(
    readonly p: Player,
    public level = 4,
  ) {}

  // -------------------------------------------------------------------------
  // Helpers over the player's input

  private held(k: number): number {
    return this.p.cmdInput?.heldAt(k) ?? 0;
  }

  private push(code: number): void {
    this.p.cmdInput?.pushKey(code);
  }

  private rand(n: number): number {
    const v = this.p.world.random(n);
    if (DEBUG) DEBUG.push(`%${n}=${v}`);
    return v;
  }

  /** 0x433dd0 / 0x433d40: release every held key 1..13 except `keep` (13 aliases the ring read index). */
  private releaseAllExcept(keep: number): void {
    for (let k = 1; k <= 13; k++) if (k !== keep && this.held(k)) this.push(k | REL);
  }

  /** 0x433d10: release held directions except `keep`. */
  private releaseDirsExcept(keep: number): void {
    for (let k = 1; k <= 4; k++) if (k !== keep && this.held(k)) this.push(k | REL);
  }

  private toState(s: number): true {
    this.prevState = this.state;
    this.state = s;
    this.stateTime = 0;
    return true;
  }

  // -------------------------------------------------------------------------
  // Engine queries

  /** MUGEN's internal units per world unit (GameWidth / screen width). */
  private get k(): number {
    const w = this.p.world;
    return w.gameWidth / w.screenWidth;
  }

  /** |x distance| to the opponent in internal units, truncated. */
  private adx(opp: Player): number {
    return Math.abs(ftoi((this.p.wx - opp.wx) * this.k));
  }

  private get opp(): Player | undefined {
    return this.p.world.enemyOf(this.p);
  }

  /** 0x4347a0: is `att` attacking within guard distance of `tgt` (players and projectiles)? */
  static attackerInRange(att: Player, tgt: Player): boolean {
    if (att.moveType === 'a') {
      const dx = Math.fround((tgt.wx - att.wx) * att.facing);
      const dist = att.hitDefActive && att.hitDef ? att.hitDef.guardDist : att.const('size.attack.dist');
      const lim = Math.fround(dist * att.scale);
      if (!(lim <= dx) && !(dx < 0)) return true;
    }
    for (const pr of att.world.projectiles) {
      if (pr.owner !== att || pr.phase !== 'active') continue;
      const dx = Math.fround((tgt.wx - pr.x) * pr.facing);
      const lim = Math.fround(pr.hd.guardDist * att.scale);
      if (dx >= 0 && dx < lim) return true;
    }
    return false;
  }

  /** 0x432c00: any player (self and teammates included) attacking within range of p. */
  private anyAttackInRange(): boolean {
    for (const q of this.p.world.players) if (MugenAI.attackerInRange(q, this.p)) return true;
    return false;
  }

  /** p+0xee8: set when the engine starts a guard (state 120), cleared on state change. */
  private get guarding(): boolean {
    return this.p.stateNo === 120;
  }

  /** p+0xf0c: 1 guarded, 2 hit, 0 none. */
  private get contactKind(): number {
    return this.p.moveHit ? 2 : this.p.moveGuarded ? 1 : 0;
  }

  // -------------------------------------------------------------------------
  // Per tick

  /**
   * 0x42f640, run after human key events and before input processing.
   * `roundFight` is RoundState 2.
   */
  tick(roundFight: boolean): void {
    const opp = this.opp;
    if (!opp) return;
    this.cmds = [];
    if (!roundFight) {
      this.releaseAllExcept(0);
      return;
    }
    if (this.held(K_F) && this.held(K_B)) this.push(this.guarding ? K_F | REL : K_B | REL);
    if (this.held(K_U) && this.held(K_D)) this.push(K_U | REL);
    const code = this.delayed.pop();
    if (code) {
      this.push(code);
      return;
    }
    this.inGuardDist = this.anyAttackInRange();
    this.think(opp);
  }

  /** 0x430800. */
  private think(opp: Player): void {
    for (let iter = 100; iter > 0; iter--) {
      const changed = this.updateState(opp);
      let r = false;
      switch (this.state) {
        case 0:
          this.stateIdle();
          break;
        case 2:
          r = this.stateAttack();
          break;
        case 3:
          r = this.stateGuard();
          break;
        case 4:
          r = this.stateReact(opp);
          break;
      }
      if (!changed && !r) break;
    }
    this.stateTime++;
    if (this.cooldown > 0) this.cooldown--;
  }

  /** 0x430900 (without the watch/learning parts). */
  private updateState(opp: Player): boolean {
    const p = this.p;
    const adx = this.adx(opp);
    const st = this.state;
    // Stop watching once the opponent's move is over.
    if (opp.moveType === 'i' || opp.moveType === 'h') this.watching = false;
    if (st === 0 && this.level !== 9) {
      let c = this.rand(60);
      if (this.stateTime > 150) c = Math.trunc(c / 2);
      if (adx < 100) c = Math.trunc(c / 2);
      if (adx < 50) c = Math.trunc(c / 2);
      if (p.moveType === 'h') {
        if (p.ghv.hitcount > 2) c = Math.trunc(c / 2);
        if (p.stateType === 'l') c = Math.trunc(c / 2);
      }
      if (c === 0) return this.toState(4);
    }
    if (this.state === 3 && !this.watching) return this.toState(0);
    return false;
  }

  /** 0x431200. */
  private stateIdle(): void {
    if (this.stateTime === 0 && this.prevState === 4) this.releaseAllExcept(0);
    if (this.stateTime >= 1 && (this.prevState === 3 || this.prevState === 2) && !this.inGuardDist) this.releaseDirsExcept(0);
  }

  /** 0x4314f0 (needs attack records; none yet). */
  private stateAttack(): boolean {
    return this.toState(0);
  }

  /** 0x431680. */
  private stateGuard(): boolean {
    const p = this.p;
    if (this.inGuardDist && p.moveType === 'i' && p.ctrl) {
      if (this.held(K_U)) this.push(K_U | REL);
      if (this.held(K_F)) this.push(K_F | REL);
      if (!this.held(K_B)) this.push(K_B);
      if (this.held(K_D)) this.push(K_D | REL);
    }
    return false;
  }

  /** 0x431ba0: state 4. Draw order matters (Park-Miller sequence). */
  private stateReact(opp: Player): boolean {
    const p = this.p;
    const level = this.level;
    const adx = this.adx(opp);
    let r1 = this.rand(6) + 5;
    let r2 = this.rand(6) + 5;
    // A type-0 message (opponent entered a command-triggered state) returns
    // to idle; messages need the learning layer, so none arrive yet.
    if (this.rand(100) === 0) r1 = 11;
    // 0x431d62: the delayed button survives only 1 time in 8.
    if (r2 === r1 || this.rand(8) !== 0) r2 = 0;

    if ((this.inGuardDist && p.moveType === 'i' && p.ctrl) || p.moveType === 'h') {
      const st = p.time;
      let c = 10;
      if (st < 2) c = Math.trunc(level / 2) + 26;
      if (st < 5) c += 5;
      if (st > 10) c -= 5;
      if (adx < 30) {
        c += Math.trunc(level / 2) + 6;
        if (st < 2) c += 10;
      }
      if (adx > 160) c = Math.trunc(c / 2);
      if (!MugenAI.attackerInRange(opp, p)) c = Math.trunc(c / 5);
      if (this.rand(100) < Math.trunc(((level + 6) * c) / 14)) {
        if (!this.guarding) {
          const gc = opp.stateType === 'c' ? 75 : 25;
          if (this.held(K_U)) this.push(K_U | REL);
          if (this.held(K_F)) this.push(K_F | REL);
          if (!this.held(K_B)) this.push(K_B);
          if (this.rand(100) < gc) {
            if (!this.held(K_D)) this.push(K_D);
          } else if (this.held(K_D)) this.push(K_D | REL);
          return false;
        }
        if (this.rand(100) < 30) {
          const gf = guardFlagBits(opp);
          if (gf & 8 && !(gf & 4) && !this.held(K_D)) this.push(K_D);
          if (!(gf & 8) && gf & 4 && this.held(K_D)) this.push(K_D | REL);
        }
        return false;
      }
    }
    if (!this.inGuardDist && this.held(K_B)) this.push(K_B | REL);
    if (this.rand(100) < 58) {
      if (this.rand(1000) < 62 && adx > 125 && !this.held(K_F)) {
        for (let j = 1; j <= 4; j++) if (this.held(j)) this.push(j | REL);
        if (this.rand(1000) < 150) this.push(K_U);
        if (this.rand(1000) < 750) this.push(K_F);
      }
      if (this.rand(1000) < 62) {
        for (let j = 1; j <= 4; j++) if (this.held(j)) this.push(j | REL);
        const r19 = this.rand(19);
        const TAB = [0, 1, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 6, 6, 7];
        switch (TAB[r19]) {
          case 0: this.push(K_U); this.push(K_B); break;
          case 1: this.push(K_U); break;
          case 2: this.push(K_U); this.push(K_F); break;
          case 3: this.push(K_F); break;
          case 4: this.push(K_B); break;
          case 5: this.push(K_D); this.push(K_B); break;
          case 6: this.push(K_D); break;
          case 7: this.push(K_D); this.push(K_F); break;
        }
      }
      let base: number;
      if (p.moveType === 'a' && this.contactKind === 2) base = Math.trunc(((level + 12) * 350) / 20) + 150;
      else base = p.moveType === 'a' ? 150 : 100;
      if (adx < 150) base += 50;
      if (adx < 100) base += 75;
      if (adx < 60) base += 5 * level + 105;
      if (adx < 45) base += 3 * level + 120;
      if (adx < 30) base += 3 * level + 120;
      let thr = Math.trunc(((level + 6) * base) / 14);
      if (p.moveType === 'h') thr = Math.trunc(thr / 10);
      if (this.rand(1000) < thr) {
        const nonProj = p.hitDef ? p.hitDef.attrType[1] !== 'p' : false;
        const cthr = this.contactKind === 2 ? (nonProj ? 250 : 500) : 750;
        if (this.rand(1000) < cthr) {
          const b = this.rand(6) + 5;
          this.push(this.held(b) ? b | REL : b);
        } else {
          for (let j = 1; j <= 4; j++) if (this.held(j)) this.push(j | REL);
          // AI.Cheat: a random command from the .cmd list, active this tick.
          if (this.rand(1000) < 30 * level + 550) {
            const n = p.cmdInput?.commandCount ?? 0;
            if (n > 0 && this.cmds.length < 9) this.cmds.push(this.rand(n));
          }
          this.delayed.push(r2);
          this.delayed.push(r2 | REL);
        }
      }
    }
    // Air recovery while being hit.
    if (p.moveType === 'h' && p.ghv.fall) {
      let rc = 2;
      const y = p.wy * this.k;
      const vy = p.vel.y * p.scale * this.k;
      if (!(-20 >= y)) rc = 20;
      if (!(-1 >= vy) && !(3 <= vy)) rc += 8;
      if (this.rand(100) < rc) {
        if (this.rand(100) < 50) {
          this.delayed.push(5);
          this.delayed.push(6);
        } else {
          this.delayed.push(8);
          this.delayed.push(9);
        }
      }
    }
    void STATETYPE;
    return false;
  }
}

/** HitDef guardflag as MUGEN's bits: 4 = H (high), 8 = L (low). */
function guardFlagBits(p: Player): number {
  const g = p.hitDef?.guardFlag?.toLowerCase() ?? '';
  let b = 0;
  if (g.includes('h') || g.includes('m')) b |= 4;
  if (g.includes('l') || g.includes('m')) b |= 8;
  return b;
}
