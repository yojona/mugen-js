// Generic motif elements used by fight.def / system.def: a sprite, an
// animation or a text, positioned relative to a base point.
//
//   prefix.anim = n          prefix.spr = g, n
//   prefix.font = f, bank, align   prefix.text = "..."
//   prefix.offset = x, y     prefix.facing / vfacing = 1|-1
//   prefix.scale = x, y      prefix.layerno = 0|1|2   prefix.displaytime = t

import { AnimPlayer } from '../engine/anim';
import type { AnimationMap } from '../formats/air';
import type { Sff } from '../formats/sff';
import { getValue, splitCsv, unquote, type Section } from '../formats/text';
import type { Renderer } from '../render/renderer';
import { textWidth, type Font } from './font';

export interface ElementDef {
  anim?: number;
  spr?: [number, number];
  font?: [number, number, number];
  /** Tint for TrueType fonts (font = f, bank, align, r, g, b). */
  fontColor?: [number, number, number];
  text?: string;
  offset: [number, number];
  facing: number;
  vfacing: number;
  scale: [number, number];
  layer: number;
  displayTime: number;
  snd?: [number, number];
}

const numList = (v: string | undefined): number[] | undefined => (v === undefined ? undefined : splitCsv(v).map((x) => parseFloat(x)));

export function parseElement(sec: Section | undefined, prefix: string): ElementDef | undefined {
  if (!sec) return undefined;
  const g = (k: string) => getValue(sec, `${prefix}.${k}`);
  const anim = numList(g('anim'));
  const spr = numList(g('spr'));
  const font = numList(g('font'));
  const text = g('text');
  if (!anim && !spr && !font && text === undefined) return undefined;
  const off = numList(g('offset')) ?? [];
  const sc = numList(g('scale')) ?? [];
  const snd = numList(g('snd'));
  return {
    anim: anim?.[0],
    spr: spr ? [spr[0] ?? 0, spr[1] ?? 0] : undefined,
    font: font ? [font[0] ?? 0, font[1] ?? 0, font[2] ?? 0] : undefined,
    fontColor: font && font.length >= 6 ? [font[3]!, font[4]!, font[5]!] : undefined,
    text: text !== undefined ? unquote(text) : undefined,
    offset: [off[0] ?? 0, off[1] ?? 0],
    facing: (numList(g('facing'))?.[0] ?? 1) < 0 ? -1 : 1,
    vfacing: (numList(g('vfacing'))?.[0] ?? 1) < 0 ? -1 : 1,
    scale: [sc[0] ?? 1, sc[1] ?? 1],
    layer: numList(g('layerno'))?.[0] ?? 0,
    displayTime: numList(g('displaytime'))?.[0] ?? -1,
    snd: snd ? [snd[0] ?? 0, snd[1] ?? 0] : undefined,
  };
}

/** Assets an element draws from. */
export interface ElementAssets {
  sff: Sff;
  anims: AnimationMap;
  fonts: (Font | undefined)[];
}

/** A live element instance (animations keep their own time). */
export class ElementInstance {
  /** SysElem_DrawFight's layer: only elements of this layerno draw while set. */
  static layerFilter: number | undefined;
  private anim: AnimPlayer | undefined;
  constructor(
    readonly def: ElementDef,
    private assets: ElementAssets,
  ) {
    const a = def.anim !== undefined ? assets.anims.get(def.anim) : undefined;
    if (a) this.anim = new AnimPlayer(a);
  }

  reset(): void {
    if (this.anim) this.anim.set(this.anim.anim);
  }

  /** An animation without displaytime is shown for one pass of its looptime. */
  get finished(): boolean {
    const a = this.anim;
    return !!a && a.totalTime >= 0 && a.time >= a.totalTime;
  }

  tick(): void {
    this.anim?.tick();
  }

  /** Draw at base (x, y); `text` overrides the def's text (with %s / %i already substituted). */
  draw(r: Renderer, x: number, y: number, text?: string): void {
    const d = this.def;
    if (ElementInstance.layerFilter !== undefined && d.layer !== ElementInstance.layerFilter) return;
    const px = x + d.offset[0];
    const py = y + d.offset[1];
    if (this.anim) {
      const v = this.anim.view();
      if (v && v.element.group >= 0) {
        const s = this.assets.sff.get(v.element.group, v.element.number);
        if (s) {
          r.draw({
            sprite: s,
            palette: this.assets.sff.palettes[s.palette],
            x: px + d.facing * v.x * d.scale[0],
            y: py + d.vfacing * v.y * d.scale[1],
            scaleX: d.facing * (v.element.flipH ? -1 : 1) * v.scaleX * d.scale[0],
            scaleY: d.vfacing * (v.element.flipV ? -1 : 1) * v.scaleY * d.scale[1],
            angle: v.angle,
            blend: v.blend,
          });
        }
      }
    } else if (d.spr) {
      const s = this.assets.sff.get(d.spr[0], d.spr[1]);
      if (s) r.draw({ sprite: s, palette: this.assets.sff.palettes[s.palette], x: px, y: py, scaleX: d.facing * d.scale[0], scaleY: d.vfacing * d.scale[1] });
    }
    const t = text ?? d.text;
    if (d.font && t !== undefined) {
      const font = this.assets.fonts[d.font[0]];
      if (font) drawText(r, font, t, px, py, d.font[1], d.font[2], d.scale, d.fontColor);
    }
  }
}

/**
 * Draw a string; (x, y) is the baseline anchor. align: 1 = left edge at x,
 * 0 = centered on x, -1 = right edge at x.
 */
export function drawText(r: Renderer, font: Font, text: string, x: number, y: number, bank: number, align: number, scale: [number, number] = [1, 1], color?: [number, number, number]): void {
  const tint = color ? { add: [0, 0, 0] as [number, number, number], mul: [color[0] / 255, color[1] / 255, color[2] / 255] as [number, number, number], color: 1, invertAll: false } : undefined;
  // Font_DrawLines / Font_DrawLine: the glyphs hang a screen pixel below
  // size_h above the baseline; right-aligned text ends a screen pixel further.
  const px = r.screenPixel;
  const w = textWidth(font, text) * scale[0];
  let cx = align > 0 ? x : align < 0 ? x - w + px : x - w / 2;
  const top = y + (font.offset[1] - font.height) * scale[1] + px;
  const palette = font.palette(bank);
  for (const ch of text) {
    const g = font.glyph(ch);
    if (g) r.draw({ sprite: g.sprite, palette, x: cx + font.offset[0] * scale[0], y: top, scaleX: scale[0], scaleY: scale[1], palfx: tint });
    cx += ((g?.width ?? font.spaceWidth) + font.spacing[0]) * scale[0];
  }
}
