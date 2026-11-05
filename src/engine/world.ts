// Match world: players, camera, stage bounds and the fixed 60 Hz tick.

import { CommandInput } from './cmd';
import type { AnimationMap } from '../formats/air';
import type { Sff } from '../formats/sff';
import { clsn2TouchInternal, postResolvedMessages, Recorder } from './ai-learn';
import { applyHits, applyProjectileHits, collideProjectiles, hitProjectilesByHitDefs, detectHits, detectProjectileHits } from './combat';
import { simpleExplod, updateExplod, type Explod } from './explod';
import { updateProjectile, type Projectile } from './projectile';
import { newPalFx, recordAfterImage, tickPalFx, type EnvShake, type PalFxState } from './fx';
import type { SoundRef, SparkRef } from './hitdef';
import type { Player } from './player';

/** Common effects (data/fightfx.air + .sff). */
export interface FightFx {
  anims: AnimationMap;
  sff: Sff;
  /** fight.def [FightFx] scale (default 1). */
  scale?: number;
  /** The motif's localcoord width: fightfx sprites are in motif pixels. */
  motifWidth?: number;
}

interface PauseState {
  owner: Player;
  time: number;
  moveTime: number;
  fresh?: boolean;
  darken: boolean;
  /** Game_Tick darkens from the tick after the SuperPause ran (pause_kind is decided as the tick starts). */
  dimming?: boolean;
  unhittable: boolean;
  /** endcmdbuftime: in its last frames the paused players' commands stay active (floor 2). */
  endCmdBufTime: number;
}

