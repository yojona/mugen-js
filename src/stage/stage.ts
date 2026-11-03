// Stage .def files (bgs.html): stage settings, background elements and
// background controllers.

import { AnimPlayer } from '../engine/anim';
import { dirname, type Vfs } from '../engine/vfs';
import { parseAir, parseBlend, type AnimationMap, type Blend } from '../formats/air';
import { parseSff, type Sff } from '../formats/sff';
import { findSection, getValue, parseIni, splitCsv, unquote, type IniDoc, type Section } from '../formats/text';

const nums = (v: string | undefined, d: number[]): number[] => {
  if (v === undefined) return d;
  const parts = splitCsv(v).map((x) => parseFloat(x));
  return d.map((def, i) => (Number.isFinite(parts[i]) ? parts[i]! : def));
};
const num = (v: string | undefined, d: number) => nums(v, [d])[0]!;

export interface StageInfo {
  name: string;
  displayName: string;
  mugenVersion: string;
  camera: {
    startX: number;
    startY: number;
    boundLeft: number;
    boundRight: number;
    boundHigh: number;
    boundLow: number;
    tension: number;
    verticalFollow: number;
    floorTension: number;
    tensionHigh?: number;
    tensionLow?: number;
    overdrawHigh: number;
    overdrawLow: number;
  };
  p1: { x: number; y: number; facing: number };
  p2: { x: number; y: number; facing: number };
  leftBound: number;
  rightBound: number;
  screenLeft: number;
  screenRight: number;
  zoffset: number;
  zoffsetLink?: number;
  autoTurn: boolean;
  resetBG: boolean;
  localCoord: [number, number];
  scale: [number, number];
  shadow: { intensity: number; color: [number, number, number]; yscale: number; fadeRange: [number, number] };
  reflection: number;
  music: { file: string; volume: number };
  debugBg: boolean;
}

export type BgType = 'normal' | 'anim' | 'parallax' | 'dummy';

export interface BgElementDef {
  name: string;
  type: BgType;
  layer: 0 | 1;
  spriteNo: [number, number];
  actionNo: number;
  start: [number, number];
  delta: [number, number];
  blend: Blend;
  mask: boolean;
  tile: [number, number];
  tileSpacing: [number, number];
  id: number;
  positionLink: boolean;
  /** Screen-space masking window (x1,y1,x2,y2), if any. */
  window?: [number, number, number, number];
  windowDelta: [number, number];
  velocity: [number, number];
  sinX: [number, number, number];
  sinY: [number, number, number];
  /** Parallax: xscale (top, bottom) or explicit widths (top, bottom). */
  xscale?: [number, number];
  width?: [number, number];
  yscaleStart: number;
  yscaleDelta: number;
}

export interface BgCtrl {
  type: string;
  start: number;
  end: number;
  looptime: number;
  ids: number[] | null;
  params: Map<string, string>;
}

export interface BgCtrlDef {
  looptime: number;
  ids: number[] | null;
  ctrls: BgCtrl[];
}

export interface Stage extends Background {
  info: StageInfo;
}

