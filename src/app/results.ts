// The survival results screen (mugen.exe gameflow 15, result.c) and the
// arcade win screen (gameflow 16, versus.c WinScreen_*): the human side's
// players back on the last match's stage in a pose state (results: win 180
// or lose 170 by [Survival Results Screen] roundstowin; win screen: 180),
// the first at the camera's centre and a partner 50 units to the side, in
// their first default palette, with the stage's palette group at half
// (PalGroups_MulColor 0x80 every tick; measured) and the screen's text (winstext with the wins as %i, or wintext).
// It ends after show.time / pose.time ticks or with a button, fading out
// over fadeout.time.

import { IN_S } from '../engine/cmd';
import { Player, type CharacterProgram } from '../engine/player';
import { World, type FightFx } from '../engine/world';
import { ElementInstance, parseElement } from '../motif/element';
import { drawScene } from '../render/scene';
import { drawOverdrawBars, drawStageLayer } from '../render/stage-draw';
import { StageRuntime, type Stage } from '../stage/stage';
import { BUTTONS } from './input';
import type { AppContext, Screen } from './screen';
import { Fader } from './screen';

export interface ResultsSetup {
  /** The human side's characters (one, or two in simul / co-op) and palettes. */
  players: { prog: CharacterProgram; pal: number }[];
  stage: Stage;
  fightFx: FightFx;
  /** Matches the human side won (survival results). */
  wins: number;
  seed: number;
  /** 'win': the arcade win screen instead of the survival results. */
  kind?: 'results' | 'win';
}

export class SurvivalResultsScreen implements Screen {
  result: true | undefined;
  /** Gameflow states 15 and 16 stop the music. */
  bgm = null;
  private world = new World();
  private bg: StageRuntime;
  private fade: Fader;
  private t = 0;
  private showTime: number;
  private text: ElementInstance | undefined;
  private section: string;
  private textKey: string;

  constructor(
    private ctx: AppContext,
    private s: ResultsSetup,
  ) {
    const win = s.kind === 'win';
    this.section = win ? 'Win Screen' : 'Survival Results Screen';
    this.textKey = win ? 'wintext' : 'winstext';
    const v = (k: string) => ctx.motif.value(this.section, k);
    const num = (k: string, d: number) => {
      const n = parseInt(v(k) ?? '', 10);
      return Number.isFinite(n) ? n : d;
    };
    this.fade = new Fader(num('fadein.time', 10), num('fadeout.time', 10));
    this.showTime = num(win ? 'pose.time' : 'show.time', 300);
    const w = this.world;
    const [mw, mh] = ctx.motif.localCoord;
    w.applyStage(s.stage.info);
    w.screenWidth = s.stage.info.localCoord[0];
    w.screenHeight = Math.floor((mh * w.screenWidth) / mw + 0.5);
    w.updateCrop(s.stage.info.localCoord[1], s.stage.info.camera.cutHigh, s.stage.info.camera.cutLow, s.stage.info.camera.overdrawLow);
    w.fightFx = s.fightFx;
    w.seed = s.seed;
    w.roundState = 0;
    const state = win || s.wins >= num('roundstowin', 5) ? 180 : 170;
    // Result_Init: the first player at the camera's centre; with a partner,
    // 50 (320-wide units) to each side, the partner facing the other way.
    const off = (50 * s.stage.info.localCoord[0]) / 320;
    const facing = s.stage.info.p1.facing;
    s.players.slice(0, 2).forEach((pp, i) => {
      const p = new Player(pp.prog, w, 0);
      p.palNo = pp.pal;
      w.players.push(p);
      const x = s.players.length > 1 ? (i === 0 ? -off * facing : off * facing) : 0;
      p.setWorldPos(w.camera.x + x, 0);
      p.facing = i === 0 ? facing : -facing;
      p.changeState(state);
    });
    this.bg = new StageRuntime(s.stage);
    const el = parseElement(ctx.motif.section(this.section), this.textKey);
    if (el) this.text = new ElementInstance(el, ctx.motif.assets);
  }

  tick(): void {
    this.fade.tick();
    if (this.fade.done) {
      this.result = true;
      return;
    }
    this.world.tick(this.world.players.map(() => 0));
    this.bg.tick();
    this.text?.tick();
    if (!this.fade.fadingOut && (this.t === this.showTime || this.ctx.keys.pads[0]!.pressed(BUTTONS | IN_S))) this.fade.fadeOut();
    this.t++;
  }

  draw(): void {
    const r = this.ctx.renderer;
    const w = this.world;
    const W = w.screenWidth;
    const H = w.screenHeight;
    r.setProjection(W, H);
    r.clear(0, 0, 0);
    drawScene(r, w, {
      background: () => {
        drawStageLayer(r, this.bg, w.camera, 0, W, H, -(w.shakeBase + w.cropTop));
        drawOverdrawBars(r, w, this.s.stage.info.camera.overdrawLow, this.s.stage.info.camera.overdrawHigh);
        // The stage's palette group at half (the players keep theirs).
        r.rect(0, 0, W, H, [0, 0, 0, 128]);
      },
      foreground: () => drawStageLayer(r, this.bg, w.camera, 1, W, H, -(w.shakeBase + w.cropTop)),
    });
    const [mw, mh] = this.ctx.motif.localCoord;
    r.setProjection(mw, mh);
    const fmt = (this.ctx.motif.value(this.section, `${this.textKey}.text`) ?? '').replace(/^"|"$/g, '');
    this.text?.draw(r, 0, 0, fmt.replace('%i', String(this.s.wins)));
    this.fade.draw(r, mw, mh);
  }
}
