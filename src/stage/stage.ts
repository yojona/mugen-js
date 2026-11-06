// Stage .def files (bgs.html): stage settings, background elements and
// background controllers.

import { readBgm, type BgmInfo } from '../audio/music';
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
  author: string;
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
    /** cuthigh / cutlow: how the stage rows that do not fit a wide screen are cut (defaults 0, -1). */
    cutHigh: number;
    cutLow: number;
  };
  p1: { x: number; y: number; facing: number };
  p2: { x: number; y: number; facing: number };
  /** Simul partners: 25 behind P1 / P2 unless the stage says (Stage_Load). */
  p3: { x: number; y: number; facing: number };
  p4: { x: number; y: number; facing: number };
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
  music: BgmInfo | undefined;
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
  scaleStart: [number, number];
  scaleDelta: [number, number];
  zoomDelta: number;
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
    author: unquote(g(info, 'author') ?? ''),
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
      cutHigh: Math.trunc(num(g(cam, 'cuthigh'), 0)),
      cutLow: Math.trunc(num(g(cam, 'cutlow'), -1)),
    },
    p1: { x: num(g(pi, 'p1startx'), -70), y: num(g(pi, 'p1starty'), 0), facing: num(g(pi, 'p1facing'), 1) },
    p2: { x: num(g(pi, 'p2startx'), 70), y: num(g(pi, 'p2starty'), 0), facing: num(g(pi, 'p2facing'), -1) },
    p3: {
      x: num(g(pi, 'p3startx'), num(g(pi, 'p1startx'), -70) - 25),
      y: num(g(pi, 'p3starty'), num(g(pi, 'p1starty'), 0)),
      facing: num(g(pi, 'p3facing'), num(g(pi, 'p1facing'), 1)),
    },
    p4: {
      x: num(g(pi, 'p4startx'), num(g(pi, 'p2startx'), 70) + 25),
      y: num(g(pi, 'p4starty'), num(g(pi, 'p2starty'), 0)),
      facing: num(g(pi, 'p4facing'), num(g(pi, 'p2facing'), -1)),
    },
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
    music: readBgm((k) => g(music, k), 'bgmusic', { volume: 'bgmvolume', loop: 'bgmloop', start: 'bgmloopstart', end: 'bgmloopend' }),
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
export function parseBackground(
  doc: IniDoc,
  bgdef: Section | undefined,
  prefix: string,
): { elements: BgElementDef[]; ctrlDefs: BgCtrlDef[] } {
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
      if (!curCtrlDef) {
        curCtrlDef = { looptime: -1, ids: null, ctrls: [] };
        ctrlDefs.push(curCtrlDef);
      }
      const params = new Map(sec.entries.map((e) => [e.key, e.value]));
      // BgCtrl_Load: time = start[, end[, looptime]]; the looptime defaults
      // to the CtrlDef's.
      const tv = params.get('time') ? splitCsv(params.get('time')!) : [];
      const time = nums(params.get('time'), [0, 0, curCtrlDef.looptime]);
      curCtrlDef.ctrls.push({
        type: (params.get('type') ?? 'null').toLowerCase(),
        start: time[0]!,
        end: tv.length >= 2 ? time[1]! : time[0]!,
        looptime: tv.length >= 3 ? time[2]! : curCtrlDef.looptime,
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
      scaleStart: nums(v('scalestart'), [1, 1]) as [number, number],
      scaleDelta: nums(v('scaledelta'), [0, 0]) as [number, number],
      zoomDelta: num(v('zoomdelta'), 1),
    });
  }
  return { elements, ctrlDefs };
}

function idList(v: string | undefined): number[] | null {
  if (!v) return null;
  return splitCsv(v)
    .map((x) => parseInt(x, 10))
    .filter((x) => Number.isFinite(x));
}

// ---------------------------------------------------------------------------
// Runtime