export async function loadStage(vfs: Vfs, defPath: string): Promise<Stage> {
  const text = await vfs.text(defPath);
  const doc = parseIni(text);
  const dir = dirname(defPath);
  const S = (n: string) => findSection(doc, n);
  const info = S('Info');
  const cam = S('Camera');
  const pi = S('PlayerInfo');
  const bound = S('Bound');
  const si = S('StageInfo');
  const sh = S('Shadow');
  const refl = S('Reflection');
  const music = S('Music');
  const bgdef = S('BGdef') ?? S('BGDef');
  const g = (sec: Section | undefined, k: string) => getValue(sec, k);
  const name = unquote(g(info, 'name') ?? defPath);
  const stageInfo: StageInfo = {
    name,
    displayName: unquote(g(info, 'displayname') ?? name),
    mugenVersion: g(info, 'mugenversion') ?? '',
    camera: {
      startX: num(g(cam, 'startx'), 0),
      startY: num(g(cam, 'starty'), 0),
      boundLeft: num(g(cam, 'boundleft'), -95),
      boundRight: num(g(cam, 'boundright'), 95),
      boundHigh: num(g(cam, 'boundhigh'), -25),
      boundLow: num(g(cam, 'boundlow'), 0),
      tension: num(g(cam, 'tension'), 50),
      verticalFollow: num(g(cam, 'verticalfollow'), 0.2),
      floorTension: num(g(cam, 'floortension'), 0),
      tensionHigh: g(cam, 'tensionhigh') !== undefined ? num(g(cam, 'tensionhigh'), 0) : undefined,
      tensionLow: g(cam, 'tensionlow') !== undefined ? num(g(cam, 'tensionlow'), 0) : undefined,
      overdrawHigh: num(g(cam, 'overdrawhigh'), 0),
      overdrawLow: num(g(cam, 'overdrawlow'), 0),
    },
    p1: { x: num(g(pi, 'p1startx'), -70), y: num(g(pi, 'p1starty'), 0), facing: num(g(pi, 'p1facing'), 1) },
    p2: { x: num(g(pi, 'p2startx'), 70), y: num(g(pi, 'p2starty'), 0), facing: num(g(pi, 'p2facing'), -1) },
    leftBound: num(g(pi, 'leftbound'), -1000),
    rightBound: num(g(pi, 'rightbound'), 1000),
    screenLeft: num(g(bound, 'screenleft'), 15),
    screenRight: num(g(bound, 'screenright'), 15),
    zoffset: num(g(si, 'zoffset'), 200),
    zoffsetLink: g(si, 'zoffsetlink') !== undefined ? num(g(si, 'zoffsetlink'), 0) : undefined,
    // matchload.c: autoturn defaults to 0.
    autoTurn: num(g(si, 'autoturn'), 0) !== 0,
    resetBG: num(g(si, 'resetbg'), 1) !== 0,
    localCoord: nums(g(si, 'localcoord'), [320, 240]) as [number, number],
    scale: [num(g(si, 'xscale'), 1), num(g(si, 'yscale'), 1)],
    shadow: {
      intensity: num(g(sh, 'intensity'), 128),
      color: nums(g(sh, 'color'), [0, 0, 0]) as [number, number, number],
      yscale: num(g(sh, 'yscale'), 0.4),
      fadeRange: nums(g(sh, 'fade.range'), [0, 0]) as [number, number],
    },
    reflection: num(g(refl, 'intensity'), 0),
    music: { file: g(music, 'bgmusic') ?? '', volume: num(g(music, 'bgmvolume'), 0) },
    debugBg: num(g(bgdef, 'debugbg'), 0) !== 0,
  };

  const sprFile = g(bgdef, 'spr');
  const sff = await parseSff(await vfs.read(sprFile ?? '', dir, 'stages'));
  // [Begin Action n] blocks may live anywhere in the stage file.
  const anims = parseAir(text);
  const { elements, ctrlDefs } = parseBackground(doc, bgdef, 'bg');
  return { info: stageInfo, sff, anims, elements, ctrlDefs };
}

/**
 * Parse background elements and controllers following `bgdef`. `prefix` is
 * "bg" for stages, "titlebg" / "selectbg" / ... for motif screens and
 * storyboard layers.
 */
