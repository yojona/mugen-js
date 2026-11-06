// Title screen: [Title Info] menu over the TitleBG background.

import type { BgmInfo } from '../audio/music';
import { IN_D, IN_S, IN_U } from '../engine/cmd';
import { ElementInstance, parseElement, drawText } from '../motif/element';
import { BUTTONS } from './input';
import { fader, MotifBackground, motifSound, type AppContext, type Screen, motifBgm } from './screen';

export type GameMode = 'arcade' | 'versus' | 'teamarcade' | 'teamversus' | 'teamcoop' | 'survival' | 'survivalcoop' | 'training' | 'watch';
/** An item of the title menu: a mode, or the options screen / exit (Title_Run: GAMEFLOW_OPTIONS, GAMEFLOW_EXIT). */
export type TitleChoice = GameMode | 'options' | 'exit';

/**
 * Menu items in MUGEN's order (motif.c title_item_keys) with the names used
 * when [Title Info] has no menu.itemname.<key> (title_item_defaults).
 */
export const TITLE_ITEMS: { key: TitleChoice; name: string }[] = [
  { key: 'arcade', name: 'Arcade' },
  { key: 'versus', name: 'VS Mode' },
  { key: 'teamarcade', name: 'Team Arcade' },
  { key: 'teamversus', name: 'Team Versus' },
  { key: 'teamcoop', name: 'Team Co-op' },
  { key: 'survival', name: 'Survival' },
  { key: 'survivalcoop', name: 'Survival Co-op' },
  { key: 'training', name: 'Training' },
  { key: 'watch', name: 'Watch' },
  { key: 'options', name: 'Options' },
  { key: 'exit', name: 'Exit' },
];

export class TitleScreen implements Screen {
  /** A mode, or 'demo' after [Demo Mode] title.waittime idle ticks. */
  result: TitleChoice | 'demo' | undefined;
  bgm: BgmInfo | null;
  private bg: MotifBackground;
  private fade;
  private items: { name: string; mode: TitleChoice }[];
  private cursor = 0;
  private scroll = 0;
  private chosen: TitleChoice | 'demo' | undefined;
  /** ScreenLoop.idle_ticks: ticks without a key. */
  private idle = 0;

  constructor(
    private ctx: AppContext,
    start = 0,
  ) {
    this.bgm = motifBgm(ctx, 'title.bgm');
    this.bg = new MotifBackground(ctx, 'title');
    this.fade = fader(ctx, 'Title Info');
    this.items = TITLE_ITEMS.map((i) => ({ name: this.v(`menu.itemname.${i.key}`)?.replace(/^"|"$/g, '') ?? i.name, mode: i.key })).filter(
      (i) => i.name !== '',
    );
    this.cursor = Math.min(start, this.items.length - 1);
  }

  private v(k: string): string | undefined {
    return this.ctx.motif.value('Title Info', k);
  }

  tick(): void {
    this.bg.tick();
    this.fade.tick();
    if (this.fade.done && this.chosen) this.result = this.chosen;
    if (this.fade.fadingOut) {
      // Title_Update: escape skips the fade out.
      if (this.ctx.keys.escape && this.chosen) this.result = this.chosen;
      return;
    }
    // Title_Update: escape chooses EXIT (Title_Run returns GAMEFLOW_EXIT).
    if (this.ctx.keys.escape) {
      this.chosen = 'exit';
      this.fade.fadeOut();
      return;
    }
    const pad = this.ctx.keys.pads[0]!;
    const n = this.items.length;
    // Title_Update: idle past [Demo Mode] title.waittime starts a demo fight.
    // (Our screens act on a key the tick it is pressed, mugen.exe on the
    // next one, and their fades run a tick longer to match; the demo, with
    // no key, starts a tick sooner to land on mugen.exe's frame.)
    if (this.ctx.keys.pressed.length > 0) this.idle = 0;
    else this.idle++;
    const demo = this.ctx.motif.value('Demo Mode', 'enabled') ?? '1';
    const wait = parseInt(this.ctx.motif.value('Demo Mode', 'title.waittime') ?? '600', 10);
    if (demo !== '0' && Number.isFinite(wait) && this.idle >= wait - 1) {
      this.chosen = 'demo';
      this.fade.fadeOut();
      return;
    }
    if (pad.pressed(IN_D)) {
      this.cursor = (this.cursor + 1) % n;
      motifSound(this.ctx, this.v('cursor.move.snd'));
    } else if (pad.pressed(IN_U)) {
      this.cursor = (this.cursor - 1 + n) % n;
      motifSound(this.ctx, this.v('cursor.move.snd'));
    } else if (pad.pressed(BUTTONS | IN_S)) {
      motifSound(this.ctx, this.v('cursor.done.snd'));
      this.chosen = this.items[this.cursor]!.mode;
      this.fade.fadeOut();
    }
    const visible = parseInt(this.v('menu.window.visibleitems') ?? '5', 10) || 5;
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + visible) this.scroll = this.cursor - visible + 1;
  }

  draw(): void {
    const r = this.ctx.renderer;
    const [w, h] = this.ctx.motif.localCoord;
    r.setProjection(w, h);
    this.bg.drawBack();
    const sec = this.ctx.motif.section('Title Info');
    const pos = (this.v('menu.pos') ?? '159,158').split(',').map(Number);
    const spacing = (this.v('menu.item.spacing') ?? '0,13').split(',').map(Number);
    const visible = parseInt(this.v('menu.window.visibleitems') ?? '5', 10) || 5;
    const item = parseElement(sec, 'menu.item');
    const active = parseElement(sec, 'menu.item.active');
    const boxOn = (this.v('menu.boxcursor.visible') ?? '1') !== '0';
    const box = (this.v('menu.boxcursor.coords') ?? '-58,-10,57,2').split(',').map(Number);
    for (let i = this.scroll; i < Math.min(this.items.length, this.scroll + visible); i++) {
      const x = (pos[0] ?? 0) + (spacing[0] ?? 0) * (i - this.scroll);
      const y = (pos[1] ?? 0) + (spacing[1] ?? 0) * (i - this.scroll);
      if (i === this.cursor && boxOn) {
        // Pulsing translucent box behind the active item.
        const a = 60 + Math.round(30 * Math.sin(performance.now() / 150));
        r.rect(x + box[0]!, y + box[1]!, x + box[2]! + 1, y + box[3]! + 1, [255, 255, 255, a]);
      }
      const d = i === this.cursor ? (active ?? item) : item;
      if (d?.font) {
        const font = this.ctx.motif.fonts[d.font[0]];
        if (font) drawText(r, font, this.items[i]!.name, x, y, d.font[1], d.font[2], d.scale, d.fontColor);
      }
    }
    this.bg.drawFront();
    this.fade.draw(r, w, h);
  }
}

export { ElementInstance };
