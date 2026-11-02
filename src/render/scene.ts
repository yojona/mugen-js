// Draws a World: players, afterimages, explods and debug boxes, in MUGEN order.

import type { Blend } from '../formats/air';
import type { Sprite } from '../formats/sff';
import type { Explod } from '../engine/explod';
import { afterImageDraws, envShakeOffset, palFxUniforms } from '../engine/fx';
import type { Player } from '../engine/player';
import type { World } from '../engine/world';
import type { PalFx, Renderer } from './renderer';

interface Drawable {
  priority: number;
  /** Stable tiebreak: creation order. */
  order: number;
  draw(): void;
}

export interface SceneOptions {
  clsn?: boolean;
  /** Called after the background, before any sprite (stage layer 0). */
  background?: () => void;
}

export function drawScene(r: Renderer, w: World, opts: SceneOptions = {}): void {
  const camLeft = w.camera.x - w.screenWidth / 2;
  const shakeY = envShakeOffset(w.envShake);
  const sx = (x: number) => x - camLeft;
  const sy = (y: number) => w.groundY + y + shakeY;

  opts.background?.();
  if (w.darkened) r.rect(0, 0, w.screenWidth, w.screenHeight, [0, 0, 0, 110]);

  const list: Drawable[] = [];
  const top: Drawable[] = [];
  let order = 0;
  const sprite = (s: Sprite | undefined, palette: Uint8Array | undefined, x: number, y: number, scaleX: number, scaleY: number, angle: number, blend: Blend, palfx?: PalFx) => {
    if (!s) return;
    r.draw({ sprite: s, palette, x, y, scaleX, scaleY, angle, blend, palfx });
  };

  for (const p of w.allPlayers()) {
    // Afterimages sit just behind their player.
    for (const ai of afterImageDraws(p.afterImage)) {
      const f = ai.frame;
      list.push({
        priority: p.sprPriority - 0.5,
        order: order++,
        draw: () => sprite(f.sprite, f.palette, sx(f.x), sy(f.y), f.scaleX, f.scaleY, f.angle, p.afterImage.blend, { add: ai.add, mul: ai.mul, color: ai.color, invertAll: ai.invertAll }),
      });
    }
    if (p.special.has('invisible')) continue;
    list.push({ priority: p.sprPriority, order: order++, draw: () => drawPlayer(p) });
  }

  for (const pr of w.projectiles) {
    if (pr.phase === 'dead') continue;
    list.push({
      priority: pr.sprPriority,
      order: order++,
      draw: () => {
        const v = pr.anim.view();
        if (!v || v.element.group < 0) return;
        const o = pr.owner;
        const s = o.prog.data.sff.get(v.element.group, v.element.number);
        sprite(s, s ? o.prog.data.paletteFor(s, o.palRemap ?? o.palNo) : undefined, sx(pr.x + pr.facing * v.x * pr.scale[0]), sy(pr.y + v.y * pr.scale[1]), pr.facing * (v.element.flipH ? -1 : 1) * v.scaleX * pr.scale[0], (v.element.flipV ? -1 : 1) * v.scaleY * pr.scale[1], pr.facing * v.angle, v.blend, palFxUniforms(o.palFx));
      },
    });
  }

  for (const e of w.explods) {
    const d: Drawable = { priority: e.sprPriority, order: order++, draw: () => drawExplod(e) };
    if (e.onTop || e.space === 'screen') top.push(d);
    else list.push(d);
  }

  list.sort((a, b) => a.priority - b.priority || a.order - b.order);
  for (const d of list) d.draw();
  for (const d of top) d.draw();

  function drawPlayer(p: Player): void {
    const v = p.anim.view();
    if (!v || v.element.group < 0) return;
    const s = p.prog.data.sff.get(v.element.group, v.element.number);
    const fx = palFxUniforms(p.palFx);
    const angle = p.angleDraw ? p.angle : v.angle;
    sprite(
      s,
      s ? p.prog.data.paletteFor(s, p.palRemap ?? p.palNo) : undefined,
      sx(p.pos.x + p.facing * (v.x + p.drawOffset[0])),
      sy(p.pos.y + v.y + p.drawOffset[1]),
      p.facing * (v.element.flipH ? -1 : 1) * v.scaleX * p.drawScale[0] * p.const('size.xscale'),
      (v.element.flipV ? -1 : 1) * v.scaleY * p.drawScale[1] * p.const('size.yscale'),
      p.facing * angle,
      p.trans ?? v.blend,
      fx,
    );
    if (opts.clsn) {
      const x0 = sx(p.pos.x);
      const y0 = sy(p.pos.y);
      for (const [boxes, color] of [
        [v.element.clsn2, [60, 120, 255, 90]],
        [v.element.clsn1, [255, 60, 60, 110]],
      ] as const) {
        for (const b of boxes ?? []) r.rect(x0 + p.facing * b.x1, y0 + b.y1, x0 + p.facing * b.x2, y0 + b.y2, [...color]);
      }
    }
  }

  function drawExplod(e: Explod): void {
    const v = e.anim.view();
    if (!v || v.element.group < 0) return;
    const owner = e.owner;
    const sff = e.common ? w.fightFx?.sff : owner.prog.data.sff;
    const s = sff?.get(v.element.group, v.element.number);
    if (!s || !sff) return;
    const palette = e.common ? sff.palettes[s.palette] : owner.prog.data.paletteFor(s, owner.palRemap ?? owner.palNo);
    const fx = e.ownPal ? undefined : palFxUniforms(owner.palFx);
    const x = e.space === 'screen' ? e.x : sx(e.x);
    const y = e.space === 'screen' ? e.y : sy(e.y);
    sprite(s, palette, x + e.facing * v.x, y + e.vfacing * v.y, e.facing * (v.element.flipH ? -1 : 1) * v.scaleX * e.scale[0], e.vfacing * (v.element.flipV ? -1 : 1) * v.scaleY * e.scale[1], e.facing * (v.angle + e.angle), e.trans ?? v.blend, fx);
  }
}
