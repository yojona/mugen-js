// Round / match flow driven by fight.def [Round] timings.
//
// RoundState (trigger.html): 0 pre-intro, 1 intro, 2 fight, 3 pre-over (KO or
// time over), 4 over (win poses). Timings mirror the [Round] parameters; the
// exact tick alignment still has to be checked against the reference binary.

import { emptyGetHitVars } from './hitdef';
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
  /** Ticks remaining on the round clock (-1 = infinite): (Time + 1) * framespercount - 1 at the start, as mugen.exe's round_time. */
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
  private noSlow = false;
  private koTicks = 0;
  /** RoundState 4 lasts until this tick (over.time, pushed back by roundnotover). */
  private overEndTime = 0;

  private frameNo = 0;

  constructor(
    readonly world: World,
    readonly cfg: RoundConfig,
    readonly starts: [StartPos, StartPos],
  ) {
    world.framesDriven = true;
    world.overHitTime = cfg.overHitTime;
    this.clock = cfg.roundSeconds < 0 ? -1 : (cfg.roundSeconds + 1) * cfg.framesPerCount - 1;
    this.startRound();
  }

  get players(): Player[] {
    return this.world.players;
  }

  /** Seconds shown on the round clock. */
  get clockSeconds(): number {
    return this.clock < 0 ? -1 : Math.floor(this.clock / this.cfg.framesPerCount);
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
      // Player_Reset: standing idle in the own action 0, no pause or freeze.
      // (The reset comes after the frame's animation step: it starts moving
      // a tick later.)
      p.changeAnim(0);
      p.skipAnimTick = true;
      p.stateType = 's';
      p.moveType = 'i';
      p.physics = 's';
      p.hitPause = 0;
      p.posFreeze = false;
      p.nextFacing = 0;
      p.ghvAttacker = undefined;
      p.nohitTime = 0;
      p.defMul = undefined;
      p.cornerPushVel = 0;
      // ...and clears the get-hit variables (hit count, fall...).
      p.ghv = emptyGetHitVars();
      p.ghv.recovertime = p.const('data.liedown.time');
      p.targets.clear();
      p.targetJuggle.clear();
      p.noInputStates = false;
      p.recorder?.resetRound();
      p.ai?.resetRound();
      p.hitDefActive = false;
      p.hitDefSet = false;
      p.airJumpsLeft = 0;
      // Player reset (char.c): the variables below the persist indices are
      // cleared, the others carry over to the next round.
      p.vars.fill(0, 0, Math.max(0, Math.min(p.vars.length, p.const('data.intpersistindex'))));
      p.fvars.fill(0, 0, Math.max(0, Math.min(p.fvars.length, p.const('data.floatpersistindex'))));
      p.sysVars.fill(0);
      p.sysFvars.fill(0);
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
    // Camera_Reset: the edges back at the start position; camera_mode 0.
    w.camEdges = undefined;
    w.cameraMode = 0;
    this.clock = this.cfg.roundSeconds < 0 ? -1 : (this.cfg.roundSeconds + 1) * this.cfg.framesPerCount - 1;
    this.phase = 'wait';
    this.phaseTime = 0;
    this.announce = undefined;
    this.roundWinner = null;
    w.winType = 0;
    w.roundWinnerSide = 0;
    w.roundState = 0;
    w.roundNo = this.round;
  }

  /** Advance one tick: returns true if the world should simulate this tick. */
  tick(): boolean {
    // Frames shown before this one (mugen.exe counts at the end of a frame).
    this.world.frames = this.frameNo++;
    this.sounds = [];
    if (this.announce) this.announce.age++;
    const simulate = this.step();
    this.phaseTime++;
    // Round_RunState's end: camera_mode++ every tick.
    this.world.cameraMode++;
    return simulate;
  }

  private step(): boolean {
    const w = this.world;
    const c = this.cfg;
    w.inputLocked = this.phase !== 'fight' && this.phase !== 'ko';
    // hits_enabled (Round_RunState): no collisions in RoundState 0 and 4,
    // nor in 3 from over.waittime + 180 ticks.
    w.hitsEnabled = this.phase !== 'wait' && this.phase !== 'over';
    w.roundClock = undefined;
    switch (this.phase) {
      case 'wait':
        if (this.phaseTime >= c.startWaitTime) {
          w.hitsEnabled = true;
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
        // ctrl.time (Round_RunState case 2): control for everyone alive, and
        // whoever is not in state 0 goes back to its own state 0.
        if (this.phaseTime === c.ctrlTime) {
          for (const p of this.players) {
            if (!p.alive) continue;
            p.ctrl = true;
            if (p.stateNo !== 0) p.resetToOwnState0();
          }
        }
        if (this.phaseTime === c.fightSndTime) this.sounds.push([1, 0]);
        // Round_RunState: the clock runs from ctrl.time on, not during a
        // Pause / SuperPause or while AssertSpecial timerfreeze holds; time
        // is over when it reaches 0 after ctrl.time.
        let timeUp = false;
        const timerFreeze = this.players.some((p) => p.special.has('timerfreeze')) || w.helpers.some((h) => h.special.has('timerfreeze'));
        if (!w.pause && !w.superPause && !timerFreeze && this.phaseTime >= c.ctrlTime && this.clock > 0) {
          this.clock--;
          timeUp = this.clock === 0 && this.phaseTime > c.ctrlTime;
        }
        // KO: players their own update found out of life (p->alive).
        const dead = this.players.filter((p) => !p.alive);
        // Not before ctrl.time, nor with AssertSpecial noko.
        const noKo = this.players.some((p) => p.special.has('noko')) || w.helpers.some((h) => h.special.has('noko'));
        if ((dead.length || timeUp) && this.phaseTime > c.ctrlTime && !noKo) {
          if (dead.length === 2) this.announce = { kind: 'dko', age: 0 };
          else if (dead.length) this.announce = { kind: 'ko', age: 0 };
          else this.announce = { kind: 'to', age: 0 };
          this.sounds.push([2, dead.length === 2 ? 1 : dead.length ? 0 : 2]);
          this.roundWinner = this.decideWinner();
          w.winType = dead.length ? 1 : 2;
          w.roundWinnerSide = this.roundWinner ? this.roundWinner.side + 1 : 0;
          for (const p of this.players) if (p.life <= 0) p.alive = false;
          w.roundState = 3;
          // G+0x12760 restarts at 0 and still counts the KO tick.
          this.koTicks = 1;
          w.roundClock = 1;
          // No slow motion on a time over or with AssertSpecial nokoslow.
          const noKoSlow = this.players.some((p) => p.special.has('nokoslow')) || w.helpers.some((h) => h.special.has('nokoslow'));
          this.slowRate = this.slowAcc = timeUp || noKoSlow ? 0 : 500;
          // slow_time 0: the slow motion steps below are undone every tick.
          this.noSlow = timeUp || noKoSlow;
          // A time over stops everyone's input at once (no_input_states).
          if (timeUp) for (const p of this.players) p.noInputStates = true;
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
        w.roundClock = this.koTicks;
        const st = c.slowTime;
        const setRate = (r: number) => {
          this.slowRate = r;
          this.slowAcc = r;
        };
        if (w.winType !== 2) {
          if (k === 5 && k < Math.trunc((st * 5) / 10)) setRate(200);
          if (k === Math.trunc((st * 5) / 10)) setRate(100);
          if (k === Math.trunc((st * 7) / 10)) setRate(50);
          if (k === Math.trunc((st * 9) / 10)) setRate(25);
        }
        if (k >= st || this.noSlow) setRate(0);
        // At over.waittime nobody takes input any more (no_input_states).
        if (k === c.overWaitTime) for (const p of this.players) p.noInputStates = true;
        if (k >= c.overWaitTime + 180) w.hitsEnabled = false;
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
          w.hitsEnabled = false;
          w.roundClock = 1;
          this.enter('over');
          this.overEndTime = c.overTime;
          // The round counter restarts at 0 and still counts this tick.
          this.phaseTime = 0;
        }
        break;
      }
      case 'over':
        w.roundClock = this.phaseTime + 1;
        w.roundState = 4;
        // At over.wintime the winners go to their win pose, the losers still
        // standing to 170, everyone to 175 on a draw (Round_RunState case 4).
        if (this.phaseTime === c.overWinTime) {
          for (const p of this.players) {
            if (!p.alive) continue;
            if (p === this.roundWinner) p.noInputStates = false;
            const no = !this.roundWinner ? 175 : p === this.roundWinner ? 180 : 170;
            if (p.compiledState(no)) p.changeState(no);
          }
          this.scoreRound();
          if (this.matchOver) this.announce = { kind: 'win', winner: this.roundWinner, age: 0 };
        }
        // AssertSpecial roundnotover (asserted during the last tick) keeps
        // the round going for 19 more ticks.
        if (this.players.some((p) => p.special.has('roundnotover')) || w.helpers.some((h) => h.special.has('roundnotover'))) {
          this.overEndTime = this.phaseTime + 19;
        }
        if (this.phaseTime >= this.overEndTime) {
          // The match ends with the last round's over.time (measured: the
          // victory screen follows 213 frames after RoundState 4).
          if (this.matchOver) {
            this.finished = true;
            if (this.autoRematch) this.enter('win');
          }
          else {
            // The reset frame runs no tick; 5900 runs on the next one
            // (measured in mugen.exe: frame 3410 has no tick between the
            // last RoundState 4 tick and 5900).
            this.round++;
            for (const p of this.players) p.roundsExisted++;
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
    // Round_RunState: each side's life in 1/1000 of its maximum, plus 1 alive.
    const score = (p: Player) => Math.trunc((p.life * 1000) / p.const('data.life')) + (p.alive ? 1 : 0);
    const sa = score(a);
    const sb = score(b);
    if (sa === sb) return null;
    return sa > sb ? a : b;
  }

  private scoreRound(): void {
    const w = this.roundWinner;
    if (!w) {
      // A draw past match.maxdrawgames gives both sides a round win.
      this.draws++;
      if (this.draws > this.cfg.maxDrawGames) {
        this.wins[0]!++;
        this.wins[1]!++;
      }
    } else this.wins[w.side]!++;
    // Match_CheckOver: over once a side has match.wins; both at once: side 1.
    const w0 = this.wins[0]! >= this.cfg.matchWins;
    const w1 = this.wins[1]! >= this.cfg.matchWins;
    if (w0 || w1) {
      this.matchOver = true;
      this.winner = this.players[w0 ? 0 : 1] ?? null;
    }
  }
}
