// Round / match flow driven by fight.def [Round] timings.
//
// RoundState (trigger.html): 0 pre-intro, 1 intro, 2 fight, 3 pre-over (KO or
// time over), 4 over (win poses). Timings mirror the [Round] parameters; the
// exact tick alignment still has to be checked against the reference binary.

import type { Player } from './player';
import type { World } from './world';

export interface RoundConfig {
  matchWins: number;
  maxDrawGames: number;
  startWaitTime: number;
  roundTime: number;
  roundDisplayTime: number;
  roundSndTime: number;
  fightTime: number;
  fightSndTime: number;
  ctrlTime: number;
  koTime: number;
  koSndTime: number;
  slowTime: number;
  overWaitTime: number;
  overHitTime: number;
  overWinTime: number;
  overTime: number;
  winTime: number;
  /** Round length in seconds (-1 = no timer). */
  roundSeconds: number;
  framesPerCount: number;
}

/**
 * Ticks between our intro-end detection and the round announcement. Measured
 * with tools/harness against MUGEN 1.1: RoundState 2 starts 70 ticks after the
 * intro's last state change with data/fight.def (60 display + 10); our
 * detection already lags by 2 ticks.
 */
export const ROUND_LEAD = 8;

export const DEFAULT_ROUND: RoundConfig = {
  matchWins: 2,
  maxDrawGames: 1,
  startWaitTime: 30,
  roundTime: 0,
  roundDisplayTime: 60,
  roundSndTime: 0,
  fightTime: 0,
  fightSndTime: 0,
  ctrlTime: 30,
  koTime: 0,
  koSndTime: 0,
  slowTime: 60,
  overWaitTime: 45,
  overHitTime: 10,
  overWinTime: 45,
  overTime: 210,
  winTime: 60,
  roundSeconds: 99,
  framesPerCount: 60,
};

/** HUD-visible announcements. */
export type Announce =
  | { kind: 'round'; round: number; age: number }
  | { kind: 'fight'; age: number }
  | { kind: 'ko' | 'dko' | 'to'; age: number }
  | { kind: 'win'; winner: Player | null; age: number };

export interface StartPos {
  x: number;
  y: number;
  facing: number;
}

export class Match {
  round = 1;
  wins: [number, number] = [0, 0];
  draws = 0;
  /** Ticks remaining on the round clock (-1 = infinite). */
  clock: number;
  announce: Announce | undefined;
  /** Sounds from fight.snd requested this tick ([group, number]). */
  sounds: [number, number][] = [];
  matchOver = false;
  /** Set when the match (including the win announcement) is over. */
  finished = false;
  /** Restart from round 1 when finished (training / standalone use). */
  autoRematch = true;
  /** Winner of the match (null = draw), valid once matchOver. */
  winner: Player | null = null;
  private phaseTime = 0;
  private phase: 'wait' | 'intro' | 'announce' | 'fight' | 'ko' | 'over' | 'win' = 'wait';
  private roundWinner: Player | null = null;
  /** KO slowdown: frame-skip accumulator, its rate and the ticks run since the KO. */
  private slowAcc = 0;
  private slowRate = 0;
  private koTicks = 0;

  constructor(
    readonly world: World,
    readonly cfg: RoundConfig,
    readonly starts: [StartPos, StartPos],
  ) {
    this.clock = cfg.roundSeconds < 0 ? -1 : cfg.roundSeconds * cfg.framesPerCount;
    this.startRound();
  }

  get players(): Player[] {
    return this.world.players;
  }

  /** Seconds shown on the round clock. */
  get clockSeconds(): number {
    return this.clock < 0 ? -1 : Math.ceil(this.clock / this.cfg.framesPerCount);
  }

