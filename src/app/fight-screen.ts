// Fight screen: stage + players + Match + fight.def HUD inside the app.
//
// Coordinate spaces (MUGEN 1.1): the world is drawn at the stage's height,
// widened to the display aspect (a 4:3 stage shows more width on 16:9); the
// HUD is drawn in the motif's (fight.def's) coordinate space.

import { MugenAI, type DummySettings } from '../engine/ai';
import { Match, type TeamMode, type TeamPlan } from '../engine/match';
import { pickVictoryQuote, Player, type CharacterProgram } from '../engine/player';
import { World, type FightFx } from '../engine/world';
import type { FightHud } from '../motif/fight';
import type { Renderer } from '../render/renderer';
import { DARKEN_BG, drawScene } from '../render/scene';
import { drawOverdrawBars, drawStageLayer } from '../render/stage-draw';
import { StageRuntime, type Stage } from '../stage/stage';
import type { Snd } from '../formats/snd';
import type { AppContext, Screen } from './screen';
import { Fader } from './screen';
import type { Pick } from './select';

export interface FightSetup {
  p1: Pick;
  p2: Pick;
  progs: [CharacterProgram, CharacterProgram];
  stage: Stage;
  hud: FightHud;
  fightFx: FightFx;
  commonSnd: Snd | undefined;
  /** Which sides are human-controlled. */
  human: [boolean, boolean];
  training: boolean;
  /** Match RNG seed (mugen.exe 0x425540, from the session RNG). */
  seed?: number;
  /** Team modes: each side's mode, characters (programs and picks, in order) and who plays them. */
  teams?: [FightTeam, FightTeam];
  /** [Options] Life, Team.1VS2Life, Team.LoseOnKO. */
  options?: { life?: number; team1vs2Life?: number; loseOnKo?: boolean };
  /** Survival: the human side (its opponents come one after the other from their team's list) and the per-round seeds. */
  survival?: { side: number; reseed: () => number };
  /**
   * Player_GetAiLevel for each computer player as it is created: by the
   * team member (survival: the opponents fought before), else the difficulty.
   */
  aiLevel?: (member: number) => number;
  /**
   * Demo fight ([Demo Mode]): no time limit, full power each round, the HUD
   * bars hidden unless bars; it ends endTime RoundState 2 ticks in (fading
   * over the last 120) or at any key (Demo_TickFight / Match_Update).
   */
  demo?: { endTime: number; bars: boolean };
}

export interface FightTeam {
  mode: TeamMode;
  /** Characters: simul 2, turns the order's length. */
  progs: CharacterProgram[];
  picks: Pick[];
  /** Per character: the human pad playing it, or undefined for the CPU. */
  pads: (number | undefined)[];
}

export interface FightResult {
  /** 0 or 1 = winning side, -1 = draw, undefined = quit. */
  winner: number | undefined;
  /** The winner's victory quote (VictoryQuote, else a random one). */
  quote?: string;
  /** Matches won by each side (survival: the rounds survived). */
  wins?: [number, number];
}

export class FightScreen implements Screen {
  result: FightResult | undefined;
  readonly world = new World();
  readonly match: Match;
  private bg: StageRuntime;
  /** The next screen follows 3 frames after the match ends (measured). */
  // The rounds fade in and out themselves (Match.fade); the screen only
  // covers an early exit.
  private fade = new Fader(0, 2);
  /** Training dummy settings, changed with keys 1-5. */
  private dummy: DummySettings = { stance: 0, guard: false, distance: 0, jumpDistance: 0, button: 0 };