export interface BgElementState {
  def: BgElementDef;
  /** BGCtrl position and velocity (pos_x/y, vel_x/y): Bg_Tick adds the velocity every tick. */
  pos: [number, number];
  vel: [number, number];
  visible: boolean;
  enabled: boolean;
  /** Sine waves: amplitude, period, offset (ticks), and their own clocks. */
  sinX: [number, number, number];
  sinY: [number, number, number];
  sinTime: [number, number];
  anim: AnimPlayer | undefined;
  /** Bg_SetCamera results: axis position (x from the screen centre), draw scale, parallax y scale. */
  x: number;
  y: number;
  drawScale: [number, number];
  yscale: number;
}

/** Anything with background elements: a stage, a motif screen, a storyboard layer. */
export interface Background {
  sff: Sff;
  anims: AnimationMap;
  elements: BgElementDef[];
  ctrlDefs: BgCtrlDef[];
}

interface CtrlState {
  c: BgCtrl;
  ids: number[] | null;
  looptime: number;
  timer: number;
}

const f32 = Math.fround;

export class StageRuntime {
  elements: BgElementState[];
  /** Bg ticks (bg->ticks). */
  time = 0;
  private ctrls: CtrlState[];

  constructor(readonly stage: Background) {
    this.elements = stage.elements.map((def) => this.makeState(def));
    this.ctrls = this.makeCtrls();
  }

  private makeCtrls(): CtrlState[] {
    return this.stage.ctrlDefs.flatMap((cd) => cd.ctrls.map((c) => ({ c, ids: c.ids ?? cd.ids, looptime: c.looptime, timer: 0 })));
  }

  private makeState(def: BgElementDef): BgElementState {
    const a = def.actionNo >= 0 ? this.stage.anims.get(def.actionNo) : undefined;
    return {
      def,
      pos: [0, 0],
      vel: [0, 0],
      visible: true,
      enabled: true,
      sinX: [...def.sinX],
      sinY: [...def.sinY],
      sinTime: [0, 0],
      anim: a ? new AnimPlayer(a) : undefined,
      x: 0,
      y: 0,
      drawScale: [1, 1],
      yscale: 1,
    };
  }

  /** Bg_Reset. */
  reset(): void {
    this.elements = this.stage.elements.map((def) => this.makeState(def));
    this.ctrls = this.makeCtrls();
    this.time = 0;
  }

  /** Bg_Tick: controllers, then the animations and sine clocks of enabled elements, and every element's velocity. */
  tick(): void {
    this.runControllers();
    for (const e of this.elements) {
      if (e.enabled) {
        e.anim?.tick();
        if (e.sinX[1] !== 0) e.sinTime[0] = f32(e.sinTime[0] + 1);
        if (e.sinY[1] !== 0) e.sinTime[1] = f32(e.sinTime[1] + 1);
      }
      e.pos[0] = f32(e.vel[0] + e.pos[0]);
      e.pos[1] = f32(e.vel[1] + e.pos[1]);
    }
    this.time++;
  }

  /** BgCtrl_Run: each controller has its own timer (start <= timer <= end, or start -1 on the first tick). */
  private runControllers(): void {
    for (const cs of this.ctrls) {
      const c = cs.c;
      if ((cs.timer >= c.start && cs.timer <= c.end) || (c.start === -1 && this.time === 0)) {
        const targets = this.elements.filter((e) => cs.ids === null || cs.ids.length === 0 || cs.ids.includes(e.def.id));
        applyBgCtrl(c, targets, this.stage);
      }
      cs.timer++;
      if (cs.timer >= cs.looptime && cs.looptime !== -1) cs.timer = 0;
    }
  }