/** fight.h WIN_ICON_*: the [WinIcon] icon of each way to win a round. */
export const WIN_ICON = { n: 0, s: 1, h: 2, c: 3, t: 4, throw: 5, suicide: 6, teammate: 7, perfect: 8 } as const;

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
  /**
   * win_icons / win_perfect: per side and won round, how it was won
   * (WIN_ICON_*) and the perfect overlay, -1 = none. The match clears them
   * at its start and keeps rounds_won (roundsWon).
   */
  winIcons: number[][] = [new Array(10).fill(-1), new Array(10).fill(-1)];
  winPerfect: number[][] = [new Array(10).fill(-1), new Array(10).fill(-1)];
  roundsWon: () => readonly number[] = () => [0, 0];
  /** Match_CheckOver for the MatchOver trigger. */
  matchOverNow: () => boolean = () => false;
  /** GameVars.arcade_match (MatchNo). */
  matchNo = 1;

  resetWinIcons(): void {
    for (const a of [...this.winIcons, ...this.winPerfect]) a.fill(-1);
  }

  /** Team_HasFullLife: every character (not helper) of the side has full life. */
  teamHasFullLife(side: number): boolean {
    return this.players.every((p) => p.isHelper || p.destroyed || p.side !== side || p.life === p.lifeMax);
  }

  /**
   * Round_SetWinType: how side `side` (0 / 1) wins the current round: `type`,
   * or with -1 from the finishing hit's attr (normal, throw, special, hyper),
   * plus the perfect icon with full life. Not past 10 rounds, nor once the
   * round is over.
   */
  setWinType(side: number, type: number, attr = 0): void {
    const n = this.roundsWon()[side] ?? 0;
    if (n >= 10 || this.roundState === 3) return;
    if (type === -1) {
      type = WIN_ICON.n;
      if (attr & 0x1c0) type = WIN_ICON.throw;
      if (attr & 0x490) type = WIN_ICON.s;
      else if (attr & 0x920) type = WIN_ICON.h;
    }
    this.winIcons[side]![n] = type;
    this.winPerfect[side]![n] = this.teamHasFullLife(side) ? WIN_ICON.perfect : -1;
  }

  /** Round_SetKoWinType: a KO by a hit of `attackerSide` on a player of `side`; a teammate's KO gives the round to the other side. */
  setKoWinType(attackerSide: number, side: number, attr: number): void {
    if (attackerSide !== side) {
      this.setWinType(attackerSide, -1, attr);
      return;
    }
    const winner = 1 - attackerSide;
    const n = this.roundsWon()[winner] ?? 0;
    if (n >= 10 || this.roundState === 3) return;
    this.winIcons[winner]![n] = WIN_ICON.teammate;
    this.winPerfect[winner]![n] = this.teamHasFullLife(winner) ? WIN_ICON.perfect : -1;
  }
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
  /**
   * Stage units per fightfx sprite pixel: mugen.exe draws sparks, dust and
   * fightfx explods at fightfx_scale * motif_scale game pixels.
   */
  get fightFxScale(): number {
    const f = this.fightFx;
    return ((f?.scale ?? 1) * this.localWidth) / (f?.motifWidth ?? 320);
  }
  /** Training mode (team_variant 3): KO recovery and refills (Player_Update). */
  training = false;
  screenLeft = 15;
  screenRight = 15;
  /** Stage autoturn: ChangeState turns a player with control towards the enemy. */
  autoTurn = true;
  /** hits_enabled: Players_CheckHits (push, hits, projectile hits) runs. */
  hitsEnabled = true;
  /** fight.def over.hittime: in RoundState 3 from then on the living take no damage. */
  overHitTime = Infinity;
  shadow: { intensity: number; color: [number, number, number]; yscale: number; fadeRange: [number, number] } | undefined;
  /**
   * Combo counters per side: hits added this tick (Combo_AddHits) and
   * whether a combo is still going (Player_UpdateCombo); the HUD runs the rest.
   */
  comboAdded: [number, number] = [0, 0];
  /** Combo_AddHits ran this tick, even for 0 hits (it still restarts a shown counter's time). */
  comboTouched: [boolean, boolean] = [false, false];
  comboOngoing: [boolean, boolean] = [false, false];
  /** [Reflection] intensity (0..256): players mirrored on the floor. */
  reflection = 0;
  seed = 1;
  fightFx?: FightFx;
  explods: Explod[] = [];
  helpers: Player[] = [];
  projectiles: Projectile[] = [];
  /** Sounds requested this tick (common or player-owned), drained by the host. */
  /**
   * Sound commands of the tick, in order: plays (owner null = common.snd)
   * and the PlaySnd channel controls (StopSnd, SndPan). `key` names a
   * player's channel; plays without one never cut another sound.
   */
  sounds: SoundCmd[] = [];
  envShake: EnvShake | undefined;
  /**
   * EnvColor: the screen filled with a colour (time -1 = until replaced,
   * counted down once per game tick; the stage is not drawn while time != 0).
   */
  envColor: { rgb: [number, number, number]; time: number; under: boolean } | undefined;
  /** Zoom controller of this tick (internal units; cleared every tick). */
  zoom: { x: number; y: number; scale: number; lag: number } | undefined;
  /**
   * Camera_UpdateZoom's view (internal units): the zoomed edges, the draw
   * offset (shake_x/y) and the stage draw scale; neutral without a zoom.
   */
  zoomView = { l: 0, r: 0, shakeX: 0, shakeY: 0, scale: 1, active: false };
  /** BGPalFX: the stage's palette group (0x100). */
  bgPalFx: PalFxState = newPalFx();
  /** AllPalFX: the global PalFX, combined with every sprite's. */
  allPalFx: PalFxState = newPalFx();
  pause: PauseState | undefined;
  superPause: PauseState | undefined;
  /** A Pause requested during a SuperPause starts when the SuperPause ends. */
  private queuedPause: PauseState | undefined;

  /** Round_Reset: no pause, EnvShake or palette effect carries into a new round. */
  resetRoundFx(): void {
    this.pause = this.superPause = this.queuedPause = undefined;
    this.assertFlags.clear();
    this.envShake = undefined;
    this.shakeBase = 0;
    this.envColor = undefined;
    this.zoom = undefined;
    this.zoomView = { l: 0, r: 0, shakeX: 0, shakeY: 0, scale: 1, active: false };
    this.bgPalFx = newPalFx();
    this.allPalFx = newPalFx();
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
  /** team_side the slot's player last had (0: never used): Helper_Create's Player_Reset runs before it is set. */
  helperSlotSide: number[] = [];
  helperMax = 56;

  /** Returns false when every slot is taken (no helper is created). */
  addHelper(h: Player): boolean {
    let i = this.helperSlots.findIndex((x) => x === null || x.destroyed);
    if (i < 0) {
      if (this.helperSlots.length >= this.helperMax) return false;
      i = this.helperSlots.length;
    }
    this.helperSlots[i] = h;
    // Helper_Create: Player_Reset points power_ref at players[team_side]
    // while the slot still has its last player's team_side (0 on first use:
    // the helper's own power), then team_side becomes the parent's.
    const side = this.helperSlotSide[i] ?? 0;
    h.powerLeader = side ? this.players.find((p) => p.slotNo === side) : undefined;
    this.helperSlotSide[i] = h.side + 1;
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

  /**
   * Each side's team mode (TeamMode trigger: single, simul or turns; a team
   * of several members in turn reads turns).
   */
  teamModes: ['single' | 'simul' | 'turns', 'single' | 'simul' | 'turns'] = ['single', 'single'];

  /** players[n] of mugen.exe (1..4): P1, P2, P3 (P1's partner), P4 (P2's). */
  slot(n: number): Player | undefined {
    return this.players.find((p) => p.slotNo === n && !p.destroyed);
  }

  /** Player_GetPartner / CountPartners: the other root players of p's side, in slot order. */
  partnersOf(p: Player): Player[] {
    return this.players.filter((t) => !t.destroyed && t.side === p.side && t !== p && t !== p.root);
  }

  /** Player_GetEnemy / CountEnemies: the root players of the other side, in slot order. */
  enemiesOf(p: Player): Player[] {
    return this.players.filter((t) => !t.destroyed && t.side !== p.side);
  }

  /**
   * Player_GetNearEnemy: of the two enemy slots (P2/P4 or P1/P3), the nearest
   * (n = 0) or the other (n = 1) by |DistX|; the second needs both.
   */
  nearEnemy(p: Player, n: number): Player | undefined {
    if (n >= 2 || n < 0) return undefined;
    const [a, b] = p.side === 0 ? [this.slot(2), this.slot(4)] : [this.slot(1), this.slot(3)];
    if (!a && !b) return undefined;
    if (n === 0) {
      if (a && !b) return a;
      if (!a) return b;
    } else if (!a || !b) return undefined;
    const dist = (t: Player) => Math.abs(Math.fround((t.wx - p.wx) * p.facing));
    const da = dist(a!);
    const db = dist(b!);
    if (db <= da || Number.isNaN(da) || Number.isNaN(db)) return n === 0 ? b : a;
    return n === 0 ? a : b;
  }

  /** The P3 (partner) and P4 (other enemy) of the trigger context (trigger.c). */
  p3p4(p: Player): [Player | undefined, Player | undefined] {
    const [e1, e2] = p.side === 0 ? [this.slot(2), this.slot(4)] : [this.slot(1), this.slot(3)];
    const p2 = this.enemyOf(p);
    let p4: Player | undefined;
    if (e1 && e2) {
      if (p2 === e1) p4 = e2;
      else if (p2 === e2) p4 = e1;
      else p4 = Math.abs((e2.wx - p.wx) * p.facing) > Math.abs((e1.wx - p.wx) * p.facing) ? e2 : e1;
    } else if (p2) {
      p4 = e1;
      if (p2.isHelper ? p2.root === e1 : p2 === e1) p4 = e2;
    }
    const r = p.isHelper ? p.root : p;
    let idx = r.slotNo + 2;
    if (idx > 4) idx -= 4;
    return [this.slot(idx), p4];
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
      if (t === p || t.destroyed || (t.isHelper && t.helperType !== 1) || t.side === side) return;
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
  /** FrontEdgeDist / BackEdgeDist, in the player's units. */
  edgeDist(p: Player, front: boolean): number {
    return this.playerEdgeDist(p, false, front);
  }

  /** FrontEdgeBodyDist / BackEdgeBodyDist, in the player's units. */
  edgeBodyDist(p: Player, front: boolean): number {
    return this.playerEdgeDist(p, true, front);
  }

  /**
   * Player_EdgeDist (playerrel.c 0x4343d0), in internal units: from the
   * screen_left/right the camera is heading to (the stage's screenleft/right
   * from the target edges, as ScreenBound stores them); the body variant
   * adds the rounded Width edge, plus 1 in the air and 2 lying down.
   */
  private playerEdgeDist(p: Player, body: boolean, front: boolean): number {
    const k = this.gameWidth / this.screenWidth;
    const ce = this.camEdges ?? this.camInit();
    const sl = Math.fround(this.screenLeft * k + ce.lt);
    const sr = Math.fround(ce.rt - this.screenRight * k);
    const add = body ? (p.stateType === 'a' ? 1 : p.stateType === 'l' ? 2 : 0) : 0;
    const round = (v: number) => Math.floor(Math.fround(v) + 0.5);
    // The back edge always takes the back width (the original compares facing with -facing).
    const x = body ? round(p.bodyWidth(front ? 'front' : 'back', 'edge') * p.scale * k) + add : add;
    const px = p.wx * k;
    const d = front ? (x * p.facing + px - (p.facing === 1 ? sr : sl)) * -p.facing : (px - x * p.facing - (p.facing === 1 ? sl : sr)) * p.facing;
    return d / k / p.scale;
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
    // char.c: pauses[kind][6] < endcmdbuftime, read after gameloop's
    // per-frame decrement (one less than our count at input time).
    return !!ps && this.frozen(p) && ps.time - 1 < ps.endCmdBufTime;
  }

  /** Is the player frozen by a Pause/SuperPause this tick? */
  private frozen(p: Player): boolean {
    const ps = this.superPause ?? this.pause;
    if (!ps) return false;
    if (this.superPause ? p.superMoveTime !== 0 : p.pauseMoveTime !== 0) return false;
    return true;
  }

  /**
   * The AssertSpecial global flags, cleared by Round_Tick before the players
   * update. A player the tick doesn't run (in a pause) doesn't keep them up:
   * Athena's roundstate != 2 NoBarDisplay leaves the HUD on during the K.O. pause.
   */
  assertFlags = new Set<string>();

  globalFlag(flag: string): boolean {
    return this.assertFlags.has(flag);
  }

  get darkened(): boolean {
    return !!this.superPause?.darken && !!this.superPause.dimming;
  }

  /** Feed this tick's raw inputs (one bitmask per player) and advance one tick. */
  tick(inputs: number[]): void {
    this.comboAdded = [0, 0];
    this.comboTouched = [false, false];
    this.comboOngoing = [false, false];
    this.assertFlags.clear();
    // Before the round starts (and after it ends) input is ignored and nobody has control.
    if (this.roundState === 2) this.fightTime++;
    const active = this.allPlayers().filter((p) => !this.frozen(p));
    // Game_Tick ends the PalFX definitions before the states run: one set with
    // time 1 shows on the frame it is set and is gone on the next.
    tickPalFx(this.bgPalFx);
    tickPalFx(this.allPalFx);
    for (const p of active) tickPalFx(p.palFx);
    // MUGEN advances animations at the end of each player's update; here it
    // runs at the start of the next tick.
    for (const p of active) p.advanceAnim();
    const dustX = new Map(this.allPlayers().map((p) => [p, this.internalX(p)] as const));
    // MUGEN picks the pause owner before the tick (mugen.exe 0x40cc73): a
    // pause that starts during this tick does not stop its floor dust.
    const pausedAtStart = !!(this.pause || this.superPause);
    // gameloop's pause_kind for this tick: a pause counting since an earlier
    // tick (a Pause re-applied during the tick keeps it).
    const pauseKind = this.superPause && !this.superPause.fresh ? 1 : !this.superPause && this.pause && !this.pause.fresh ? 0 : -1;
    if (this.superPause && !this.superPause.fresh) this.superPause.dimming = true;
    this.updateEnemies();
    // MUGEN's order (main tick 0x4130xx): facing sync and human key events,
    // then the CPU AI pass, then every player's input processing.
    this.players.forEach((p, i) => {
      const raw = p.ai ? 0 : (inputs[i] ?? 0); // keys are read in every round state (round.c)
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
      // cmd_state.frozen is only cleared on a tick the player runs
      // (player_tick): a Pause / SuperPause keeps the buffers held to its end.
      const hold = p.hitPauseLastTick || p.cmdFrozen;
      p.hitPauseLastTick = p.hitPause > 0;
      p.cmdFrozen = hold && this.frozen(p);
      p.cmdInput!.update(this.gameTime, this.cmdFloor(p), p.ai?.cmds, hold);
      p.commands = p.noInputStates ? new Set() : p.cmdInput!.active();
      p.keyEventRecovery();
    }
    // Keyctrl helpers read the keys into their own command state (copied
    // from the root's when created). A CPU root's helper copies the root's
    // command state instead (Player_HandleInput): its held directions (the
    // AI's guard) match again, plus the commands the AI chose.
    for (const h of this.helpers) {
      if (!h.keyCtrl || h.destroyed || !h.cmdInput) continue;
      if (h.root.ai && h.root.cmdInput) {
        h.cmdInput.followRoot(h.root.cmdInput, this.gameTime, this.cmdFloor(h), h.root.ai.cmds);
        h.commands = h.cmdInput.active();
        continue;
      }
      const i = this.players.indexOf(h.root);
      const raw = h.root.ai ? 0 : (inputs[i] ?? 0);
      h.cmdInput.ingest(raw, h.facing, !h.root.ai);
      h.cmdInput.update(this.gameTime, this.cmdFloor(h));
      h.commands = h.cmdInput.active();
    }
    // Built-in transitions for everyone first, then each player runs its
    // states and moves before the next one (both measured against MUGEN 1.1).
    // They are part of input processing, so a player frozen by a SuperPause
    // still takes them (measured: the CPU's jump input during the pause
    // enters 40 twice, prevstateno 40).
    // Round_Tick: the Zoom controller must be asserted every tick.
    this.zoom = undefined;
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
      // Player_Update's paused flag (frozen by its own hit pause this update).
      p.paused = p.hitPause > 0;
      // BindToTarget/Parent/Root: the player is moved at the start of its
      // own update (TargetBind targets are placed by their binder).
      if (!p.bind?.byTarget) this.placeBound(p);
      const frozen = p.hitPause > 0;
      p.runStates();
      // mugen.exe Player_Update: the projectile contact clock runs after the
      // states, unless in hit pause; so do the HitBy / NotHitBy clocks.
      if (!frozen) {
        p.countShake();
        p.projContactTime++;
        p.hitByTail();
        // The movetimes, in the same tail (before the hits): with a pause
        // running since the tick began the player's movetime for it counts
        // down; with none, a player in a hit state loses both (a Pause owner
        // hit this tick keeps its own: it was not in H yet).
        const sp = pauseKind === 1;
        const pz = pauseKind === 0;
        if (sp) {
          if (p.superMoveTime > 0) p.superMoveTime--;
        } else if (pz) {
          if (p.pauseMoveTime > 0) p.pauseMoveTime--;
        } else if (p.moveType === 'h') p.superMoveTime = p.pauseMoveTime = 0;
      }
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
        const b = t.bind?.byTarget && t.bind.to === p ? t.bind : undefined;
        // bind_active: the entry's bind time before it counts down; what
        // Targets_Release tests (a target bound this tick drops to 5050).
        p.targetBindActive.set(t, b?.time ?? 0);
        if (!b || b.time === 0 || t.moveType !== 'h') continue;
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
    // Round_Tick steps the EnvShake here: one a hit sets starts on the next tick.
    this.tickEnvShake();
    // Projectiles_Update (before Players_CheckHits) runs for each player that ran this tick (run[i],
    // decided before the updates): a Pause started during the tick does not
    // stop its owner's projectiles until the next one.
    for (const pr of this.projectiles) if (active.includes(pr.owner)) updateProjectile(pr);
    // AfterImage_Update (round.c) runs before Players_CheckHits: on the tick a
    // hit lands its clock still counts, so with time 2 the frames recorded
    // during the hit pause are blank (measured: no bright stack of paused
    // copies after a rush's hits).
    for (const p of active) recordAfterImage(p.afterImage, p.drawFrame(), p.hitPause === 0);
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
      for (const p of hitters) {
        p.guardDistCleared = false;
        if (p.nohitTime > 0) p.nohitTime--;
        p.hitdefJuggle = 0;
      }
      applyHits(detectHits(hitters), hitters, this.frames);
      // HitDefs against projectiles (hitflag P).
      hitProjectilesByHitDefs(this.projectiles, hitters);
    }
    if (hitsOn) {
      // Projectiles_HitPlayer runs for every pair of the hit list, paused
      // players included (Kisarah, frozen by a SuperPause's last tick).
      applyHits(detectProjectileHits(this.projectiles, this.allPlayers().filter((p) => !p.destroyed)));
      applyProjectileHits(this.projectiles);
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
    // Ai_UpdateLearn's tick: the player ran this tick (player_tick), was not
    // in hit pause and no pause ran (pause_kind), all as the tick began: a
    // pause ending during the tick still holds the clock.
    for (const p of [...this.players].reverse()) p.recorder?.tick(active.includes(p) && !p.hitPauseLastTick && !pausedAtStart);
    this.updateCamera();
    this.updateZoom();
    for (const p of active) p.advance();
    // Round_Tick runs Player_UpdateCombo for every player, paused or not.
    for (const p of this.allPlayers()) p.pruneTargets();
    // A frozen player hit or hitting this tick (hitpause_next) is in hit
    // pause from its next update on: nothing of this tick is left to run.
    for (const p of this.allPlayers()) if (!active.includes(p)) p.hitPauseFresh = false;
    for (const p of this.allPlayers()) {
      for (const e of p.events) this.sounds.push(e);
      p.events.length = 0;
    }
    if (this.helperSlots.some((h) => h?.destroyed)) {
      this.helperSlots = this.helperSlots.map((h) => (h && !h.destroyed ? h : null));
      this.helpers = this.helperSlots.filter((x): x is Player => !!x);
    }
    this.updateExplods();
    this.tickPauses();
    // Game_Tick ends with the envcolor_time countdown: time = n shows n frames.
    if (this.envColor && this.envColor.time > 0 && --this.envColor.time === 0) this.envColor = undefined;
    this.gameTime++;
    if (!this.framesDriven) this.frames++;
  }

  /** Vertical camera shift of the EnvShake, in whole stage units (GameVars.camera_y_base). */
  shakeBase = 0;
  /** Camera_UpdateCrop: stage rows cut at the top / bottom of a screen of another height (crop_top / crop_bottom). */
  cropTop = 0;
  cropBottom = 0;

  /**
   * Camera_UpdateCrop for a screen screenHeight stage units high: the stage
   * height (localcoord) that does not fit is cut at the top and the bottom
   * (cuthigh / cutlow), or the stage is centred with overdrawlow when it is
   * smaller. cutlow defaults to -1, which cuts one row more at the top.
   */
  updateCrop(stageHeight: number, cutHigh: number, cutLow: number, overdrawLow: number): void {
    const d = stageHeight - this.screenHeight;
    let top: number;
    let bottom: number;
    if (d < 0) {
      top = Math.trunc(d / 2);
      bottom = d - top;
      if (-bottom > overdrawLow) {
        bottom = -overdrawLow;
        top = d - bottom;
      }
    } else {
      const sum = cutHigh + cutLow;
      top = sum > 0 ? Math.trunc((cutHigh * d) / sum) : d;
      bottom = d - top;
      if (bottom > cutLow) {
        bottom = cutLow;
        top = d - bottom;
      }
    }
    this.cropTop = top;
    this.cropBottom = bottom;
  }

  /**
   * Round_Tick's EnvShake: sin((freq * elapsed + phase) degrees) * ampl,
   * in stage units rounded to whole ones, shifts the camera (everything in
   * the stage, backgrounds included); it ends at time.
   */
  private tickEnvShake(): void {
    const s = this.envShake;
    if (!s || s.time <= 0) return;
    const k = this.gameWidth / this.screenWidth;
    const v = Math.sin(((Math.fround(s.freq) * s.elapsed + s.phase) * Math.PI) / 180);
    this.shakeBase = Math.floor(Math.fround(v * (s.ampl / k)) + 0.5);
    s.elapsed++;
    if (s.elapsed === s.time) {
      s.time = 0;
      this.shakeBase = 0;
    }
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
          // It was set on an earlier tick: Game_Tick counts it from the next one on.
          this.pause = { ...this.queuedPause, fresh: false };
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
      if (!e.ignoreHitPause && e.owner.paused) return true;
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
      // At the player's draw position, whole screen pixels (internal units), in sprite layer 10.
      const k = this.internalUnit;
      const left = this.camera.x - this.screenWidth / 2;
      const top = this.groundY - this.camera.y - this.shakeBase - this.cropTop;
      const x = Math.trunc((p.clsnX - left) * k + dx) / k + left;
      const y = Math.trunc((top + p.clsnY) * k + dy) / k - top;
      const e = simpleExplod(p, anim, true, x, y, 10, 1);
      e.id = 0;
      e.system = true;
      this.explods.push(e);
    }
  }

  /** Internal units per world unit. */
  private get internalUnit(): number {
    return this.gameWidth / this.screenWidth;
  }

  /** PS_RoundWidth of a size constant of `p`, in internal units. */
  private sparkEdge(p: Player, front: boolean): number {
    const name = p.stateType === 'a' ? (front ? 'size.air.front' : 'size.air.back') : front ? 'size.ground.front' : 'size.ground.back';
    return Math.trunc(Math.floor(Math.fround(this.internalUnit * p.scale * p.const(name)) + 0.5));
  }

  /**
   * Player_SparkPos: sparkxy from the target's front edge (its back edge when
   * both face the same way), at the attacker's height, whichever way the
   * spark faces: the attacker's. Taken before the hit changes the target.
   */
  sparkPos(a: Player, d: Player, xy: readonly [number, number]): SparkPos {
    const k = this.internalUnit;
    const sx = xy[0] * a.localScale * k;
    const base = d.facing !== a.facing ? this.sparkEdge(d, true) + sx : -sx - this.sparkEdge(d, false);
    return {
      x: Math.trunc((Math.trunc(base) - (d.clsnX - d.wx) * k) * d.facing + d.wx * k) / k,
      y: Math.trunc(xy[1] * a.localScale * k - (a.clsnY - a.wy) * k + a.wy * k) / k,
      facing: a.facing,
    };
  }

  /** Projectile hit: sparkxy from the projectile, facing its way. */
  projSparkPos(owner: Player, pr: { x: number; y: number; facing: number }, xy: readonly [number, number]): SparkPos {
    const k = this.internalUnit;
    return {
      x: Math.trunc(xy[0] * owner.scale * k * pr.facing + pr.x * k) / k,
      y: Math.trunc(xy[1] * owner.scale * k + pr.y * k) / k,
      facing: pr.facing,
    };
  }

  /** Player_Reverse: both sparkxy from the reverser's edge, facing the attacker's way. */
  reversalSparkPos(r: Player, a: Player, rxy: readonly [number, number], axy: readonly [number, number]): SparkPos {
    const k = this.internalUnit;
    const ax = axy[0] * a.localScale * k;
    const bx = rxy[0] * r.localScale * k;
    const base = a.facing !== r.facing ? this.sparkEdge(r, true) + (bx + ax) : -ax - bx - this.sparkEdge(r, false);
    return {
      x: Math.trunc((Math.trunc(base) - (r.clsnX - r.wx) * k) * r.facing + r.wx * k) / k,
      y: Math.trunc(axy[1] * a.localScale * k + rxy[1] * r.localScale * k - (a.clsnY - a.wy) * k + a.wy * k) / k,
      facing: a.facing,
    };
  }

  /** Spark_Create: id 0, no owner, on top of everything; it plays through pauses. */
  spawnSpark(owner: Player, ref: SparkRef, at: SparkPos): void {
    const anims = ref.own ? owner.prog.data.anims : this.fightFx?.anims;
    const anim = anims?.get(ref.action);
    if (!anim) return;
    const e = simpleExplod(owner, anim, !ref.own, at.x, at.y, 9, at.facing);
    e.id = 0;
    e.system = true;
    e.onTop = true;
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
    // Anim_SetAction: the same action keeps running (a second turn within
    // the turning action does not restart it).
    const want = p.stateType === 's' ? 5 : p.stateType === 'c' ? 6 : undefined;
    if (want !== undefined && p.hasAnim(want) && !(p.animNo === want && p.animProg === p.prog)) p.changeAnim(want);
  }



  /** Player push: players whose bodies overlap vertically are pushed apart. */
  private pushPlayers(): void {
    // Players_CheckHits: every active player slot (helpers included) in the hit list.
    const ps = this.allPlayers().filter((p) => !p.destroyed);
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]!;
        const b = ps[j]!;
        if (a.side === b.side || !a.pushEnabled || !b.pushEnabled) continue;
        // Push needs touching Clsn2 boxes first (mugen.exe 0x43de40), then the
        // size-based check below.
        if (!clsn2TouchInternal(a, b)) continue;
        // A standing player is not pushed by one more than its [Size] height
        // above it; crouching and airborne players skip this test
        // (mugen.exe 0x43df60).
        const above = (p: Player, q: Player) => p.stateType === 's' && p.wy - q.wy > p.const('size.height') * p.scale;
        if (!above(a, b) && !above(b, a)) this.pushApart(a, b);
        // Players_Push: both go back inside the stage and, with screenbound,
        // the screen right after each pair (the next pair sees them there).
        this.clampPlayer(a);
        this.clampPlayer(b);
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
    // The highest player with movecamera y (Camera_Update's top).
    let top: Player | undefined;
    for (const p of this.allPlayers()) if (!p.destroyed && p.moveCamera[1] && (!top || top.wy > p.wy)) top = p;
    const vfollow = this.verticalFollow;
    const oldTy = this.camYTarget;
    if (left && right && top) {
      // Vertical target (verticalfollow >= 0; the zoom variant is not ported).
      if (vfollow >= 0) this.camYTarget = f(vfollow * f(this.floorTension * k + top.wy * k));
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
    this.stepCameraY(oldTy);
    this.camera.x = f((e.l + e.r) * 0.5) / k;
    this.camTarget = ((e.lt + e.rt) * 0.5) / k;
  }

  /** Camera_Update's vertical target and offset (internal units, floats). */
  camYTarget = 0;
  camOffsetY = 0;

  /**
   * Camera_Update, vertical (verticalfollow >= 0): a target that jumps more
   * than 1 moves 15% of the way; the offset follows by 0.5 per 320 pixels,
   * faster (verticalfollow / 10 of the rest) when far; boundhigh / boundlow.
   */
  private stepCameraY(oldTy: number): void {
    const f = Math.fround;
    const k = this.gameWidth / this.screenWidth;
    const vfollow = this.verticalFollow;
    if (this.roundState !== 0 && vfollow >= 0 && f(Math.abs(this.camYTarget - oldTy)) > 1) this.camYTarget = f(oldTy * 0.85 + this.camYTarget * 0.15);
    const wf2 = f(Math.trunc(this.gameWidth));
    const hw = f((0.5 * wf2) / 320);
    const m = f((wf2 * 5) / 320);
    const cy = this.camOffsetY;
    const ty = this.camYTarget;
    if (vfollow >= 0) {
      if (ty > cy) {
        const n = f(hw + cy);
        this.camOffsetY = n;
        if (ty - m > n) this.camOffsetY = f(n + (vfollow * (ty - n)) / 10);
        if (this.camOffsetY >= ty - hw) this.camOffsetY = ty;
      } else if (ty < cy) {
        const n = f(cy - hw);
        this.camOffsetY = n;
        if (m + ty < n) this.camOffsetY = f(n - (vfollow * (n - ty)) / 10);
        if (this.camOffsetY <= ty + hw) this.camOffsetY = ty;
      }
    }
    const lo = f(this.boundLow * k);
    const hi = f(this.boundHigh * k);
    if (lo < this.camOffsetY) this.camOffsetY = lo;
    if (hi > this.camOffsetY) this.camOffsetY = hi;
    this.camera.y = this.camOffsetY / k;
  }

  /**
   * Horizontal: eased towards the tension/centering target (stepCameraX).
   * Vertical: follows the highest player above floortension (verticalfollow).
   */
  private updateCamera(): void {
    this.stepCameraX();
  }


  /** Camera_UpdateZoom (camera.c 0x4157b0), in internal units and float precision. */
  private updateZoom(): void {
    const f = Math.fround;
    const ce = this.camEdges ?? this.camInit();
    const v = this.zoomView;
    const z = this.zoom;
    if (!z) {
      Object.assign(v, { l: ce.l, r: ce.r, shakeX: 0, shakeY: 0, scale: 1, active: false });
      return;
    }
    const approach = (cur: number, target: number) => {
      // Math_Approach with step 0 and snap 1.
      const res = f(cur * z.lag + (1 - z.lag) * target);
      return Math.abs(target - res) < 1 ? target : res;
    };
    const w = f((ce.r - ce.l) / z.scale);
    const centre = f((ce.l + ce.r) * 0.5);
    let cx = f(z.scale * z.x + centre);
    let l = f(cx - w * 0.5);
    let r = f(cx + w * 0.5);
    if (ce.l > l) {
      r = f(ce.l - l + r);
      l = ce.l;
    }
    if (ce.r < r) {
      l = f(l - (r - ce.r));
      r = ce.r;
      if (ce.l > l) l = ce.l;
    }
    if (!v.active) {
      v.l = ce.l;
      v.r = ce.r;
    }
    v.l = approach(v.l, l);
    v.r = approach(v.r, r);
    cx = centre;
    v.shakeX = f((v.r + v.l) * 0.5 - cx);
    v.shakeY = approach(v.shakeY, z.y);
    v.scale = f((ce.r - ce.l) / (v.r - v.l));
    v.active = true;
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
    this.reflection = info.reflection;
    this.autoTurn = info.autoTurn;
  }
}

/**
 * Player_BodyDistX, in world units: from p's front edge to e's front edge
 * when p is in front of it, else (level included) to its back edge.
 */
/** Where a hit spark goes, in world units, and the way it faces. */
export interface SparkPos {
  x: number;
  y: number;
  facing: number;
}

/** A sound to start (PlaySnd and engine sounds) or a channel control. */
export type SoundCmd =
  | { kind?: 'play'; owner: Player | null; group: number; number: number; key?: string; lowPriority?: boolean; volume?: number; loop?: boolean; pan?: number }
  | { kind: 'stop'; key: string | undefined }
  | { kind: 'pan'; key: string; pan: number };

/**
 * Sound_Pan (sctrl.c): -127..127 from x, the internal-unit distance to the
 * camera centre; a dead zone of 40 (per 320) in the middle, full pan
 * panning width - 20 further out (PanningWidth 160 by default).
 */
export function soundPan(w: World, x: number, panningWidth = 160): number {
  let pos = Math.trunc((x * 320) / Math.trunc(w.gameWidth));
  pos = pos < -40 ? pos + 40 : pos > 40 ? pos - 40 : 0;
  const range = panningWidth - 20;
  if (range <= 0) return 0;
  const pan = Math.trunc((pos * 128) / range);
  return Math.max(-127, Math.min(127, pan));
}

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
