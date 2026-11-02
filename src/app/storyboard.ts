// Storyboards (storyboard.html): logo/intro, character intros and endings.

import { AnimPlayer } from '../engine/anim';
import { IN_S } from '../engine/cmd';
import { dirname, type Vfs } from '../engine/vfs';
import { parseAir, type AnimationMap } from '../formats/air';
import { parseSff, type Sff } from '../formats/sff';
import { parseSnd, type Snd } from '../formats/snd';
import { findSection, getValue, parseIni, splitCsv, unquote, type IniDoc, type Section } from '../formats/text';
import { drawText } from '../motif/element';
import { loadFont, type Font } from '../motif/font';
import { drawStageLayer } from '../render/stage-draw';
import { parseBackground, StageRuntime } from '../stage/stage';
import { BUTTONS } from './input';
import type { AppContext, Screen } from './screen';

const nums = (v: string | undefined): number[] | undefined => (v === undefined ? undefined : splitCsv(v).map((x) => parseFloat(x)));

interface Layer {
  anim?: number;
  text?: string;
  font?: [number, number, number];
  offset: [number, number];
  start: number;
  end: number;
}

interface Scene {
  endTime: number;
  fadeIn: number;
  fadeInCol: [number, number, number];
  fadeOut: number;
  fadeOutCol: [number, number, number];
  clear: [number, number, number] | undefined;
  pos: [number, number];
  layers: Layer[];
  sounds: { value: [number, number]; start: number }[];
  bg?: string;
}

export interface StoryboardData {
  localCoord: [number, number];
  sff: Sff;
  snd: Snd | undefined;
  anims: AnimationMap;
  fonts: (Font | undefined)[];
  scenes: Scene[];
  doc: IniDoc;
}

export async function loadStoryboard(vfs: Vfs, path: string): Promise<StoryboardData> {
  const text = await vfs.text(path);
  const doc = parseIni(text);
  const dir = dirname(path);
  const info = findSection(doc, 'Info');
  const sd = findSection(doc, 'SceneDef');
  const lc = nums(getValue(info, 'localcoord')) ?? [320, 240];
  const sff = await parseSff(await vfs.read(getValue(sd, 'spr') ?? '', dir, 'data'));
  const sndFile = getValue(sd, 'snd');
  const snd = sndFile ? await vfs.read(sndFile, dir, 'data').then(parseSnd).catch(() => undefined) : undefined;
  const fonts: (Font | undefined)[] = [];
  for (let i = 0; i <= 9; i++) {
    const f = getValue(sd, `font${i}`);
    if (f) fonts[i] = await loadFont(vfs, f, dir, 'data').catch(() => undefined);
  }
  // Scenes, in order; some values carry over from the previous scene.
  const scenes: Scene[] = [];
  let prevPos: [number, number] = [0, 0];
  let prevClear: [number, number, number] | undefined;
  for (const sec of doc.sections) {
    if (!/^scene\s+\d+/i.test(sec.name)) continue;
    const g = (k: string) => getValue(sec, k);
    const col = (k: string): [number, number, number] => {
      const v = nums(g(k)) ?? [0, 0, 0];
      return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
    };
    const pos = nums(g('layerall.pos'));
    if (pos) prevPos = [pos[0] ?? 0, pos[1] ?? 0];
    if (g('clearcolor') !== undefined) prevClear = col('clearcolor');
    const layers: Layer[] = [];
    for (let i = 0; i <= 9; i++) {
      const L = (k: string) => g(`layer${i}.${k}`);
      if (L('anim') === undefined && L('text') === undefined) continue;
      const off = nums(L('offset')) ?? [0, 0];
      const font = nums(L('font'));
      layers.push({
        anim: L('anim') !== undefined ? parseInt(L('anim')!, 10) : undefined,
        text: L('text') !== undefined ? unquote(L('text')!) : undefined,
        font: font ? [font[0] ?? 0, font[1] ?? 0, font[2] ?? 0] : undefined,
        offset: [off[0] ?? 0, off[1] ?? 0],
        start: parseInt(L('starttime') ?? '0', 10) || 0,
        end: L('endtime') !== undefined ? parseInt(L('endtime')!, 10) : Number.POSITIVE_INFINITY,
      });
    }
    const sounds = [];
    for (let i = 0; i <= 9; i++) {
      const v = nums(g(`sound${i}.value`));
      if (v) sounds.push({ value: [v[0] ?? 0, v[1] ?? 0] as [number, number], start: parseInt(g(`sound${i}.starttime`) ?? '0', 10) || 0 });
    }
    scenes.push({
      endTime: parseInt(g('end.time') ?? '100', 10) || 100,
      fadeIn: parseInt(g('fadein.time') ?? '0', 10) || 0,
      fadeInCol: col('fadein.col'),
      fadeOut: parseInt(g('fadeout.time') ?? '0', 10) || 0,
      fadeOutCol: col('fadeout.col'),
      clear: prevClear,
      pos: prevPos,
      layers,
      sounds,
      bg: g('bg.name') ? unquote(g('bg.name')!) : undefined,
    });
  }
  const start = parseInt(getValue(sd, 'startscene') ?? '0', 10) || 0;
  return { localCoord: [lc[0] ?? 320, lc[1] ?? 240], sff, snd, anims: parseAir(text), fonts, scenes: scenes.slice(start), doc };
}