export function parseBackground(doc: IniDoc, bgdef: Section | undefined, prefix: string): { elements: BgElementDef[]; ctrlDefs: BgCtrlDef[] } {
  prefix = prefix.toLowerCase();
  const elements: BgElementDef[] = [];
  const ctrlDefs: BgCtrlDef[] = [];
  let curCtrlDef: BgCtrlDef | undefined;
  const bgIndex = bgdef ? doc.sections.indexOf(bgdef) : -1;
  if (bgIndex < 0) return { elements, ctrlDefs };
  const g = (sec: Section | undefined, k: string) => getValue(sec, k);
  for (const sec of doc.sections.slice(bgIndex + 1)) {
    const lname = sec.name.toLowerCase();
    // A new *BGdef / *Def section ends this background.
    if (/def$/.test(lname) && !lname.startsWith(`${prefix}ctrldef`)) break;
    if (lname.startsWith(`${prefix}ctrldef`)) {
      curCtrlDef = { looptime: num(g(sec, 'looptime'), -1), ids: idList(g(sec, 'ctrlid')), ctrls: [] };
      ctrlDefs.push(curCtrlDef);
      continue;
    }
    if (lname.startsWith(`${prefix}ctrl`)) {
      if (!curCtrlDef) continue;
      const params = new Map(sec.entries.map((e) => [e.key, e.value]));
      const time = nums(params.get('time'), [0, -1, -1]);
      curCtrlDef.ctrls.push({
        type: (params.get('type') ?? 'null').toLowerCase(),
        start: time[0]!,
        end: params.get('time')?.includes(',') ? time[1]! : time[0]!,
        looptime: time[2]!,
        ids: idList(params.get('ctrlid')),
        params,
      });
      continue;
    }
    if (!lname.startsWith(`${prefix} `) && lname !== prefix) continue;
    const v = (k: string) => g(sec, k);
    const type = (v('type') ?? 'normal').toLowerCase() as BgType;
    const trans = v('trans')?.toLowerCase();
    const alpha = nums(v('alpha'), [256, 256]);
    let blend: Blend = { kind: 'none' };
    if (trans === 'add') blend = { kind: 'add', src: 256, dst: 256 };
    else if (trans === 'add1') blend = { kind: 'add', src: 256, dst: 128 };
    else if (trans === 'addalpha') blend = { kind: 'add', src: alpha[0]!, dst: alpha[1]! };
    else if (trans === 'sub') blend = { kind: 'sub' };
    else if (trans && trans !== 'none' && trans !== 'default') blend = parseBlend(trans);
    const maskDefault = trans === 'add' || trans === 'add1' || trans === 'addalpha' || trans === 'sub' || type === 'anim';
    const win = v('maskwindow') ?? v('window');
    elements.push({
      name: sec.name,
      type,
      layer: num(v('layerno'), 0) === 1 ? 1 : 0,
      spriteNo: nums(v('spriteno'), [0, 0]) as [number, number],
      actionNo: num(v('actionno'), -1),
      start: nums(v('start'), [0, 0]) as [number, number],
      delta: nums(v('delta'), [1, 1]) as [number, number],
      blend,
      mask: type === 'anim' || num(v('mask'), maskDefault ? 1 : 0) !== 0,
      tile: nums(v('tile'), [0, 0]) as [number, number],
      tileSpacing: nums(v('tilespacing'), [0, 0]) as [number, number],
      id: num(v('id'), 0),
      positionLink: num(v('positionlink'), 0) !== 0,
      window: win ? (nums(win, [0, 0, 0, 0]) as [number, number, number, number]) : undefined,
      windowDelta: nums(v('windowdelta'), [0, 0]) as [number, number],
      velocity: nums(v('velocity'), [0, 0]) as [number, number],
      sinX: nums(v('sin.x'), [0, 0, 0]) as [number, number, number],
      sinY: nums(v('sin.y'), [0, 0, 0]) as [number, number, number],
      xscale: v('xscale') !== undefined ? (nums(v('xscale'), [1, 1]) as [number, number]) : undefined,
      width: v('width') !== undefined ? (nums(v('width'), [0, 0]) as [number, number]) : undefined,
      yscaleStart: num(v('yscalestart'), 100),
      yscaleDelta: num(v('yscaledelta'), 0),
    });
  }
  return { elements, ctrlDefs };
}

function idList(v: string | undefined): number[] | null {
  if (!v) return null;
  return splitCsv(v).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x));
}

// ---------------------------------------------------------------------------
// Runtime

export interface BgElementState {
  def: BgElementDef;
  /** Offset added by BGCtrl PosSet/PosAdd and velocity. */
  offset: [number, number];
  vel: [number, number];
  visible: boolean;
  enabled: boolean;
  sinX: [number, number, number];
  sinY: [number, number, number];
  anim: AnimPlayer | undefined;
}

/** Anything with background elements: a stage, a motif screen, a storyboard layer. */
export interface Background {
  sff: Sff;
  anims: AnimationMap;
  elements: BgElementDef[];
  ctrlDefs: BgCtrlDef[];
}

export class StageRuntime {
  elements: BgElementState[];
  time = 0;
  private ctrlTimers: number[];

  constructor(readonly stage: Background) {
    this.elements = stage.elements.map((def) => this.makeState(def));
    this.ctrlTimers = stage.ctrlDefs.map(() => 0);
  }

