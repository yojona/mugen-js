// Fight screen: stage + players + Match + fight.def HUD inside the app.
//
// Coordinate spaces (MUGEN 1.1): the world is drawn at the stage's height,
// widened to the display aspect (a 4:3 stage shows more width on 16:9); the
// HUD is drawn in the motif's (fight.def's) coordinate space.

import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_U, IN_X, IN_Y, IN_Z } from '../engine/cmd';
import { Match } from '../engine/match';
import { Player, type CharacterProgram } from '../engine/player';
import { World, type FightFx } from '../engine/world';
import type { FightHud } from '../motif/fight';
import { drawScene } from '../render/scene';
import { drawStageLayer } from '../render/stage-draw';
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
}

export interface FightResult {
  /** 0 or 1 = winning side, -1 = draw, undefined = quit. */
  winner: number | undefined;
}

export class FightScreen implements Screen {
  result: FightResult | undefined;
  readonly world = new World();
  readonly match: Match;
  private bg: StageRuntime;
  private ai: SimpleAI[];
  private fade = new Fader(10, 10);
  private idle = [0, 0];

  constructor(
    private ctx: AppContext,
    private s: FightSetup,
  ) {
    const w = this.world;
    const [mw, mh] = ctx.motif.localCoord;
    w.applyStage(s.stage.info);
    w.screenHeight = s.stage.info.localCoord[1];
    w.screenWidth = Math.round(w.screenHeight * (mw / mh));
    w.fightFx = s.fightFx;
    const p1 = new Player(s.progs[0], w, 0);
    const p2 = new Player(s.progs[1], w, 1);
    p1.palNo = s.p1.pal;
    p2.palNo = s.p2.pal;
    w.players.push(p1, p2);
    const info = s.stage.info;
    const cfg = s.hud.roundConfig();
    if (s.training) cfg.roundSeconds = -1;
    this.match = new Match(w, cfg, [
      { x: info.p1.x, y: info.p1.y, facing: info.p1.facing },
      { x: info.p2.x, y: info.p2.y, facing: info.p2.facing },
    ]);
    this.match.autoRematch = false;
    this.bg = new StageRuntime(s.stage);
    this.ai = [new SimpleAI(p1), new SimpleAI(p2)];
  }

  tick(): void {
    this.fade.tick();
    if (this.fade.done) {
      this.result = this.pendingResult;
      return;
    }
    if (this.fade.fadingOut) return;
    if (this.ctx.keys.escape) {
      this.pendingResult = { winner: undefined };
      this.fade.fadeOut();
      return;
    }
    const m = this.match;
    const w = this.world;
    const inputs = w.players.map((p, i) => (this.s.human[i] ? this.ctx.keys.pads[i === 1 && !this.s.human[0] ? 0 : i]!.bits : this.s.training ? 0 : this.ai[i]!.think()));
    if (m.tick()) {
      w.tick(inputs);
      if (!w.superPause && !w.pause) this.bg.tick();
    }
    this.s.hud.tick(m);
    for (const [g, n] of m.sounds) this.ctx.mixer.play(this.s.hud.snd?.get(g, n));
    for (const snd of w.sounds) this.ctx.mixer.play((snd.owner ? snd.owner.prog.data.snd : this.s.commonSnd)?.get(snd.group, snd.number));
    w.sounds.length = 0;
    if (this.s.training) this.refillLife();
    if (m.finished && !this.fade.fadingOut) {
      this.pendingResult = { winner: m.winner ? m.winner.side : -1 };
      this.fade.fadeOut();
    }
  }
  private pendingResult: FightResult | undefined;

  /** Training mode: life refills once a combo is over. */
  private refillLife(): void {
    this.world.players.forEach((p, i) => {
      this.idle[i] = p.moveType === 'h' ? 0 : this.idle[i]! + 1;
      if (this.idle[i] === 60) p.life = p.const('data.life');
      p.power = p.const('data.power');
    });
  }

  draw(): void {
    const r = this.ctx.renderer;
    const w = this.world;
    const W = w.screenWidth;
    const H = w.screenHeight;
    r.setProjection(W, H);
    r.clear(0, 0, 0);
    drawScene(r, w, {
      background: () => drawStageLayer(r, this.bg, w.camera, 0, W, H),
      foreground: () => drawStageLayer(r, this.bg, w.camera, 1, W, H),
    });
    const [mw, mh] = this.ctx.motif.localCoord;
    r.setProjection(mw, mh);
    this.s.hud.draw(r, this.match);
    this.fade.draw(r, mw, mh);
  }
}

/**
 * Placeholder CPU: walks in, attacks at close range, jumps now and then and
 * guards when attacked. MUGEN's own AI (AILevel) is not reproduced yet.
 */
export class SimpleAI {
  // Own generator, so the placeholder AI does not consume MUGEN's sequence.
  private seed = 12345;
  private rnd(n: number): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed % n;
  }
  private plan = 0;
  private hold = 0;
  constructor(private p: Player) {}

  think(): number {
    const p = this.p;
    const e = p.world.enemyOf(p);
    if (!e || p.world.roundState !== 2) return 0;
    const towards = e.pos.x > p.pos.x ? IN_R : IN_L;
    const away = towards === IN_R ? IN_L : IN_R;
    const dist = Math.abs(e.pos.x - p.pos.x);
    if (e.moveType === 'a' && dist < 90 && this.rnd(100) < 70) return away;
    if (this.hold > 0) {
      this.hold--;
      return this.plan;
    }
    const roll = this.rnd(100);
    const buttons = [IN_X, IN_Y, IN_Z, IN_A, IN_B, IN_C];
    if (dist > 60) {
      this.plan = roll < 8 ? towards | IN_U : towards;
      this.hold = 8 + this.rnd(12);
    } else if (roll < 35) {
      this.plan = buttons[this.rnd(buttons.length)]!;
      this.hold = 1;
    } else if (roll < 45) {
      this.plan = IN_D | buttons[this.rnd(buttons.length)]!;
      this.hold = 2;
    } else if (roll < 55) {
      this.plan = away;
      this.hold = 10;
    } else {
      this.plan = 0;
      this.hold = 6;
    }
    return this.plan;
  }
}