export class StoryboardScreen implements Screen {
  result: true | undefined;
  private scene = 0;
  private t = 0;
  private anims = new Map<Layer, AnimPlayer>();
  private bg: StageRuntime | undefined;

  constructor(
    private ctx: AppContext,
    private sb: StoryboardData,
  ) {
    this.enterScene();
  }

  private get cur(): Scene | undefined {
    return this.sb.scenes[this.scene];
  }

  private enterScene(): void {
    this.t = 0;
    this.anims.clear();
    const s = this.cur;
    this.bg = undefined;
    if (s?.bg) {
      const def = findSection(this.sb.doc, `${s.bg}Def`) as Section | undefined;
      const { elements, ctrlDefs } = parseBackground(this.sb.doc, def, s.bg);
      this.bg = new StageRuntime({ sff: this.sb.sff, anims: this.sb.anims, elements, ctrlDefs });
    }
  }

  tick(): void {
    const s = this.cur;
    if (!s) {
      this.result = true;
      return;
    }
    // Start or any button skips the storyboard.
    if (this.t > 5 && this.ctx.keys.pads[0]!.pressed(BUTTONS | IN_S)) {
      this.result = true;
      return;
    }
    for (const L of s.layers) {
      if (L.anim === undefined) continue;
      if (this.t === L.start) {
        const a = this.sb.anims.get(L.anim);
        if (a) this.anims.set(L, new AnimPlayer(a));
      } else this.anims.get(L)?.tick();
    }
    for (const snd of s.sounds) if (snd.start === this.t) this.ctx.mixer.play(this.sb.snd?.get(snd.value[0], snd.value[1]));
    this.bg?.tick();
    this.t++;
    if (this.t >= s.endTime) {
      this.scene++;
      this.enterScene();
    }
  }

  draw(): void {
    const s = this.cur;
    const r = this.ctx.renderer;
    const [w, h] = this.sb.localCoord;
    r.setProjection(w, h);
    const c = s?.clear ?? [0, 0, 0];
    r.clear(c[0] / 255, c[1] / 255, c[2] / 255);
    if (!s) return;
    if (this.bg) drawStageLayer(r, this.bg, { x: 0, y: 0 }, 0, w, h);
    for (const L of s.layers) {
      if (this.t < L.start || this.t >= L.end) continue;
      const x = s.pos[0] + L.offset[0];
      const y = s.pos[1] + L.offset[1];
      const ap = this.anims.get(L);
      const v = ap?.view();
      if (v && v.element.group >= 0) {
        const spr = this.sb.sff.get(v.element.group, v.element.number);
        if (spr) r.draw({ sprite: spr, palette: this.sb.sff.palettes[spr.palette], x: x + v.x, y: y + v.y, scaleX: (v.element.flipH ? -1 : 1) * v.scaleX, scaleY: (v.element.flipV ? -1 : 1) * v.scaleY, blend: v.blend });
      }
      if (L.text !== undefined && L.font) {
        const font = this.sb.fonts[L.font[0]];
        if (font) L.text.split('\\n').forEach((line, i) => drawText(r, font, line, x, y + i * (font.height + font.spacing[1]), L.font![1], L.font![2]));
      }
    }
    if (this.bg) drawStageLayer(r, this.bg, { x: 0, y: 0 }, 1, w, h);
    // Scene fades (with their own colours).
    let a = 0;
    let col = s.fadeInCol;
    if (this.t < s.fadeIn) a = 1 - this.t / s.fadeIn;
    else if (this.t > s.endTime - s.fadeOut) {
      a = (this.t - (s.endTime - s.fadeOut)) / Math.max(1, s.fadeOut);
      col = s.fadeOutCol;
    }
    if (a > 0) r.rect(0, 0, w, h, [col[0], col[1], col[2], Math.round(Math.min(1, a) * 255)]);
  }
}
