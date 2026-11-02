// MUGEN 1.1's CPU AI, reverse-engineered from mugen.exe (0x42f640 and the
// 0x430800 state machine). It drives the player the way a human would, by
// pushing key events into the same input ring, plus "AI.Cheat" command
// injection straight into the command buffer.
//
// States: 0 idle, 1 move-to-waypoint (only when the opponent holds Start, so
// effectively unused), 2 attack, 3 guard, 4 pressure (random guarding,
// movement, buttons and commands). States 2 and 3 run on the learning layer
// (ai-learn.ts): the AI watches opponent moves it has records for, guards
// them and counters with its own recorded moves.

import { attackWouldHit, cloneRecord, type AiMessage, type AttackRecord } from './ai-learn';
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

/** Training menu settings for the dummy (mugen.exe p+0x1d00..0x1d10). */
export interface DummySettings {
  /** 0 stand, 1 crouch, 2 jump, 3 jump repeatedly. */
  stance: number;
  /** Guard attacks. */
  guard: boolean;
  /** Keep this far (per 320 of GameWidth), 0 = off. */
  distance: number;
  /** Keep at least this far, 0 = off. */
  jumpDistance: number;
  /** 0 none, 1..7 = a b c x y z s, pressed every 5 ticks. */
  button: number;
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
  /** Messages received this tick (max 10), cleared after the AI pass. */
  msgs: AiMessage[] = [];
  private delayed = new DelayRing();
  private inGuardDist = false;
  // Watching an opponent's move (p+0x16b8..0x1b78).
  private watched: Player | undefined;
  private watchRec: AttackRecord | null = null;
  private watchTime = 0;
  private needCrouchGuard = false;
  // Chosen attack (p+0x169c..0x16a4).
  private attack: AttackRecord | null = null;
  private attackWant = '';
  private attackSent = false;
  private attackList: AttackRecord[] = [];

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
    if (DEBUG) DEBUG.push(`key:${code.toString(16)}`);
    this.p.cmdInput?.pushKey(code);
  }

  private rand(n: number): number {
    const v = this.p.world.random(n);
    if (DEBUG) DEBUG.push(n === this.p.cmdInput?.commandCount ? `%${n}=${v}(raw ${this.p.world.seed})` : `%${n}=${v}`);
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

  /** 0x42f5c0: round reset (the recorder keeps its tables). */
  resetRound(): void {
    this.state = this.prevState = this.stateTime = this.cooldown = 0;
    this.watching = false;
    this.cmds = [];
    this.msgs = [];
    this.delayed = new DelayRing();
    this.inGuardDist = false;
    this.watched = undefined;
    this.watchRec = null;
    this.watchTime = 0;
    this.needCrouchGuard = false;
    this.attack = null;
    this.attackWant = '';
    this.attackSent = false;
    this.attackList = [];
  }

  /** 0x430710 / 0x430780: first message of `type` from `from`; `take` marks it used. */
  private msg(type: number, from: Player, take: boolean): AiMessage | undefined {
    const m = this.msgs.find((x) => x.type === type && x.sender === from);
    if (m && take) m.type = 2;
    return m;
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

  /** p+0xee8 (Player.guardFlag), as left by the previous tick. */
  private get guarding(): boolean {
    return this.p.guardFlag;
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
    if (this.dummy) return this.trainingDummy(opp, this.dummy);
    this.think(opp);
  }

  /** Training mode dummy settings (MUGEN's training menu); null = normal AI. */
  dummy: DummySettings | null = null;
  private dummyTimer = 0;

  /** Internal units for a distance given per 320 of GameWidth (0x421720). */
  private scale320(x: number): number {
    return Math.fround((this.p.world.gameWidth * x) / 320);
  }

  /** 0x4325b0: the training dummy (no RNG). */
  private trainingDummy(opp: Player, d: DummySettings): void {
    const p = this.p;
    const k = this.k;
    if (this.dummyTimer) {
      this.dummyTimer--;
      return;
    }
    const releaseBack = () => {
      if (!this.inGuardDist && this.held(K_B)) this.push(K_B | REL);
    };
    if (this.inGuardDist && p.moveType === 'i' && p.ctrl) {
      if (d.guard) {
        if (this.guarding) return releaseBack();
        if (this.held(K_U)) this.push(K_U | REL);
        if (this.held(K_F)) this.push(K_F | REL);
        const gf = guardFlagBits(opp);
        if (gf & 8 && !(gf & 4) && !this.held(K_D)) this.push(K_D);
        if (!(gf & 8) && gf & 4 && this.held(K_D)) this.push(K_D | REL);
        if (!this.held(K_B)) this.push(K_B);
        return;
      }
      if (this.held(K_B)) this.push(K_B | REL);
    }
    if (this.guarding) return releaseBack();
    const ddx = (p.wx - opp.wx) * k;
    const adx = Math.fround(Math.abs(ftoi(ddx)));
    const pvx = p.vel.x * p.facing * p.scale * k;
    const ovx = opp.vel.x * opp.facing * opp.scale * k;
    if (d.distance) {
      const want = this.scale320(d.distance);
      if (!(want >= adx)) {
        // Too far: walk in.
        if (d.stance === 1 && (this.held(K_U) || this.held(K_D) || this.held(K_B))) this.dummyTimer = 5;
        if (this.held(K_U)) this.push(K_U | REL);
        if (this.held(K_D)) this.push(K_D | REL);
        if (this.held(K_B)) this.push(K_B | REL);
        if (this.dummyTimer === 0 && !this.held(K_F)) this.push(K_F);
        return;
      }
      const diff = want - adx;
      if (Math.fround(-20 * opp.facing) * ovx <= diff || !(pvx * ddx > 0)) {
        if (this.held(K_F)) return this.push(K_F | REL);
      } else return;
    }
    if (d.jumpDistance && !this.atScreenEdge()) {
      const want = this.scale320(d.jumpDistance);
      if (!(want <= adx)) {
        // Too close: back off.
        if (d.stance === 1 && (this.held(K_U) || this.held(K_D) || this.held(K_F))) this.dummyTimer = 5;
        if (this.held(K_U)) this.push(K_U | REL);
        if (this.held(K_D)) this.push(K_D | REL);
        if (this.held(K_F)) this.push(K_F | REL);
        if (this.dummyTimer === 0 && !this.held(K_B)) this.push(K_B);
        return;
      }
      if (Math.fround(20 * opp.facing) * ovx <= adx - want || !(pvx * ddx >= 0)) {
        if (this.held(K_B)) return this.push(K_B | REL);
      } else return;
    }
    const rel = (key: number) => {
      if (this.held(key)) this.push(key | REL);
    };
    switch (d.stance) {
      case 0: // stand
        rel(K_U), rel(K_D), rel(K_B), rel(K_F);
        break;
      case 1: // crouch
        rel(K_U);
        if (!this.held(K_D)) this.push(K_D);
        rel(K_B), rel(K_F);
        break;
      case 2: // jump
        rel(K_D), rel(K_B), rel(K_F);
        if (p.wy === 0) {
          if (!this.held(K_U)) this.push(K_U);
        } else rel(K_U);
        break;
      case 3: // jump repeatedly (hold up while falling)
        rel(K_D), rel(K_B), rel(K_F);
        if (p.wy === 0 || p.vel.y > 0) {
          if (!this.held(K_U)) this.push(K_U);
        } else rel(K_U);
        break;
    }
    if (!d.button) return;
    const key = d.button + 4;
    this.dummyTimer = 5;
    this.push(this.held(key) ? key | REL : key);
  }

  /** 0x4342f0: within 5 internal units of either screen limit. */
  private atScreenEdge(): boolean {
    const p = this.p;
    const [lo, hi] = p.world.screenLimits(p);
    return Math.abs(p.wx - lo) * this.k < 5 || Math.abs(p.wx - hi) * this.k < 5;
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
    const w = this.watched;
    // Frozen while the watched player is in hit pause (p+0xef8), like its recording.
    if (this.watching && w && w.hitPause <= 0 && !this.p.world.pause && !this.p.world.superPause) this.watchTime++;
  }

  /** 0x430900: returns true when the state changed. */
  private updateState(opp: Player): boolean {
    const p = this.p;
    const level = this.level;
    const w = this.watched;
    const adx = this.adx(opp);
    const st = this.state;
    // Stop watching once the opponent's move is over.
    if (this.msg(1, opp, false) || opp.moveType === 'i' || opp.moveType === 'h') {
      this.watching = false;
      this.watchTime = 0;
    }
    if (st === 0 && level !== 9) {
      let c = this.rand(60);
      if (this.stateTime > 150) c = Math.trunc(c / 2);
      if (adx < 100) c = Math.trunc(c / 2);
      if (adx < 50) c = Math.trunc(c / 2);
      if (p.moveType === 'h') {
        if (p.ghv.hitcount > 2) c = Math.trunc(c / 2);
        if (p.stateType === 'l') c = Math.trunc(c / 2);
      }
      // p+0x1520 is HitCount: a move that has hit sends the AI to state 4.
      if (c === 0 || (this.stateTime > 0 && p.hitCount !== 0)) return this.toState(4);
    }
    // The opponent started a command move: watch it if there is a record.
    const m0 = this.msg(0, opp, true);
    if (m0) {
      const r = this.rand(12);
      const cur = opp.recorder?.curAttack;
      if (DEBUG) DEBUG.push(`m0:${m0.stateNo} cur:${cur?.stateNo} tbl:${[...(opp.recorder?.tblSC.keys() ?? [])]}`);
      if (r < level + 3 && m0.hasTable && cur) {
        this.watchRec = cloneRecord(cur);
        this.watching = true;
        this.watchTime = 0;
        this.watched = opp;
      }
    }
    // Guard when the watched move's recorded hitbox would reach us.
    const s2 = this.state;
    const rec = this.watchRec;
    if ((s2 === 0 || s2 === 1 || s2 === 4) && this.watching && rec && this.cooldown === 0 && p.ctrl) {
      const t = this.watchTime;
      const mt = rec.hit[0].time.mean;
      if (mt > t || mt === 0) {
        const hit = attackWouldHit(p, opp, rec);
        if (DEBUG) DEBUG.push(`would:${hit}`);
        if (hit) {
          this.cooldown = 5;
          if (level >= 1 && level <= 3) this.cooldown += this.rand(4 - level);
          if (this.rand(20) <= level + 11) return this.toState(3);
        }
      }
    }
    if (this.state !== 3) return false;
    if (!this.watching || !rec || !w) return this.toState(0);
    const t = this.watchTime;
    let kind = w.recorder?.contact ?? 0;
    if (kind === 0) {
      if (ftoi(rec.hit[0].time.mean) === 0) {
        kind = 1;
        if (ftoi(rec.hit[1].time.mean) === 0) kind = 2;
      }
    } else if (kind === 1 && ftoi(rec.hit[1].time.mean) === 0) kind = 2;
    if (this.msg(0, opp, false)) return this.toState(0);
    // Counter before the move resolves.
    if (t > 0 && t < ftoi(rec.total.mean)) {
      const c0 = (t >= 3 ? 2 : 5) + (t >> 2);
      let chance = ftoi(c0 - 6 / (rec.total.mean - t));
      if (level === 9) chance = 0;
      if (this.rand(100) < chance && this.buildAttackList() > 0) return this.pickAttack();
    }
    if (this.stateTime === 0) {
      const gf = rec.guardFlag;
      if (gf !== -1) this.needCrouchGuard = (gf & 0xc) === 0xc ? p.stateType === 'c' : ((gf >> 3) & 1) === 1;
    }
    const due = rec.hit[kind]!.time.mean <= t;
    const m1 = this.msg(1, opp, true);
    if (!m1 && !due) return false;
    if (!p.ctrl) return false;
    let chance = 5 * level;
    if (adx > 200) chance = Math.trunc(chance / 2);
    if (adx > 150) chance = Math.trunc(chance / 2);
    if (adx < 100) chance += 10;
    if (adx < 75) chance += 10;
    if (adx < 50) chance += 10;
    if ((this.rand(100) < chance || level === 9) && this.buildAttackList() > 0) return this.pickAttack();
    return this.toState(0);
  }

  private pickAttack(): true {
    if (DEBUG) DEBUG.push(`list:${this.attackList.map((r) => r.stateNo).join('/')}`);
    this.attack = this.attackList[this.rand(this.attackList.length)]!;
    this.attackWant = '';
    this.attackSent = false;
    return this.toState(2);
  }

  /** 0x431970: own recorded moves that would beat the watched one. */
  private buildAttackList(): number {
    const p = this.p;
    const w = this.watched;
    const rec = this.watchRec;
    this.attackList = [];
    if (!this.watching || !rec) return 0;
    const tbl = p.recorder?.table();
    if (!tbl || !w) return 0;
    const t = this.watchTime;
    const kind = w.recorder?.contact ?? 0;
    let tt: number;
    let haveT: boolean;
    if (!(rec.total.mean <= t)) {
      tt = ftoi(rec.total.mean - t);
      haveT = true;
    } else {
      const e = rec.recov[kind]!.time.mean;
      if (e === 0) return 0;
      tt = ftoi(e - t);
      haveT = false;
    }
    for (const r of tbl.values()) {
      if (this.attackList.length >= 49) break;
      let score = tt > r.total.mean ? 100 : 0;
      if (!attackWouldHit(w, p, r)) score -= 100;
      const ra = r.revAttr;
      if (ra !== 0) {
        if (haveT) {
          if (ftoi(r.hit[0].time.mean) < tt) score -= 100;
          const x = rec.attr & ra;
          if ((x & 7) === 0 || (x & ~7) === 0) score -= 100;
        } else score -= 100;
      }
      const cf = rec.revAttr;
      if (cf !== 0) {
        const y = r.attr & cf;
        if (haveT && y & 7 && y & ~7) score -= 100;
      }
      if (!p.ctrl) score -= 100;
      if (DEBUG) DEBUG.push(`r${r.stateNo}:tt${tt}:tot${r.total.mean}:sc${score}`);
      if (score > 0) this.attackList.push(r);
    }
    return this.attackList.length;
  }

  /** 0x431200. */
  private stateIdle(): void {
    if (this.stateTime === 0 && this.prevState === 4) this.releaseAllExcept(0);
    if (this.stateTime >= 1 && (this.prevState === 3 || this.prevState === 2) && !this.inGuardDist) this.releaseDirsExcept(0);
  }

  /** 0x4314f0: take the move's starting stance, then fire its command. */
  private stateAttack(): boolean {
    const p = this.p;
    const atk = this.attack;
    if (!atk) return this.toState(0);
    if (this.stateTime === 0) {
      this.attackWant = '';
      for (const e of atk.entries) {
        if (e.stateType === p.stateType) {
          this.attackWant = e.stateType;
          break;
        }
        if (!this.attackWant) this.attackWant = e.stateType;
      }
    }
    if (!this.attackSent) {
      const want = this.attackWant;
      if (want && p.stateType !== want) {
        if (want === 'c') {
          if (this.held(K_U)) this.push(K_U | REL);
          if (!this.held(K_D)) this.push(K_D);
        } else if (want === 's') {
          if (this.held(K_U)) this.push(K_U | REL);
          if (this.held(K_D)) this.push(K_D | REL);
        } else if (want === 'a') {
          if (this.held(K_D)) this.push(K_D | REL);
          if (!this.held(K_U)) this.push(K_U);
        }
      }
      if (p.stateType === want || this.stateTime > 4) {
        const c = atk.cmd[0];
        if (c !== undefined && c >= 0 && this.cmds.length < 9) this.cmds.push(c);
        this.attackSent = true;
      }
    }
    if (p.moveType === 'i' && this.attackSent && this.stateTime > 0) return this.toState(0);
    return false;
  }

  /** 0x431680. */
  private stateGuard(): boolean {
    const p = this.p;
    if (this.inGuardDist && p.moveType === 'i' && p.ctrl) {
      if (this.held(K_U)) this.push(K_U | REL);
      if (this.held(K_F)) this.push(K_F | REL);
      if (!this.held(K_B)) this.push(K_B);
      if (this.needCrouchGuard) {
        if (!this.held(K_D)) this.push(K_D);
      } else if (this.held(K_D)) this.push(K_D | REL);
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
    // The opponent started a command move: back to idle.
    if (level === 9 ? this.msg(1, opp, true) : this.msg(0, opp, false)) return this.toState(0);
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
        // attr & 0x6d8: a normal or special (not hyper) attack.
        const notHyper = p.hitDef ? p.hitDef.attrType[0] !== 'h' : false;
        const cthr = this.contactKind === 2 ? (notHyper ? 250 : 500) : 750;
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