  private makeState(def: BgElementDef): BgElementState {
    const a = def.actionNo >= 0 ? this.stage.anims.get(def.actionNo) : undefined;
    return { def, offset: [0, 0], vel: [...def.velocity], visible: true, enabled: true, sinX: [...def.sinX], sinY: [...def.sinY], anim: a ? new AnimPlayer(a) : undefined };
  }

  reset(): void {
    this.elements = this.stage.elements.map((def) => this.makeState(def));
    this.ctrlTimers = this.stage.ctrlDefs.map(() => 0);
    this.time = 0;
  }

  tick(): void {
    this.runControllers();
    for (const e of this.elements) {
      if (!e.enabled) continue;
      e.offset[0] += e.vel[0];
      e.offset[1] += e.vel[1];
      e.anim?.tick();
    }
    this.time++;
  }

  private runControllers(): void {
    this.stage.ctrlDefs.forEach((cd, i) => {
      const t = this.ctrlTimers[i]!;
      for (const c of cd.ctrls) {
        const lt = c.looptime > 0 ? t % c.looptime : t;
        if (lt < c.start || (c.end >= c.start && lt > c.end)) continue;
        const ids = c.ids ?? cd.ids;
        const targets = this.elements.filter((e) => ids === null || ids.includes(e.def.id));
        applyBgCtrl(c, targets, this.stage);
      }
      this.ctrlTimers[i] = cd.looptime > 0 && t + 1 >= cd.looptime ? 0 : t + 1;
    });
  }

  /** Position of an element's axis on screen (bgs.html start/delta rules). */
  position(e: BgElementState, cam: { x: number; y: number }, screenW: number, prev?: [number, number]): [number, number] {
    const d = e.def;
    const sx = sinValue(e.sinX, this.time);
    const sy = sinValue(e.sinY, this.time);
    if (d.positionLink && prev) return [prev[0] + d.start[0] + e.offset[0] + sx, prev[1] + d.start[1] + e.offset[1] + sy];
    return [screenW / 2 + d.start[0] + e.offset[0] - cam.x * d.delta[0] + sx, d.start[1] + e.offset[1] - cam.y * d.delta[1] + sy];
  }
}

function sinValue(s: [number, number, number], t: number): number {
  if (!s[0] || !s[1]) return 0;
  return s[0] * Math.sin(((t + s[2] / 360 * s[1]) * 2 * Math.PI) / s[1]);
}

function applyBgCtrl(c: BgCtrl, targets: BgElementState[], stage: Background): void {
  const p = (k: string) => c.params.get(k);
  const n = (k: string, i = 0) => {
    const v = p(k);
    if (v === undefined) return undefined;
    const x = parseFloat(splitCsv(v)[i] ?? '');
    return Number.isFinite(x) ? x : undefined;
  };
  for (const e of targets) {
    switch (c.type) {
      case 'visible':
        e.visible = (n('value') ?? 1) !== 0;
        break;
      case 'enable':
        e.enabled = (n('value') ?? 1) !== 0;
        e.visible = e.enabled;
        break;
      case 'velset':
        if (n('x') !== undefined) e.vel[0] = n('x')!;
        if (n('y') !== undefined) e.vel[1] = n('y')!;
        break;
      case 'veladd':
        e.vel[0] += n('x') ?? 0;
        e.vel[1] += n('y') ?? 0;
        break;
      case 'posset':
        if (n('x') !== undefined) e.offset[0] = n('x')! - e.def.start[0];
        if (n('y') !== undefined) e.offset[1] = n('y')! - e.def.start[1];
        break;
      case 'posadd':
        e.offset[0] += n('x') ?? 0;
        e.offset[1] += n('y') ?? 0;
        break;
      case 'anim': {
        const a = stage.anims.get(n('value') ?? -1);
        if (a) e.anim = new AnimPlayer(a);
        break;
      }
      case 'sinx':
        e.sinX = [n('value', 0) ?? e.sinX[0], n('value', 1) ?? e.sinX[1], n('value', 2) ?? e.sinX[2]];
        break;
      case 'siny':
        e.sinY = [n('value', 0) ?? e.sinY[0], n('value', 1) ?? e.sinY[1], n('value', 2) ?? e.sinY[2]];
        break;
    }
  }
}