  private startRound(): void {
    const w = this.world;
    this.players.forEach((p, i) => {
      const s = this.starts[i]!;
      p.setWorldPos(s.x, s.y);
      p.vel.x = p.vel.y = 0;
      p.facing = s.facing;
      p.life = p.const('data.life');
      p.alive = true;
      p.ctrl = false;
      p.returnToOwnStates();
      p.targets.clear();
      p.recorder?.resetRound();
      p.ai?.resetRound();
      p.hitDefActive = false;
      p.hitDefSet = false;
      p.airJumpsLeft = 0;
      // Every round starts in 5900 (common1: clears the variables, then
      // 190 on round 1 or 0; measured: a probe's variables restart each
      // round in mugen.exe).
      if (p.compiledState(5900)) p.changeState(5900);
      else p.changeState(this.round === 1 && p.compiledState(190) ? 190 : 0);
      p.ctrl = false;
    });
    w.explods = [];
    w.projectiles = [];
    w.helpers = [];
    // The floor-dust cadence counts from each round's start (G+0x12760).
    w.fightTime = 0;
    w.camera.x = 0;
    w.camTarget = undefined;
    this.clock = this.cfg.roundSeconds < 0 ? -1 : this.cfg.roundSeconds * this.cfg.framesPerCount;
    this.phase = 'wait';
    this.phaseTime = 0;
    this.announce = undefined;
    this.roundWinner = null;
    w.roundState = 0;
    w.roundNo = this.round;
  }

  /** Advance one tick: returns true if the world should simulate this tick. */
  tick(): boolean {
    this.sounds = [];
    if (this.announce) this.announce.age++;
    const simulate = this.step();
    this.phaseTime++;
    return simulate;
  }

