// The game flow (mugen.exe's gameflow states): title, modes, matches, endings.
// Screens run one at a time: a step of the flow awaits its screen's result.

import type { CharacterProgram } from '../engine/player';
import { SessionRng } from '../engine/session-rng';
import type { Vfs } from '../engine/vfs';
import type { TeamMode } from '../engine/match';
import type { Motif } from '../motif/system';
import type { GameAssets, LoadProgress } from './assets';
import { ContinueScreen } from './continue';
import type { EngineHooks } from './engine';
import { FightScreen, type FightResult, type FightTeam } from './fight-screen';
import type { GameOptions } from './game-options';
import { VersusScreen, VictoryScreen } from './interstitial';
import { OptionsScreen } from './options';
import { SurvivalResultsScreen } from './results';
import type { AppContext, Screen } from './screen';
import { SelectScreen, type Pick, type RosterChar, type SelectResult, type TeamPick } from './select';
import { loadStoryboard, StoryboardScreen } from './storyboard';
import { TitleScreen, TITLE_ITEMS, type GameMode, type TitleChoice } from './title';

export interface FlowOptions {
  sessionSeed?: number;
  onProgress?: (p: LoadProgress | undefined) => void;
  onExit?: () => void;
}

export function createGameFlow(
  ctx: AppContext,
  vfs: Vfs,
  motif: Motif,
  gameOptions: GameOptions,
  assets: GameAssets,
  options: FlowOptions,
  hooks: () => EngineHooks | undefined,
) {
  const { ramps, roster, rosterChars, stages, hud, fightFx, commonSnd, systemFont, getOptionsFont, program, stage } = assets;
  let busy = false;

  /**
   * Player_GetAiLevel: the difficulty (4 in survival) moved along the mode's
   * AI ramp by the match index (arcade: matches before this one; survival:
   * the round), clamped to 1..8.
   */
  function rampedAiLevel(kind: 'arcade' | 'team' | 'survival', match: number): number {
    const r = ramps[kind];
    let level = kind === 'survival' ? 4 : ctx.aiLevel;
    if (match <= r.startMatch) level += r.startOffset;
    else if (match >= r.endMatch) level += r.endOffset;
    else if (r.startMatch < r.endMatch)
      level += Math.trunc(((r.endOffset - r.startOffset) * (match - r.startMatch)) / (r.endMatch - r.startMatch)) + r.startOffset;
    return Math.max(1, Math.min(8, level));
  }
  let screen: Screen = new TitleScreen(ctx);
  // MUGEN's session RNG: -sessionseed, else seeded from the clock.
  const session = new SessionRng(options.sessionSeed || (Date.now() % 2147483646) + 1);

  function randomOpponent(exclude?: RosterChar): Pick {
    const pool = rosterChars.filter((c) => c.data && c !== exclude);
    const all = pool.length ? pool : rosterChars.filter((c) => c.data);
    const c = all[Math.floor(Math.random() * all.length)]!;
    return { char: c, pal: 1 + Math.floor(Math.random() * 2) };
  }

  /** A side of a team fight: its mode, characters and who plays each (pad, or CPU). */
  interface TeamSide {
    mode: TeamMode;
    picks: Pick[];
    pads: (number | undefined)[];
  }

  /** [Options] Life, Team.1VS2Life, Team.LoseOnKO (as the options screen left them). */
  const teamOptions = () => ({ life: gameOptions.life, team1vs2Life: gameOptions.team1vs2Life, loseOnKo: gameOptions.teamLoseOnKo });

  /** Charsel_End: the select screen's "random" stage is a session draw over the stage list. */
  function pickStage(s: string | undefined): string | undefined {
    return s === 'random' ? stages[session.next() % stages.length]!.path : s;
  }

  /** survival: the reseed of each new round (the next opponent's draws, then the match seed). */
  async function teamFight(
    sides: [TeamSide, TeamSide],
    stagePath: string | undefined,
    survival?: () => number,
    aiLevel?: (member: number) => number,
  ): Promise<FightScreen> {
    const lead = sides[1].picks[0] ?? sides[0].picks[0]!;
    const sp = stagePath ?? vfs.resolve(lead.char.entry.stage ?? '') ?? stages[0]!.path;
    const teams = (await Promise.all(
      sides.map(async (t) => ({
        mode: t.mode,
        picks: t.picks,
        pads: t.pads,
        progs: await Promise.all(t.picks.map((pk) => program(pk.char))),
      })),
    )) as [FightTeam, FightTeam];
    return new FightScreen(ctx, {
      seed: session.matchSeed(),
      p1: sides[0].picks[0]!,
      p2: sides[1].picks[0]!,
      progs: [teams[0].progs[0]!, teams[1].progs[0]!],
      stage: await stage(sp),
      hud,
      fightFx,
      commonSnd,
      human: [sides[0].pads.some((x) => x !== undefined), sides[1].pads.some((x) => x !== undefined)],
      training: false,
      teams,
      options: teamOptions(),
      matchNo: nextMatchNo(),
      survival: survival ? { side: 0, reseed: survival } : undefined,
      aiLevel,
    });
  }

  /** The computer's team of a team match: `count` characters from the arcade order (its palettes as an arcade opponent's). */
  function cpuPicks(chars: RosterChar[]): Pick[] {
    return chars.map((c) => ({ char: c, pal: session.opponentPalette((i) => !!c.data?.palettes?.[i]) }));
  }

  /** Team arcade, team co-op and team versus / watch with teams. */
  async function runTeamMode(mode: GameMode, sel: SelectResult): Promise<void> {
    const [mine, theirs] = sel.teams!;
    // Pads: a human pick uses pad 0, the co-op partner pad 1 (TeamPick.ai false); P2's side in versus uses pad 1.
    const padsOf = (t: TeamPick, side: number) =>
      t.ai.slice(0, t.mode === 'single' ? 1 : t.count).map((ai, k) => (ai || mode === 'watch' ? undefined : side === 1 ? 1 : k));
    if (mode === 'teamversus' || mode === 'watch') {
      const sides: [TeamSide, TeamSide] = [
        { mode: mine.mode, picks: mine.picks, pads: padsOf(mine, 0) },
        { mode: theirs.mode, picks: theirs.picks, pads: padsOf(theirs, 1) },
      ];
      // Gameflow state 10: every mode but quick VS and the demo has a versus screen.
      await until(new VersusScreen(ctx, sides[0].picks[0]!, sides[1].picks[0]!, 1));
      const res = await until<FightResult>(await loading(() => teamFight(sides, pickStage(sel.stage))));
      await victory(res, [sides[0].picks[0], sides[1].picks[0]]);
      return;
    }
    if (mode === 'survival' || mode === 'survivalcoop') {
      // Charsel_End / Match_NextRound: a random computer team for every round
      // (Team_Randomize); its characters are loaded ahead, a list of them.
      // The session draws, as mugen.exe makes them: Team_Randomize at the end
      // of the select screen draws members 0 and 1 (each slot a character
      // and, with AI.RandomColor, a palette), Gameflow_PickStage a random
      // stage, then the match seed; every later round one more member, then
      // the match seed again. The later members are worked out ahead on a
      // copy of the RNG (their characters have to be loaded).
      const size = theirs.mode === 'simul' ? 2 : 1;
      const all = rosterChars.filter((c) => c.data);
      const slot = (rng: SessionRng): Pick => {
        const c = all[rng.next() % all.length]!;
        return { char: c, pal: rng.opponentPalette((i) => !!c.data?.palettes?.[i]) };
      };
      const picks = Array.from({ length: 2 * size }, () => slot(session));
      const sp = pickStage(sel.stage) ?? vfs.resolve(picks[0]!.char.entry.stage ?? '') ?? stages[0]!.path;
      const ahead = new SessionRng(session.seed);
      ahead.matchSeed();
      while (picks.length < 60 * size) {
        for (let k = 0; k < size; k++) picks.push(slot(ahead));
        ahead.matchSeed();
      }
      const opp: TeamSide = { mode: theirs.mode === 'simul' ? 'simul' : 'single', picks, pads: picks.map(() => undefined) };
      const human: TeamSide = { mode: mine.mode, picks: mine.picks, pads: padsOf(mine, 0) };
      // Gameflow 10: the versus screen with the first opponent.
      await until(new VersusScreen(ctx, human.picks[0]!, opp.picks[0]!, 1));
      const reseed = () => {
        for (let k = 0; k < size; k++) slot(session);
        return session.matchSeed();
      };
      // Player_GetAiLevel: each opponent by the round it starts in.
      const res = await until<FightResult>(
        await loading(() => teamFight([human, opp], sp, reseed, (member) => rampedAiLevel('survival', member + 1))),
      );
      if (res.winner === undefined) return;
      // Gameflow 15: the survival results ([Survival Results Screen] enabled).
      if ((motif.value('Survival Results Screen', 'enabled') ?? '1') !== '0') {
        const pks = human.picks.slice(0, human.mode === 'simul' ? 2 : 1);
        await until(
          await loading(async () => {
            const players = await Promise.all(
              pks.map(async (pk) => ({ prog: await program(pk.char), pal: pk.char.data?.def.palDefaults[0] ?? 1 })),
            );
            return new SurvivalResultsScreen(ctx, {
              players,
              stage: await stage(sp),
              fightFx,
              wins: res.wins?.[0] ?? 0,
              seed: session.matchSeed(),
            });
          }),
        );
      }
      return;
    }
    // Team arcade / co-op: the computer team takes its characters from the
    // arcade order, team_size at a time (Arcade_BuildOrder / Arcade_NextTeam).
    const size = theirs.mode === 'single' ? 1 : theirs.count;
    const pool = rosterChars.filter((c) => c.data).map((c) => ({ c, order: c.entry.order }));
    const maxMatches = size > 1 || theirs.mode !== 'single' ? roster.teamMaxMatches : roster.arcadeMaxMatches;
    const order = session.arcadeOrder(pool, maxMatches, size).map((x) => x.c);
    let human: TeamSide = { mode: mine.mode, picks: mine.picks, pads: padsOf(mine, 0) };
    for (let n = 0, match = 1; n + size <= order.length; n += size, match++) {
      const opp: TeamSide = { mode: theirs.mode, picks: cpuPicks(order.slice(n, n + size)), pads: new Array(size).fill(undefined) };
      // Gameflow state 9: before match 1 (again after continuing it), the
      // intro storyboard of the arcade side's first character.
      const lead = human.picks[0]?.char;
      if (match === 1) await storyboard(lead?.data?.def.arcade.intro, lead?.data?.dir ?? '');
      await until(new VersusScreen(ctx, human.picks[0]!, opp.picks[0]!, match));
      // Player_GetAiLevel: the team ramp against a simul / turns team, else the arcade one, by the matches before.
      const ramp = theirs.mode !== 'single' || size > 1 ? 'team' : 'arcade';
      const res = await until<{ winner: number | undefined; quote?: string }>(
        await loading(() => teamFight([human, opp], undefined, undefined, () => rampedAiLevel(ramp, match - 1))),
      );
      if (res.winner !== 0) {
        // Match_Run: an arcade loss goes to the continue screen (state 13), as
        // in arcade, with the team's first character; Yes picks the team again
        // and replays this match.
        if (res.winner === undefined) return;
        if ((motif.value('Continue Screen', 'enabled') ?? '1') === '0') {
          arcadeEnd = 'gameover';
          return;
        }
        const first = human.picks[0]!.char;
        const sp = vfs.resolve(opp.picks[0]!.char.entry.stage ?? '') ?? stages[0]!.path;
        const again = await until<boolean>(
          await loading(
            async () =>
              new ContinueScreen(ctx, {
                prog: await program(first),
                pal: first.data?.def.palDefaults[0] ?? 1,
                stage: await stage(sp),
                fightFx,
                font: systemFont,
                seed: session.matchSeed(),
              }),
          ),
        );
        if (!again) {
          arcadeEnd = 'gameover';
          return;
        }
        const re = await until<SelectResult>(new SelectScreen(ctx, mode, rosterChars, stages));
        if (re.cancelled || !re.teams) return;
        human = { mode: re.teams[0].mode, picks: re.teams[0].picks, pads: padsOf(re.teams[0], 0) };
        n -= size;
        match--;
        matchContinued = true;
        continue;
      }
      if (n + size < order.length && (motif.value('Victory Screen', 'enabled') ?? '1') !== '0') {
        await until(
          new VictoryScreen(
            ctx,
            human.picks[0]!,
            res.quote ?? (motif.value('Victory Screen', 'winquote.text') ?? 'Winner!').replace(/^"|"$/g, ''),
          ),
        );
      }
    }
    // After the last match: the ending of the arcade side's first character.
    const lastOpp = order[Math.floor((order.length - size) / size) * size];
    await arcadeEnding(human.picks.slice(0, human.mode === 'simul' ? 2 : 1), lastOpp ? vfs.resolve(lastOpp.entry.stage ?? '') : undefined);
  }

  /**
   * Match_Run after the last arcade match: the first character's ending
   * storyboard (state 18), else the win screen (16, [Win Screen]) and the
   * default ending (17, [Default Ending]); either way the end credits and the
   * intro follow (arcadeEnd).
   */
  async function arcadeEnding(picks: Pick[], stagePath: string | undefined): Promise<void> {
    const first = picks[0]?.char;
    arcadeEnd = 'ending';
    if (first?.data?.def.arcade.ending && vfs.resolve(first.data.def.arcade.ending, first.data.dir)) {
      await storyboard(first.data.def.arcade.ending, first.data.dir);
      return;
    }
    if ((motif.value('Win Screen', 'enabled') ?? '1') !== '0') {
      const sp = stagePath ?? stages[0]!.path;
      await until(
        await loading(async () => {
          const players = await Promise.all(
            picks.map(async (pk) => ({ prog: await program(pk.char), pal: pk.char.data?.def.palDefaults[0] ?? 1 })),
          );
          return new SurvivalResultsScreen(ctx, {
            players,
            stage: await stage(sp),
            fightFx,
            wins: 0,
            seed: session.matchSeed(),
            kind: 'win',
          });
        }),
      );
    }
    if ((motif.value('Default Ending', 'enabled') ?? '0') !== '0')
      await storyboard(motif.value('Default Ending', 'storyboard')?.trim() || undefined, 'data');
  }

  async function fight(
    mode: GameMode,
    p1: Pick,
    p2: Pick,
    stagePath: string | undefined,
    aiLevel?: () => number,
    demo?: { endTime: number; bars: boolean },
  ): Promise<FightScreen> {
    const sp = stagePath ?? vfs.resolve(p2.char.entry.stage ?? '') ?? stages[0]!.path;
    const progs: [CharacterProgram, CharacterProgram] = [await program(p1.char), await program(p2.char)];
    // Same character and palette on both sides: P2 takes the next palette.
    if (p1.char === p2.char && p1.pal === p2.pal) p2 = { ...p2, pal: (p2.pal % 6) + 1 };
    const matchSeed = session.matchSeed();
    return new FightScreen(ctx, {
      seed: matchSeed,
      p1,
      p2,
      progs,
      stage: await stage(sp),
      hud,
      fightFx,
      commonSnd,
      human: mode === 'versus' ? [true, true] : mode === 'watch' ? [false, false] : [true, false],
      training: mode === 'training',
      options: { life: gameOptions.life },
      matchNo: nextMatchNo(),
      aiLevel,
      demo,
    });
  }

  // GameVars.arcade_match: counts the matches of a mode, a continued one once.
  let arcadeMatch = 0;
  let matchContinued = false;
  function nextMatchNo(): number {
    if (!matchContinued) arcadeMatch++;
    matchContinued = false;
    return arcadeMatch;
  }

  /** Match_Run's default next step: gameflow 12, the victory screen (not when quit). */
  async function victory(res: FightResult, picks: [Pick | undefined, Pick | undefined]): Promise<void> {
    if (res.winner === undefined || (motif.value('Victory Screen', 'enabled') ?? '1') === '0') return;
    const quote = res.quote ?? (motif.value('Victory Screen', 'winquote.text') ?? 'Winner!').replace(/^"|"$/g, '');
    await until(new VictoryScreen(ctx, res.winner >= 0 ? picks[res.winner] : undefined, quote));
  }

  /** Play a storyboard file if it exists (errors are skipped). */
  async function storyboard(path: string | undefined, ...bases: string[]): Promise<void> {
    if (!path) return;
    const p = vfs.resolve(path, ...bases);
    if (!p) return;
    const sb = await loading(() => loadStoryboard(vfs, p)).catch(() => undefined);
    if (sb) await until(new StoryboardScreen(ctx, sb));
  }

  /** Run one mode to completion, returning to the title. */
  async function runMode(mode: GameMode): Promise<void> {
    arcadeMatch = 0;
    for (;;) {
      const sel = await until<SelectResult>(new SelectScreen(ctx, mode, rosterChars, stages));
      if (sel.cancelled) return;
      // Charsel_End: a "random" stage is drawn first of all the session draws.
      sel.stage = pickStage(sel.stage);
      const team = sel.teams && (mode !== 'watch' || sel.teams.some((t) => t.mode !== 'single'));
      if (team && mode !== 'arcade' && mode !== 'versus' && mode !== 'training') {
        await runTeamMode(mode, sel);
        // State 6 after a team versus, watch or survival match: back to the select screen.
        if (mode !== 'teamversus' && mode !== 'watch' && mode !== 'survival' && mode !== 'survivalcoop') return;
        continue;
      }
      if (mode === 'arcade') {
        const chosen = sel.p1.char;
        // 0x40a370: shuffled roster by order, the player's character included.
        const pool = rosterChars.filter((c) => c.data).map((c) => ({ c, order: c.entry.order }));
        const opponents = session.arcadeOrder(pool, roster.arcadeMaxMatches).map((x) => x.c);
        for (let n = 1; n <= opponents.length; n++) {
          const oc = opponents[n - 1]!;
          const opp: Pick = { char: oc, pal: session.opponentPalette((i) => !!oc.data?.palettes?.[i]) };
          // Gameflow state 9: the intro storyboard before match 1, again after
          // continuing it (arcade_match stays 1).
          if (n === 1) await storyboard(sel.p1.char.data?.def.arcade.intro, sel.p1.char.data?.dir ?? '');
          await until(new VersusScreen(ctx, sel.p1, opp, n));
          const res = await until<{ winner: number | undefined; quote?: string }>(
            await loading(() => fight(mode, sel.p1, opp, undefined, () => rampedAiLevel('arcade', n - 1))),
          );
          if (res.winner !== 0) {
            if (res.winner === undefined) return;
            if ((motif.value('Continue Screen', 'enabled') ?? '1') === '0') {
              arcadeEnd = 'gameover';
              return;
            }
            // Continue? Yes: pick a character again and replay this match. The
            // player shows in its first default palette (measured: KFM picked
            // with a, palette 4, continues in palette 1).
            const sp = vfs.resolve(opp.char.entry.stage ?? '') ?? stages[0]!.path;
            const again = await until<boolean>(
              await loading(
                async () =>
                  new ContinueScreen(ctx, {
                    prog: await program(sel.p1.char),
                    pal: sel.p1.char.data?.def.palDefaults[0] ?? 1,
                    stage: await stage(sp),
                    fightFx,
                    font: systemFont,
                    seed: session.matchSeed(),
                  }),
              ),
            );
            if (!again) {
              arcadeEnd = 'gameover';
              return;
            }
            const re = await until<SelectResult>(new SelectScreen(ctx, mode, rosterChars, stages));
            if (re.cancelled) return;
            sel.p1 = re.p1;
            n--;
            matchContinued = true;
            continue;
          }
          // Not after the last match (system.def [Victory Screen] notes).
          if (n < opponents.length && (motif.value('Victory Screen', 'enabled') ?? '1') !== '0') {
            await until(
              new VictoryScreen(
                ctx,
                sel.p1,
                res.quote ?? (motif.value('Victory Screen', 'winquote.text') ?? 'Winner!').replace(/^"|"$/g, ''),
              ),
            );
          }
        }
        const last = opponents[opponents.length - 1];
        await arcadeEnding([sel.p1], last ? vfs.resolve(last.entry.stage ?? '') : undefined);
        void chosen;
        return;
      }
      const p2 = sel.p2 ?? randomOpponent();
      // Gameflow state 10: versus, training and watch alike.
      await until(new VersusScreen(ctx, sel.p1, p2, 1));
      const res = await until<FightResult>(await loading(() => fight(mode, sel.p1, p2, pickStage(sel.stage))));
      await victory(res, [sel.p1, p2]);
    }
  }

  let resolver: ((v: unknown) => void) | undefined;
  function until<T>(s: Screen): Promise<T> {
    screen = s;
    return new Promise<T>((res) => (resolver = res as (v: unknown) => void));
  }
  async function loading<T>(f: () => Promise<T>): Promise<T> {
    busy = true;
    options.onProgress?.({ phase: 'loading' });
    try {
      return await f();
    } finally {
      busy = false;
      options.onProgress?.(undefined);
    }
  }

  async function mainLoop(): Promise<void> {
    let menuPos = 0;
    // Motif logo and intro storyboards play once at start-up.
    await storyboard(motif.logoStoryboard);
    await storyboard(motif.introStoryboard);
    let demoCycles = 0;
    for (;;) {
      const mode = await until<TitleChoice | 'demo'>(new TitleScreen(ctx, menuPos));
      if (mode === 'demo') {
        await runDemo();
        // Title_Init: back on Arcade after a demo; Demo_TickFight: after
        // intro.waitcycles demos the intro storyboard plays again.
        menuPos = 0;
        const n = demoCycles++;
        if (n >= (parseInt(motif.value('Demo Mode', 'intro.waitcycles') ?? '1', 10) || 0)) {
          demoCycles = 0;
          await storyboard(motif.introStoryboard);
        }
        continue;
      }
      // Title_End: the chosen item stays the cursor's (GameVars.game_mode).
      menuPos = TITLE_ITEMS.findIndex((i) => i.key === mode);
      if (mode === 'exit') {
        // Title_Run: GAMEFLOW_EXIT quits mugen.exe: the host decides what follows.
        if (!options.onExit) continue;
        options.onExit();
        return;
      }
      if (mode === 'options') {
        // Gameflow state 5: Options_Run, then the title again.
        const font = await loading(getOptionsFont);
        if (font) await until(new OptionsScreen(ctx, font, gameOptions));
        continue;
      }
      arcadeEnd = undefined;
      await runMode(mode);
      // Gameflow 14 (game over: [Game Over Screen] storyboard) or 19 (after
      // the ending: [End Credits] storyboard), then state 3: the intro
      // storyboard plays again (intro_played = 0) before the title.
      if (arcadeEnd) {
        const sec = arcadeEnd === 'gameover' ? 'Game Over Screen' : 'End Credits';
        if ((motif.value(sec, 'enabled') ?? '0') !== '0') await storyboard(motif.value(sec, 'storyboard')?.trim() || undefined, 'data');
        await storyboard(motif.introStoryboard);
      }
    }
  }

  /** How the last arcade run ended: a game over (gameflow 14) or its ending (18 / 16). */
  let arcadeEnd: 'gameover' | 'ending' | undefined;

  /**
   * A demo fight (Demo_SetupTeams, Gameflow_PickStage): a random character
   * with a random palette (of 12) on each side and a random stage, all from
   * the session RNG, computer against computer.
   */
  async function runDemo(): Promise<void> {
    const all = rosterChars.filter((c) => c.data);
    if (!all.length) return;
    const pick = (): Pick => {
      const c = all[session.next() % all.length]!;
      return { char: c, pal: (session.next() % 12) + 1 };
    };
    const p1 = pick();
    const p2 = pick();
    const sp = stages[session.next() % stages.length]!.path;
    const v = (k: string, d: number) => {
      const n = parseInt(motif.value('Demo Mode', k) ?? '', 10);
      return Number.isFinite(n) ? n : d;
    };
    await until(
      await loading(() =>
        fight('watch', p1, p2, sp, undefined, { endTime: v('fight.endtime', 1500), bars: v('fight.bars.display', 0) !== 0 }),
      ),
    );
  }

  function stepOnce(): void {
    if (busy) return;
    ctx.keys.poll();
    hooks()?.before?.(screen);
    screen.tick();
    ctx.frames = (ctx.frames ?? 0) + 1;
    hooks()?.after?.(screen);
    if (screen.result !== undefined && resolver) {
      const r = resolver;
      resolver = undefined;
      const v = screen.result;
      screen.result = undefined;
      r(v);
    }
  }

  return {
    run: mainLoop,
    step: stepOnce,
    get screen() {
      return screen;
    },
    get busy() {
      return busy;
    },
  };
}
