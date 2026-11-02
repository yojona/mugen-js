// Draws a stage's background elements for one layer (0 = behind players, 1 = front).

import type { Sprite } from '../formats/sff';
import type { StageRuntime } from '../stage/stage';
import type { Renderer } from './renderer';

export function drawStageLayer(r: Renderer, rt: StageRuntime, cam: { x: number; y: number }, layer: 0 | 1, screenW: number, screenH: number, shakeY = 0): void {
  const sff = rt.stage.sff;
  let prev: [number, number] | undefined;
  for (const e of rt.elements) {
    const d = e.def;
    const pos = rt.position(e, cam, screenW, prev);
    prev = pos;
    if (d.layer !== layer || !e.visible || d.type === 'dummy') continue;
    let sprite: Sprite | undefined;
    let ox = 0;
    let oy = 0;
    let blend = d.blend;
    let flipH = false;
    let flipV = false;
    if (e.anim) {
      const v = e.anim.view();
      if (!v || v.element.group < 0) continue;
      sprite = sff.get(v.element.group, v.element.number);
      ox = v.x;
      oy = v.y;
      flipH = v.element.flipH;
      flipV = v.element.flipV;
      if (d.blend.kind === 'none' && v.blend.kind !== 'none') blend = v.blend;
    } else sprite = sff.get(d.spriteNo[0], d.spriteNo[1]);
    if (!sprite) continue;
    const palette = sprite.palette >= 0 ? sff.palettes[sprite.palette] : undefined;
    // Masking window (screen coordinates), moved by windowdelta with the camera.
    const win = d.window;
    if (win) {
      const wx = cam.x * d.windowDelta[0];
      const wy = cam.y * d.windowDelta[1];
      r.setClip([win[0] - wx, win[1] - wy, win[2] - wx + 1, win[3] - wy + 1]);
    }
    const x = pos[0] + ox;
    const y = pos[1] + oy + shakeY;

    if (d.type === 'parallax') {
      drawParallax(r, sprite, palette, d, cam, x, y, screenW, blend);
      if (win) r.setClip(undefined);
      continue;
    }

    // Tiling: 0 = once, 1 = infinite, n > 1 = n copies.
    const stepX = (e.anim ? 0 : sprite.width) + d.tileSpacing[0];
    const stepY = (e.anim ? 0 : sprite.height) + d.tileSpacing[1];
    const range = (count: number, step: number, origin: number, size: number, screen: number): number[] => {
      if (count === 0 || step <= 0) return [0];
      if (count > 1) return Array.from({ length: count }, (_, i) => i);
      const first = Math.floor((0 - (origin + size)) / step);
      const last = Math.ceil((screen - origin) / step);
      const out = [];
      for (let i = first; i <= last; i++) out.push(i);
      return out;
    };
    const left = x - sprite.axisX;
    const top = y - sprite.axisY;
    for (const ty of range(d.tile[1], stepY, top, sprite.height, screenH)) {
      for (const tx of range(d.tile[0], stepX, left, sprite.width, screenW)) {
        r.draw({ sprite, palette, x: x + tx * stepX, y: y + ty * stepY, scaleX: flipH ? -1 : 1, scaleY: flipV ? -1 : 1, blend, mask: d.mask });
      }
    }
    if (win) r.setClip(undefined);
  }
}

function drawParallax(
  r: Renderer,
  sprite: Sprite,
  palette: Uint8Array | undefined,
  d: StageRuntime['elements'][number]['def'],
  cam: { x: number; y: number },
  x: number,
  y: number,
  screenW: number,
  blend: StageRuntime['elements'][number]['def']['blend'],
): void {
  const w = sprite.width;
  // xscale shears the element: its top and bottom edges scroll at delta*xscale.
  // width gives explicit top/bottom widths (a trapezoid).
  const topW = d.width ? d.width[0] : w;
  const botW = d.width ? d.width[1] : w;
  const xsTop = d.xscale ? d.xscale[0] : topW / w;
  const xsBot = d.xscale ? d.xscale[1] : botW / w;
  const base = x + cam.x * d.delta[0]; // position without horizontal scrolling
  const xTop = base - cam.x * d.delta[0] * xsTop;
  const xBot = base - cam.x * d.delta[0] * xsBot;
  const yscale = 1 / (d.yscaleStart / 100 + (d.yscaleDelta / 100) * cam.y);
  const top = y - sprite.axisY * yscale;
  const bottom = top + sprite.height * yscale;
  const tl = xTop - sprite.axisX * (topW / w);
  const bl = xBot - sprite.axisX * (botW / w);
  const tiles = d.tile[0] === 1 ? Math.ceil(screenW / Math.min(topW, botW)) + 2 : Math.max(1, d.tile[0]);
  const start = d.tile[0] === 1 ? -Math.ceil(Math.max(tl, bl) / Math.min(topW, botW)) - 1 : 0;
  for (let i = start; i < start + tiles; i++) {
    r.drawQuad({
      sprite,
      palette,
      blend,
      mask: d.mask,
      corners: [
        [tl + i * topW, top],
        [tl + (i + 1) * topW, top],
        [bl + i * botW, bottom],
        [bl + (i + 1) * botW, bottom],
      ],
    });
  }
}
