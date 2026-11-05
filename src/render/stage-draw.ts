// Draws a stage's background elements for one layer (0 = behind players, 1 = front).

import type { Sprite } from '../formats/sff';
import type { StageRuntime } from '../stage/stage';
import type { Renderer } from './renderer';

export function drawStageLayer(r: Renderer, rt: StageRuntime, cam: { x: number; y: number }, layer: 0 | 1, screenW: number, screenH: number, shakeY = 0): void {
  const sff = rt.stage.sff;
  rt.setCamera(cam.x, cam.y);
  for (const e of rt.elements) {
    const d = e.def;
    const pos = rt.position(e, screenW);
    if (d.layer !== layer || !e.visible || !e.enabled || d.type === 'dummy') continue;
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
      if (e.anim) drawParallax(r, sprite, palette, d, cam, x, y, screenW, blend);
      else drawParallaxRows(r, sprite, palette, d, e, x, y, blend, win ? [win[0] - cam.x * d.windowDelta[0], win[1] - cam.y * d.windowDelta[1], win[2] - cam.x * d.windowDelta[0] + 1, win[3] - cam.y * d.windowDelta[1] + 1] : undefined);
      if (win) r.setClip(undefined);
      continue;
    }

    // Tiling: 0 = once, 1 = infinite, n > 1 = n copies.
    // scalestart / scaledelta (Bg_SetCamera's draw scale).
    const [dsx, dsy] = e.drawScale;
    const stepX = ((e.anim ? 0 : sprite.width) + d.tileSpacing[0]) * dsx;
    const stepY = ((e.anim ? 0 : sprite.height) + d.tileSpacing[1]) * dsy;
    const range = (count: number, step: number, origin: number, size: number, screen: number): number[] => {
      if (count === 0 || step <= 0) return [0];
      if (count > 1) return Array.from({ length: count }, (_, i) => i);
      const first = Math.floor((0 - (origin + size)) / step);
      const last = Math.ceil((screen - origin) / step);
      const out = [];
      for (let i = first; i <= last; i++) out.push(i);
      return out;
    };
    const left = x - sprite.axisX * dsx;
    const top = y - sprite.axisY * dsy;
    for (const ty of range(d.tile[1], stepY, top, sprite.height * dsy, screenH)) {
      for (const tx of range(d.tile[0], stepX, left, sprite.width * dsx, screenW)) {
        r.draw({ sprite, palette, x: x + tx * stepX, y: y + ty * stepY, scaleX: (flipH ? -1 : 1) * dsx, scaleY: (flipV ? -1 : 1) * dsy, blend, mask: d.mask });
      }
    }
    if (win) r.setClip(undefined);
  }
}

/**
 * BgElem_DrawParallaxSoft(Masked): mugen.exe's software renderer draws a
 * sprite parallax row by row in output pixels. Each output row shows one
 * source row (the next ones come every 1 / yscale rows), starts on a whole
 * pixel that moves with the camera by a factor running from the top row to
 * width_bottom / width_top at the bottom ("xscale"), or by the row's width
 * ("width"), and with tiling repeats every trunc(row width) pixels. Here each
 * row is a one-pixel strip clipped to its pixels.
 */