  /**
   * Bg_SetCamera: every element's position for camera (x, y) in stage
   * units (float32 like mugen.exe). A positionlink element follows the
   * last element without one (its velocity, delta and wave, plus start).
   */
  setCamera(x: number, y: number, offX = 0, offY = 0, zoom = 1, cx = 0, cy = 0): void {
    let linkX = 0;
    let linkY = 0;
    const zm1 = zoom - 1;
    for (const e of this.elements) {
      const d = e.def;
      const z = f32(d.zoomDelta * zm1 + 1);
      let waveX = 0;
      let waveY = 0;
      if (e.sinX[1] !== 0) {
        const a = ((e.sinTime[0] + e.sinX[2]) / e.sinX[1]) * Math.PI;
        waveX = f32(Math.sin(a + a) * e.sinX[0]);
      }
      if (e.sinY[1] !== 0) {
        const a = ((e.sinTime[1] + e.sinY[2]) / e.sinY[1]) * Math.PI;
        waveY = f32(Math.sin(a + a) * e.sinY[0]);
      }
      let px: number;
      let py: number;
      let ys: number;
      if (!d.positionLink) {
        const t = f32(this.time);
        // delta is stored negated in mugen.exe (delta_x * -1).
        px = f32(d.velocity[0] * t + -d.delta[0] * x + waveX);
        py = f32(t * d.velocity[1] + -d.delta[1] * y + waveY);
        linkX = f32(px + d.start[0]);
        linkY = f32(d.start[1] + py);
        px = f32(px + e.pos[0]);
        py = f32(py + e.pos[1]);
        e.x = f32((px + d.start[0] - cx) * z + cx);
        ys = d.start[1] + py;
      } else {
        px = f32(e.pos[0] + d.start[0] + waveX);
        py = f32(e.pos[1] + d.start[1] + waveY);
        e.x = f32((px + linkX - cx) * z + cx);
        ys = py + linkY;
      }
      e.y = f32((ys - cy) * z + cy);
      e.x = f32(e.x + offX);
      e.y = f32(e.y + offY);
      e.drawScale = [f32((px * -d.scaleDelta[0] + d.scaleStart[0]) * z), f32((-d.scaleDelta[1] * py + d.scaleStart[1]) * z)];
      if (d.type === 'parallax') {
        // yscale_delta is stored negated too: v = start + delta * y.
        const v = f32(d.yscaleStart * 0.01) + f32(d.yscaleDelta * 0.01) * y;
        e.yscale = v > 0 ? f32(1 / v) : 1e6;
      }
    }
  }

  /** Position of an element's axis on screen after setCamera. */
  position(e: BgElementState, screenW: number): [number, number] {
    return [e.x + screenW / 2, e.y];
  }
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
        e.visible = (n('value') ?? 0) !== 0;
        break;
      case 'enable':
        e.enabled = (n('value') ?? 0) !== 0;
        break;
      case 'velset':
        if (n('x') !== undefined) e.vel[0] = f32(n('x')!);
        if (n('y') !== undefined) e.vel[1] = f32(n('y')!);
        break;
      case 'veladd':
        if (n('x') !== undefined) e.vel[0] = f32(e.vel[0] + f32(n('x')!));
        if (n('y') !== undefined) e.vel[1] = f32(e.vel[1] + f32(n('y')!));
        break;
      // PosSet / PosAdd move the element from its start (pos_x / pos_y).
      case 'posset':
        if (n('x') !== undefined) e.pos[0] = f32(n('x')!);
        if (n('y') !== undefined) e.pos[1] = f32(n('y')!);
        break;
      case 'posadd':
        if (n('x') !== undefined) e.pos[0] = f32(e.pos[0] + f32(n('x')!));
        if (n('y') !== undefined) e.pos[1] = f32(e.pos[1] + f32(n('y')!));
        break;
      case 'anim': {
        // Only animated elements change action (Anim_SetAction + Anim_Reset).
        if (!e.anim) break;
        const a = stage.anims.get(n('value') ?? 0);
        if (a) e.anim = new AnimPlayer(a);
        break;
      }
      // SinX / SinY: value = amplitude, period, offset (missing ones are 0).
      case 'sinx':
        e.sinX = [f32(n('value', 0) ?? 0), f32(n('value', 1) ?? 0), f32(n('value', 2) ?? 0)];
        break;
      case 'siny':
        e.sinY = [f32(n('value', 0) ?? 0), f32(n('value', 1) ?? 0), f32(n('value', 2) ?? 0)];
        break;
    }
  }
}