  constructor(
    private ctx: AppContext,
    private s: FightSetup,
  ) {
    const w = this.world;
    const [mw, mh] = ctx.motif.localCoord;
    w.applyStage(s.stage.info);
    // The screen is the stage's localcoord wide (stage.unit); its height
    // follows the screen's shape, the rest of the stage cut (Camera_UpdateCrop).
    w.screenWidth = s.stage.info.localCoord[0];
    w.screenHeight = Math.floor((mh * w.screenWidth) / mw + 0.5);
    w.updateCrop(s.stage.info.localCoord[1], s.stage.info.camera.cutHigh, s.stage.info.camera.cutLow, s.stage.info.camera.overdrawLow);
    w.fightFx = s.fightFx;
    w.training = s.training;
    if (s.seed !== undefined) w.seed = s.seed;
    // The survival result screen continues the match's scene (Result_Setup
    // loads_match): it follows a frame sooner (measured: 212 frames after
    // RoundState 4, against 213 for the continue screen).
    if (s.survival) this.fade = new Fader(0, 1);
    const info = s.stage.info;
    const cfg = s.hud.roundConfig();
    // [Options] Time (Round_Reset: round_time from GameVars.time; -1 none).
    if (ctx.options) cfg.roundSeconds = ctx.options.time;
    if (s.training || s.demo) cfg.roundSeconds = -1;
    const starts = [info.p1, info.p2, info.p3, info.p4];
    if (s.teams) {
      // Team_CreatePlayers: each slot's character, palette and controller.
      const plans = s.teams.map((t, side): TeamPlan => ({
        mode: t.mode,
        count: t.progs.length,
        ai: t.pads.map((pad) => pad === undefined),
        faces: t.picks.map((pk) => ({ data: pk.char.data!, pal: pk.pal })),
        spawn: (member, k) => {
          // Survival opponents: `member` counts the teams fought; each is `slots` characters of the list.
          const slots = t.mode === 'simul' ? 2 : 1;
          const i = s.survival && s.survival.side !== side ? (member * slots + k) % t.progs.length : t.mode === 'simul' ? k : member;
          const p = new Player(t.progs[i]!, w, side);
          p.palNo = t.picks[i]!.pal;
          p.pad = t.pads[i];
          if (p.pad === undefined) p.ai = new MugenAI(p, s.aiLevel?.(member) ?? ctx.aiLevel);
          return p;
        },
      })) as [TeamPlan, TeamPlan];
      this.match = new Match(w, cfg, starts, { teams: plans, ...s.options, survivalSide: s.survival?.side, reseed: s.survival?.reseed });
    } else {
      const p1 = new Player(s.progs[0], w, 0);
      const p2 = new Player(s.progs[1], w, 1);
      p1.palNo = s.p1.pal;
      p2.palNo = s.p2.pal;
      w.players.push(p1, p2);
      this.match = new Match(w, cfg, starts, s.options);
      // CPU sides run MUGEN's own AI; in training it is MUGEN's dummy.
      [p1, p2].forEach((p, i) => {
        if (s.human[i]) {
          // One human playing P2 alone uses the first pad.
          p.pad = i === 1 && !s.human[0] ? 0 : i;
          return;
        }
        p.ai = new MugenAI(p, s.aiLevel?.(0) ?? ctx.aiLevel);
        if (s.training) p.ai.dummy = this.dummy;
      });
    }
    this.match.autoRematch = false;
    // GameVars.frames as the tick runs: the frames of every screen so far,
    // this one included (measured: the target order of a throw that can
    // catch both co-op players, odd and even frames).
    if (ctx.frames !== undefined) this.match.frameClock = () => (ctx.frames ?? 0) + 1;
    this.bg = new StageRuntime(s.stage);
    if (s.training) this.showDummy();
  }

  tick(): void {
    this.fade.tick();
    if (this.fade.done) {
      this.result = this.pendingResult;
      return;
    }
    if (this.fade.fadingOut) return;
    if (this.s.demo && this.ctx.keys.pressed.length > 0) {
      // Match_Update: any key ends the demo.
      this.pendingResult = { winner: undefined };
      this.fade.fadeOut();
      return;
    }
    if (this.ctx.keys.escape) {
      this.saveRecords();
      this.pendingResult = { winner: undefined };
      this.fade.fadeOut();
      return;
    }
    if (this.s.training) this.dummyKeys();
    const m = this.match;
    const w = this.world;
    const inputs = w.players.map((p) => (p.pad !== undefined ? (this.ctx.keys.pads[p.pad]?.bits ?? 0) : 0));
    const simulated = m.tick(inputs);
    if (this.s.demo) {
      // Round_Reset: full power for everyone in a demo fight.
      if (m.round !== this.demoRound) {
        this.demoRound = m.round;
        for (const p of w.players) if (!p.isHelper) p.power = p.powerbarPower = p.powerbarLevel = p.const('data.power');
      }
      if (w.roundState === 2) {
        const d = this.s.demo;
        if (this.demoTicks === d.endTime - 120) this.demoFade = 0;
        if (this.demoTicks >= d.endTime) {
          this.pendingResult = { winner: undefined };
          this.fade.fadeOut();
        }
        this.demoTicks++;
      }
      if (this.demoFade >= 0) this.demoFade++;
    }
    if (simulated) {
      w.tick(inputs);
      if (!w.superPause && !w.pause) this.bg.tick();
    }
    this.s.hud.tick(m, simulated);
    for (const [g, n] of m.sounds) this.ctx.mixer.play(this.s.hud.snd?.get(g, n));
    this.ctx.mixer.run(w.sounds, (owner, g, n) => (owner ? owner.prog.data.snd : this.s.commonSnd)?.get(g, n));
    w.sounds.length = 0;
    if (m.finished && !this.fade.fadingOut) {
      this.saveRecords();
      this.pendingResult = { winner: m.winner ? m.winner.side : -1, quote: m.winner ? pickVictoryQuote(m.winner) : undefined, wins: [...m.wins] };
      this.fade.fadeOut();
    }
  }
  private pendingResult: FightResult | undefined;
  /** Demo fight: RoundState 2 ticks run, the round power was last filled for, and the 120-tick fade out's progress (-1 none). */
  private demoTicks = 0;
  private demoRound = 0;
  private demoFade = -1;