function drawParallaxRows(
  r: Renderer,
  sprite: Sprite,
  palette: Uint8Array | undefined,
  d: StageRuntime['elements'][number]['def'],
  e: StageRuntime['elements'][number],
  x: number,
  y: number,
  blend: StageRuntime['elements'][number]['def']['blend'],
  win: [number, number, number, number] | undefined,
): void {
  const f = Math.fround;
  const [kx, ky] = r.deviceScale();
  const cw = r.canvas.width;
  const ch = r.canvas.height;
  // The clip rectangle: the screen, or the element's window.
  let [cx1, cy1, cx2, cy2] = [0, 0, cw, ch];
  if (win) {
    const k0x = cw / r.width;
    const k0y = ch / r.height;
    cx1 = Math.max(0, Math.round(Math.min(win[0], win[2]) * k0x));
    cx2 = Math.min(cw, Math.round(Math.max(win[0], win[2]) * k0x));
    cy1 = Math.max(0, Math.round(Math.min(win[1], win[3]) * k0y));
    cy2 = Math.min(ch, Math.round(Math.max(win[1], win[3]) * k0y));
  }
  const w = sprite.width;
  const h = sprite.height;
  const scaleX = f(e.drawScale[0] * kx);
  const scaleY = f(f(e.yscale * e.drawScale[1]) * ky);
  if (scaleX <= 0 || scaleY <= 0) return;
  // Output x of the anchor from the middle of the screen.
  const px = f((x * r.view.s + r.view.ox) * (cw / r.width) - cw / 2);
  const axisX = Math.trunc(sprite.axisX * scaleX);
  const axisY = Math.trunc(sprite.axisY * scaleY);
  const devY = (y * r.view.s + r.view.oy) * (ch / r.height);
  let oy = Math.floor(f(f(devY) - axisY) + 0.5);
  const byWidth = !!d.width;
  const wTop = byWidth ? d.width![0] : w * (d.xscale ? d.xscale[0] : 1);
  const wBot = byWidth ? d.width![1] : w * (d.xscale ? d.xscale[1] : 1);
  const ratio = f(wBot / wTop);
  const rowWidth = (i: number) => (byWidth ? Math.trunc(((wBot - wTop) * i) / (h - 1) + wTop) : w);
  const rowStart = (row: number): number => {
    if (byWidth) {
      const w0 = rowWidth(0);
      return Math.trunc(((px - w0 * scaleX * 0.5) * rowWidth(row)) / w0 + Math.trunc(cw / 2));
    }
    return Math.trunc((((ratio - 1) * (row + 1)) / h + 1) * px + (Math.trunc(cw / 2) - axisX));
  };
  const tiled = d.tile[0] !== 0;
  const prevSnap = r.snap;
  r.snap = false;
  let yAcc = 0;
  let row = 0;
  try {
    if (oy >= cy2) return;
    while (row < h) {
      if (oy >= cy1) {
        const rw = rowWidth(row);
        const span = rw * scaleX;
        let xs = rowStart(row);
        if (tiled && (span - 1 + xs < cx1 || xs > cx1)) {
          const m = ((xs - cx1) % Math.trunc(span)) + cx1;
          xs = m > cx1 ? Math.trunc(m - span) : m;
        }
        const xe = Math.min(Math.trunc(span - 1 + xs), cx2 - 1);
        if (xe >= cx1 && xs < cx2) {
          // Tile starts: the first runs to xe, the next ones trunc(span) apart.
          const xEnd = tiled ? cx2 - 1 : xe;
          let t = xs;
          let len = xe - Math.max(xs, cx1) + 1;
          let start = Math.max(xs, cx1);
          while (start <= xEnd && len >= 0) {
            const stop = Math.min(start + len, cx2);
            if (stop > start) {
              r.setClipDevice(start, oy, stop, oy + 1);
              // Source row `row` on output row oy, the tile's first pixel at t.
              const [gx, gy] = r.fromDevice(t + 0.25, oy - row);
              const sx = span / w / kx;
              const sy = 1 / ky;
              r.draw({ sprite, palette, x: gx + sprite.axisX * sx, y: gy + sprite.axisY * sy, scaleX: sx, scaleY: sy, blend, mask: d.mask });
            }
            t = start + len;
            start = t;
            len = Math.trunc(span);
          }
        }
      }
      yAcc = f(f(1 / scaleY) + yAcc);
      const n = Math.trunc(yAcc);
      yAcc = f(yAcc - n);
      oy++;
      row += n;
      if (oy >= cy2) break;
    }
  } finally {
    r.snap = prevSnap;
    r.setClip(win);
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
