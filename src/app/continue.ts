// Arcade continue screen (mugen.exe gameflow 13, 0x40efb0): a match scene on
// the stage where the player lost, the player alone in common1's 5500, with
// "Continue?" and Yes / No in the system font (font/f-6x9.def) at system.def
// [Continue Screen] pos (default 159,40 in GameWidth coordinates). The
// chosen option is drawn white, the other at half intensity; each text has a
// black shadow one pixel down and right. It waits for an answer.

import { Player, type CharacterProgram } from '../engine/player';
import { World, type FightFx } from '../engine/world';
import { BUTTONS } from './input';
import { IN_L, IN_R, IN_S } from '../engine/cmd';
import type { Font } from '../motif/font';
import { drawText } from '../motif/element';
import { drawScene } from '../render/scene';
import { drawStageLayer } from '../render/stage-draw';
import { StageRuntime, type Stage } from '../stage/stage';
import type { AppContext, Screen } from './screen';
import { Fader } from './screen';

export interface ContinueSetup {
  prog: CharacterProgram;
  pal: number;
  stage: Stage;
  fightFx: FightFx;
  font: Font | undefined;
  /** Match RNG seed (a session draw, like any match). */
  seed: number;
}

export class ContinueScreen implements Screen {
  /** true = continue, false = give up. */
  result: boolean | undefined;
  private world = new World();
  private bg: StageRuntime;
  private fade = new Fader(0, 10);
  private yes = true;
  private chosen: boolean | undefined;
  private pos: [number, number];

  constructor(
    private ctx: AppContext,
    private s: ContinueSetup,
  ) {
    const w = this.world;
    const [mw, mh] = ctx.motif.localCoord;
    w.applyStage(s.stage.info);
    w.screenHeight = s.stage.info.localCoord[1];
    w.screenWidth = Math.round(w.screenHeight * (mw / mh));
    w.fightFx = s.fightFx;
    w.seed = s.seed;
    w.roundState = 0;
    const p1 = new Player(s.prog, w, 0);
    p1.palNo = s.pal;
    w.players.push(p1);
    const info = s.stage.info;
    p1.setWorldPos(info.p1.x, info.p1.y);
    p1.facing = info.p1.facing;
    p1.changeState(5500);
    this.bg = new StageRuntime(s.stage);
    const v = (k: string) => ctx.motif.value('Continue Screen', k);
    const pos = (v('pos') ?? '159,40').split(',').map((x) => parseInt(x, 10));
    this.pos = [Number.isFinite(pos[0]) ? pos[0]! : 159, Number.isFinite(pos[1]) ? pos[1]! : 40];
  }

  tick(): void {
    this.fade.tick();
    if (this.fade.done) {
      this.result = this.chosen;
      return;
    }
    this.world.tick([0]);
    this.bg.tick();
    if (this.fade.fadingOut) return;
    const pad = this.ctx.keys.pads[0]!;
    if (pad.pressed(IN_L)) this.yes = true;
    else if (pad.pressed(IN_R)) this.yes = false;
    else if (pad.pressed(BUTTONS | IN_S)) {
      this.chosen = this.yes;
      this.fade.fadeOut();
    }
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
    // The stage shows darkened behind the question.
    r.setProjection(W, H);
    r.rect(0, 0, W, H, [0, 0, 0, 128]);
    const font = this.s.font;
    if (font) {
      // Text coordinates are in GameWidth space (640x480).
      r.setProjection(640, 480);
      const [x, y] = this.pos;
      const on: [number, number, number] = [255, 255, 255];
      const off: [number, number, number] = [128, 128, 128];
      const black: [number, number, number] = [0, 0, 0];
      drawText(r, font, 'Continue?', x + 1, y + 1, 0, 0, [1, 1], black);
      drawText(r, font, 'Continue?', x, y, 0, 0, [1, 1], on);
      drawText(r, font, 'Yes', x - 9, y + 21, 0, -1, [1, 1], black);
      drawText(r, font, 'Yes', x - 10, y + 20, 0, -1, [1, 1], this.yes ? on : off);
      drawText(r, font, 'No', x + 11, y + 21, 0, 1, [1, 1], black);
      drawText(r, font, 'No', x + 10, y + 20, 0, 1, [1, 1], this.yes ? off : on);
    }
    const [mw, mh] = this.ctx.motif.localCoord;
    r.setProjection(mw, mh);
    this.fade.draw(r, mw, mh);
  }
}