  /** Keys 1-5 cycle the dummy's stance, guard, distance, back-off distance and button. */
  private dummyKeys(): void {
    const d = this.dummy;
    for (const code of this.ctx.keys.pressed) {
      let changed = true;
      if (code === 'Digit1') d.stance = (d.stance + 1) % 4;
      else if (code === 'Digit2') d.guard = !d.guard;
      else if (code === 'Digit3') d.distance = d.distance === 0 ? 50 : d.distance === 50 ? 150 : 0;
      else if (code === 'Digit4') d.jumpDistance = d.jumpDistance === 0 ? 50 : d.jumpDistance === 50 ? 150 : 0;
      else if (code === 'Digit5') d.button = (d.button + 1) % 8;
      else changed = false;
      if (changed) this.showDummy();
    }
  }

  private helpText: string | undefined;

  /** Put the normal key help back when the fight ends. */
  private restoreHelp(): void {
    const el = typeof document !== 'undefined' ? document.getElementById('help') : null;
    if (el && this.helpText !== undefined) el.textContent = this.helpText;
  }

  private showDummy(): void {
    const el = typeof document !== 'undefined' ? document.getElementById('help') : null;
    if (!el) return;
    this.helpText ??= el.textContent ?? '';
    const d = this.dummy;
    const stance = ['de pie', 'agachado', 'salta', 'salta seguido'][d.stance];
    const button = d.button ? 'abcxyzs'[d.button - 1] : 'ninguno';
    el.textContent = `Entrenamiento: 1 postura (${stance}) / 2 bloqueo (${d.guard ? 'sí' : 'no'}) / 3 distancia (${d.distance || 'libre'}) / 4 alejarse (${d.jumpDistance || 'no'}) / 5 botón (${button}) / Esc volver`;
  }

  /** The players leave: their AI move records stay with the characters. */
  private saveRecords(): void {
    this.restoreHelp();
    for (const p of this.world.players) p.recorder?.saveToCharacter();
  }

  draw(): void {
    const r = this.ctx.renderer;
    const w = this.world;
    const W = w.screenWidth;
    const H = w.screenHeight;
    r.setProjection(W, H);
    r.clear(0, 0, 0);
    // Zoom: everything in the stage scales by the stage scale around the
    // zoomed view (Player_UpdateDrawParams: (pos - cam - shake) * scale).
    const zv = w.zoomView;
    if (zv.active) {
      const k = w.gameWidth / w.screenWidth;
      const top = w.groundY - w.camera.y;
      r.view = { s: zv.scale, ox: (W / 2) * (1 - zv.scale) - (zv.shakeX / k) * zv.scale, oy: top * (1 - zv.scale) - (zv.shakeY / k) * zv.scale };
    }
    drawScene(r, w, {
      background: () => {
        drawStageLayer(r, this.bg, w.camera, 0, W, H, -(w.shakeBase + w.cropTop));
        drawOverdrawBars(r, w, this.s.stage.info.camera.overdrawLow, this.s.stage.info.camera.overdrawHigh);
      },
      foreground: () => drawStageLayer(r, this.bg, w.camera, 1, W, H, -(w.shakeBase + w.cropTop)),
    });
    r.view = { s: 1, ox: 0, oy: 0 };
    const [mw, mh] = this.ctx.motif.localCoord;
    r.setProjection(mw, mh);
    // The HUD's palette group (0x200) darkens with the stage in a SuperPause.
    r.tint = w.darkened ? DARKEN_BG : undefined;
    this.s.hud.draw(r, this.match, (!this.s.demo || this.s.demo.bars) && !w.globalFlag('nobardisplay'));
    r.tint = undefined;
    const a = this.match.fadeAlpha;
    if (a > 0) r.rect(0, 0, mw, mh, [0, 0, 0, Math.round(a * 255)]);
    const bars = this.match.fadeBars;
    if (bars !== undefined) drawFadeBars(r, mw, mh, bars);
    if (this.demoFade >= 0) r.rect(0, 0, mw, mh, [0, 0, 0, Math.round(Math.min(1, this.demoFade / 120) * 255)]);
    this.fade.draw(r, mw, mh);
  }
}

/**
 * Fade_DrawBars: black bars from the top and bottom edges, then 12 bands of
 * bar_size / 12 (bar_size = an eighth of the screen) that get lighter.
 */
function drawFadeBars(r: Renderer, w: number, h: number, progress: number): void {
  const size = Math.trunc(h / 8);
  let bar = Math.trunc((Math.trunc(h / 2) + size) * progress - size);
  if (bar > 0) {
    r.rect(0, 0, w, bar, [0, 0, 0, 255]);
    r.rect(0, h - bar, w, h, [0, 0, 0, 255]);
  }
  const step = Math.trunc(size / 12);
  for (let k = 0; k < 12; k++) {
    const next = bar + step;
    const alpha = Math.round(255 * (1 - k / 12));
    r.rect(0, bar, w, next, [0, 0, 0, alpha]);
    r.rect(0, h - next, w, h - bar, [0, 0, 0, alpha]);
    bar = next;
  }
}