  private step(): boolean {
    const w = this.world;
    const c = this.cfg;
    w.inputLocked = this.phase !== 'fight' && this.phase !== 'ko';
    switch (this.phase) {
      case 'wait':
        if (this.phaseTime >= c.startWaitTime) {
          // RoundState 1 is visible from this very tick (KFM's intro waits for it).
          w.roundState = 1;
          this.enter('intro');
        }
        break;
      case 'intro':
        w.roundState = 1;
        // Intros last while any player asserts "intro".
        if ((this.round > 1 || this.phaseTime > 1) && !this.players.some((p) => p.special.has('intro'))) {
          for (const p of this.players) if (p.stateNo === 190 || p.stateNo === 191) p.changeState(0);
          this.enter('announce');
        }
        break;
      case 'announce': {
        // Measured against MUGEN 1.1 (tools/harness): RoundState 2 begins when
        // "Fight" appears, ROUND_LEAD ticks after the intro ends plus the
        // round display time; control is given ctrl.time ticks later.
        const t = this.phaseTime;
        const roundAt = ROUND_LEAD + c.roundTime;
        if (t === roundAt) this.announce = { kind: 'round', round: this.round, age: 0 };
        if (t === roundAt + c.roundSndTime) this.sounds.push([0, Math.min(this.round, 9)]);
        const fightAt = roundAt + c.roundDisplayTime + c.fightTime;
        if (t >= fightAt) {
          this.announce = { kind: 'fight', age: 0 };
          w.inputLocked = false;
          w.roundState = 2;
          // This tick is tick 0 of the fight: control comes exactly ctrl.time later.
          this.phase = 'fight';
          this.phaseTime = 0;
          return true;
        }
        break;
      }
      case 'fight': {
        w.roundState = 2;
        if (this.phaseTime === c.ctrlTime) for (const p of this.players) p.ctrl = true;
        if (this.phaseTime === c.fightSndTime) this.sounds.push([1, 0]);
        if (this.clock > 0) this.clock--;
        const dead = this.players.filter((p) => p.life <= 0);
        if (dead.length || this.clock === 0) {
          if (dead.length === 2) this.announce = { kind: 'dko', age: 0 };
          else if (dead.length) this.announce = { kind: 'ko', age: 0 };
          else this.announce = { kind: 'to', age: 0 };
          this.sounds.push([2, dead.length === 2 ? 1 : dead.length ? 0 : 2]);
          this.roundWinner = this.decideWinner();
          for (const p of this.players) if (p.life <= 0) p.alive = false;
          w.roundState = 3;
          // G+0x12760 restarts at 0 and still counts the KO tick.
          this.koTicks = 1;
          this.slowRate = this.slowAcc = 500;
          this.enter('ko');
        }
        break;
      }
      case 'ko': {
        w.roundState = 3;
        // KO slowdown (mugen.exe 0x40cc31 / 0x4149cd / 0x414b09): a speed
        // accumulator checked every frame before the tick: when positive it
        // loses 100, otherwise it gains the rate; the tick runs only if it
        // ends up <= 0. The rate is 500 (1/6 speed) from the KO, then by
        // ticks run since: 200 at 5, 100 at slow.time/2, 50 at 7/10, 25 at
        // 9/10, none at slow.time (measured against gametime in mugen.exe).
        if (this.slowRate > 0) {
          if (this.slowAcc > 0) this.slowAcc -= 100;
          else this.slowAcc += this.slowRate;
          if (this.slowAcc > 0) return false;
        }
        const k = this.koTicks++;
        const st = c.slowTime;
        const setRate = (r: number) => {
          this.slowRate = r;
          this.slowAcc = r;
        };
        if (k === 5 && k < Math.trunc((st * 5) / 10)) setRate(200);
        if (k === Math.trunc((st * 5) / 10)) setRate(100);
        if (k === Math.trunc((st * 7) / 10)) setRate(50);
        if (k === Math.trunc((st * 9) / 10)) setRate(25);
        if (k >= st) setRate(0);
        // Round end (0x414d20): after over.waittime ticks run, once every
        // player has settled (ctrl, standing and idle, or lying in 5150 with
        // time > 0), or after 900 ticks regardless.
        const settled = this.players.every(
          (p) => (p.ctrl && p.stateType === 's' && p.moveType === 'i') || (p.stateNo === 5150 && p.time > 0),
        );
        if (k >= c.overWaitTime && (settled || k >= 900)) {
          for (const p of this.players) p.ctrl = false;
          this.slowRate = this.slowAcc = 0;
          w.roundState = 4;
          this.enter('over');
          // The round counter restarts at 0 and still counts this tick.
          this.phaseTime = 0;
        }
        break;
      }
      case 'over':
        w.roundState = 4;
        // Winners go to their win pose once everyone has settled.
        if (this.phaseTime === c.overWinTime) {
          for (const p of this.players) {
            if (p === this.roundWinner && p.compiledState(180)) p.changeState(180);
          }
          this.scoreRound();
          if (this.matchOver) this.announce = { kind: 'win', winner: this.roundWinner, age: 0 };
        }
        if (this.phaseTime >= c.overTime) {
          if (this.matchOver) this.enter('win');
          else {
            // The reset frame runs no tick; 5900 runs on the next one
            // (measured in mugen.exe: frame 3410 has no tick between the
            // last RoundState 4 tick and 5900).
            this.round++;
            this.startRound();
            this.phaseTime = -1;
            return false;
          }
        }
        break;
      case 'win':
        if (this.phaseTime >= c.winTime + 480) {
          this.finished = true;
          if (!this.autoRematch) break;
          // Rematch from round 1 (no select screen yet).
          this.round = 1;
          this.wins = [0, 0];
          this.draws = 0;
          this.matchOver = false;
          this.startRound();
        }
        break;
    }
    return true;
  }

  private enter(phase: Match['phase']): void {
    this.phase = phase;
    // tick() increments after this step, so the new phase starts at 0.
    this.phaseTime = -1;
  }

  private decideWinner(): Player | null {
    const [a, b] = this.players;
    if (!a || !b) return null;
    if (a.life === b.life) return null;
    return a.life > b.life ? a : b;
  }

  private scoreRound(): void {
    const w = this.roundWinner;
    if (!w) this.draws++;
    else this.wins[w.side]!++;
    if (this.wins[0] >= this.cfg.matchWins || this.wins[1] >= this.cfg.matchWins || this.draws > this.cfg.maxDrawGames) {
      this.matchOver = true;
      this.winner = this.wins[0] === this.wins[1] ? null : this.players[this.wins[0] > this.wins[1] ? 0 : 1] ?? null;
    }
  }
}
