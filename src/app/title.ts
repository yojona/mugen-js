// Title screen: [Title Info] menu over the TitleBG background.

import type { BgmInfo } from '../audio/music';
import { IN_D, IN_S, IN_U } from '../engine/cmd';
import { ElementInstance, fontColor, parseElement, drawText } from '../motif/element';
import { textWidth, type Font } from '../motif/font';
import type { Renderer } from '../render/renderer';
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

const BOX_W = 600;
const BOX_H = 400;
const BOX_Y_HIDDEN = -405;
// mugen.h: MUGEN_VERSION_*.
const VERSION = '1.1.0 Beta 1 P1';
const INFO_TEXT = `This game is powered by M.U.G.E.N version ${VERSION} (2013.08.11)  (c) Elecbyte 1999-2013\n\nThis version of M.U.G.E.N is a development build, but free for non-commercial use only.\nPlease read the license in readme.txt before using this software.`;

type Rgba = [number, number, number, number];

export class TitleScreen implements Screen {
  /** A mode, or 'demo' after [Demo Mode] title.waittime idle ticks. */
  result: TitleChoice | 'demo' | undefined;
  bgm: BgmInfo | null;
  private bg: MotifBackground;
  private fade;
  private items: { name: string; mode: TitleChoice }[];
  private cursor = 0;
  /** TitleState.scroll, scroll_target: motif units. */
  private scroll = 0;
  private scrollTarget = 0;
  /** ScreenLoop.ticks. */
  private ticks = 0;
  /** The info box (F1): TitleState.box_*. */
  private boxMoving = false;
  private boxShown = false;
  private boxY = BOX_Y_HIDDEN;
  private boxProgress = 0;
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
    this.update();
    this.animate();
    this.ticks++;
  }

  /** Title_Update: the keys. */
  private update(): void {
    this.bg.tick();
    this.fade.tick();
    // Title_Update: F1 shows or hides the info box.
    if (this.ctx.keys.pressed.includes('F1')) {
      this.boxMoving = true;
      this.boxShown = !this.boxShown;
    }
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
  }

  /** Title_Tick: scrolls the menu and slides the info box. */
  private animate(): void {
    const spacing = this.spacingY;
    const last = (this.visible - 1) * spacing;
    for (let k = 0; k < 2; k++) {
      const rel = this.cursor * spacing - this.scrollTarget;
      if (rel > last) this.scrollTarget += spacing;
      if (rel < 0) this.scrollTarget -= spacing;
    }
    const target = this.scrollTarget;
    if (this.scroll < target) this.scroll += Math.trunc((target - this.scroll) / 5) + 1;
    else if (this.scroll > target) this.scroll += Math.trunc((target - this.scroll) / 5) - 1;
    if (Math.abs(target - this.scroll) <= 2 || this.ticks === 0) this.scroll = target;
    if (!this.boxMoving) return;
    const [, height] = this.targetSize();
    const shown = Math.trunc((height - this.boxSize()[1]) / 2);
    const to = this.boxShown ? shown : BOX_Y_HIDDEN;
    if (this.boxY !== to) {
      const dir = to > this.boxY ? 1 : -1;
      this.boxY += Math.trunc((to - this.boxY) / 12) + dir * 5;
      if ((to - this.boxY) * dir <= 0) {
        this.boxY = to;
        if (!this.boxShown) this.boxMoving = false;
      }
    }
    this.boxProgress = (this.boxY - BOX_Y_HIDDEN) / (shown - BOX_Y_HIDDEN);
  }

  private get visible(): number {
    return parseInt(this.v('menu.window.visibleitems') ?? '5', 10) || 5;
  }

  private get spacingY(): number {
    return (this.v('menu.item.spacing') ?? '0,13').split(',').map(Number)[1] ?? 13;
  }

  /** GameVars.motif_scale: output pixels per motif unit. */
  private get scale(): number {
    const r = this.ctx.renderer;
    return r.toDevice(1, 0)[0] - r.toDevice(0, 0)[0];
  }

  /**
   * The info box: 600x400 in mugen.exe, at any game size. Below 640x480 that leaves
   * its text off the screen, so here it shrinks to fit.
   */
  private boxSize(): [number, number] {
    const [width, height] = this.targetSize();
    return [Math.min(BOX_W, width - 8), Math.min(BOX_H, height - 8)];
  }

  /** g_targetWidth, g_targetHeight. */
  private targetSize(): [number, number] {
    const [w, h] = this.ctx.motif.localCoord;
    const k = Math.max(1, this.scale);
    return [Math.round(w * k), Math.round(h * k)];
  }

  draw(): void {
    const r = this.ctx.renderer;
    const [w, h] = this.ctx.motif.localCoord;
    r.setProjection(w, h);
    this.bg.drawBack();
    this.drawMenu();
    const [tw, th] = this.targetSize();
    r.setProjection(tw, th);
    if (this.boxMoving) this.drawInfoBox(tw, th);
    this.drawBar(tw, th);
    r.setProjection(w, h);
    this.bg.drawFront();
    this.fade.draw(r, w, h);
  }

  /** Title_Draw: the items, clipped to the menu's window; they slide out sideways while the info box shows. */
  private drawMenu(): void {
    const r = this.ctx.renderer;
    const k = this.scale;
    const sec = this.ctx.motif.section('Title Info');
    const [posX, posY] = (this.v('menu.pos') ?? '159,158').split(',').map(Number) as [number, number];
    const [marginTop, marginBottom] = (this.v('menu.window.margins.y') ?? '12,8').split(',').map(Number) as [number, number];
    const item = parseElement(sec, 'menu.item');
    const active = parseElement(sec, 'menu.item.active');
    const boxOn = (this.v('menu.boxcursor.visible') ?? '1') !== '0';
    const box = (this.v('menu.boxcursor.coords') ?? '-58,-10,57,2').split(',').map(Number) as [number, number, number, number];
    const spacing = this.spacingY;
    const [mw, mh] = this.ctx.motif.localCoord;
    const clipBottom = Math.trunc(((this.visible - 1) * spacing + marginBottom + posY) * k);
    r.setClipDevice(0, Math.trunc((posY - marginTop) * k), Math.round(mw * k), Math.min(clipBottom, Math.round(mh * k)));
    const [tw, th] = this.targetSize();
    this.items.forEach((entry, row) => {
      // The parity of the item in the full list says which side it leaves by.
      const away = (TITLE_ITEMS.findIndex((i) => i.key === entry.mode) & 1 ? 409 : -91) * (mw / 320);
      const x = Math.trunc(posX + (away - posX) * this.boxProgress);
      const y = spacing * row - this.scroll + posY;
      if (row === this.cursor && boxOn && this.fade.alpha === 0 && !this.fade.fadingOut && this.chosen !== 'demo') {
        // Title_Pulse: a triangle wave; added to what's below.
        const c = pulse(this.ticks * 2, 32, 16);
        r.setProjection(tw, th);
        r.rect(
          Math.trunc((box[0] + x) * k),
          Math.trunc((box[1] + y) * k),
          Math.trunc((box[2] + x) * k) + 1,
          Math.trunc((box[3] + y) * k) + 1,
          [c >> 1, c, c, 255],
          {
            kind: 'add',
            src: 256,
            dst: 256,
          },
        );
        r.setProjection(mw, mh);
      }
      const d = row === this.cursor ? (active ?? item) : item;
      if (d?.font) {
        const font = this.ctx.motif.fonts[d.font[0]];
        if (font) drawText(r, font, entry.name, x, y, d.font[1], d.font[2], d.scale, d.fontColor);
      }
    });
    r.setClip(undefined);
  }

  /** Title_Draw: the bottom bar, with the version and copyright, or "Loading demo". */
  private drawBar(width: number, height: number): void {
    const r = this.ctx.renderer;
    const font = this.ctx.smallFont;
    const y = Math.trunc(height - 2 + this.fade.alpha * 10);
    r.rect(0, y - 5, width, y + 2, [0, 0, 0x40, 128]);
    if (!font) return;
    const gray = fontColor(0xc0, 0xc0, 0xc0);
    const text = (s: string, x: number, at: number, align: number) => drawText(r, font, s, x, at, 0, align, [1, 1], gray);
    if (this.chosen === 'demo') {
      text('Loading demo', width - 4, y, -1);
      return;
    }
    const center = Math.trunc(width / 2) - 1;
    text(`M.U.G.E.N ${VERSION}`, 2, y, 1);
    text('(c) Elecbyte 1999-2013', width - 3, y, -1);
    text('Press F1 for info', center, Math.trunc(this.boxProgress * 18 + y), 0);
    text('Press F1 to continue', center, Math.trunc(y + 18 - this.boxProgress * 18), 0);
  }

  /** Title_DrawInfoBox: a framed panel with the version text. */
  private drawInfoBox(width: number, _height: number): void {
    const r = this.ctx.renderer;
    const [boxW, boxH] = this.boxSize();
    const x1 = Math.trunc((width - boxW) / 2);
    const y1 = this.boxY;
    const x2 = x1 + boxW;
    const y2 = y1 + boxH;
    const light: Rgba = [0x56, 0x76, 0xa8, 255];
    const mid: Rgba = [0x40, 0x60, 0x94, 255];
    r.rect(x1 + 2, y1 + 2, x2 - 1, y2 - 1, [0, 0, 0x40, 128]);
    frame(r, x1 + 1, y1 + 1, x2 - 1, y2 - 1, light);
    frame(r, x1 + 2, y1 + 2, x2 - 2, y2 - 2, mid);
    r.rect(x1 + 1, y1, x2, y1 + 1, mid);
    r.rect(x1 + 1, y2, x2, y2 + 1, mid);
    r.rect(x1, y1 + 1, x1 + 1, y2, mid);
    r.rect(x2, y1 + 1, x2 + 1, y2, mid);
    const font = this.ctx.mediumFont;
    if (!font) return;
    // Quirk kept at mugen.exe's size: the text is centered on its left edge, and the box cuts it.
    const align = boxW === BOX_W ? 0 : 1;
    r.setClip([x1, y1, x2, y2]);
    const left = x1 + 10;
    let y = y1 + 6 + font.height;
    for (const line of wrapText(font, INFO_TEXT, boxW - 20)) {
      drawText(r, font, line, left, y, 0, align);
      y += font.height + font.spacing[1];
    }
    drawText(r, font, 'Press F1 to continue.', left, y1 - 21 + boxH + font.height, 0, align);
    r.setClip(undefined);
  }
}

/** Title_Pulse: brightness of the blinking cursor, a triangle wave. */
function pulse(t: number, period: number, base: number): number {
  return t % (period * 2) < period ? (t % period) + base : base + period - 1 - (t % period);
}

function frame(r: Renderer, x1: number, y1: number, x2: number, y2: number, color: Rgba): void {
  r.rect(x1, y1, x2 + 1, y1 + 1, color);
  r.rect(x1, y2, x2 + 1, y2 + 1, color);
  r.rect(x1, y1 + 1, x1 + 1, y2, color);
  r.rect(x2, y1 + 1, x2 + 1, y2, color);
}

/** FONT_WRAP_WORD: lines that fit `width`, broken at spaces and at the text's line ends. */
function wrapText(font: Font, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(font, next) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

export { ElementInstance };
