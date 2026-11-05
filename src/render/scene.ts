// Draws a World: players, afterimages, explods and debug boxes, in MUGEN order.

import type { Blend } from '../formats/air';
import type { Sprite } from '../formats/sff';
import type { Explod } from '../engine/explod';
import { afterImageDraws, palFxUniforms } from '../engine/fx';
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
  /** Called after all sprites (stage layer 1). */
  foreground?: () => void;
  /** Fight_DrawHud(layer): 0 before the shadows and sprites, 1 after the sprites, 2 after the ontop explods. */
  hud?: (layer: number) => void;
  /** The system elements (announcements), after the stage's front layer. */
  systemElements?: () => void;
}

/** SuperPause darken multipliers (Game_Tick): stage / HUD / fightfx, and the other players. */
export const DARKEN_BG: [number, number, number] = [80 / 256, 80 / 256, 128 / 256];
const DARKEN_PLAYER: [number, number, number] = [128 / 256, 128 / 256, 192 / 256];

export function drawScene(r: Renderer, w: World, opts: SceneOptions = {}): void {
  const camLeft = w.camera.x - w.screenWidth / 2;
  // EnvShake: the camera moves by whole stage units (camera_y_base); a
  // screen of another height shows the stage from crop_top down.
  const shakeY = -(w.shakeBase + w.cropTop);
  const sx = (x: number) => x - camLeft;
  // Stage-space y to screen: ground line, minus the camera's vertical follow.
  const sy = (y: number) => w.groundY + y - w.camera.y + shakeY;

  // Game_Draw: with an EnvColor running neither the stage background nor
  // the shadows are drawn; the colour goes under the sprites (under = 1) or
  // over everything but the on-top layer.
  const env = w.envColor;
  const envFill = () => env && r.rect(0, 0, w.screenWidth, w.screenHeight, [env.rgb[0], env.rgb[1], env.rgb[2], 255]);
  // Game_Tick: a SuperPause with darken scales the palette groups of the
  // stage, the HUD and fightfx (mask 0xB00) by 80/256 (blue 128/256) and
  // every player's but the pauser's by 1/2 (blue 3/4).
  const pauser = w.darkened ? w.superPause!.owner : undefined;
  const dimBg = pauser ? DARKEN_BG : undefined;
  const dimOf = (owner: Player | undefined): [number, number, number] | undefined => (pauser && owner !== pauser ? DARKEN_PLAYER : undefined);
  const tinted = (t: [number, number, number] | undefined, f: () => void) => {
    r.tint = t;
    f();
    r.tint = undefined;
  };
  if (!env) {
    // Game_Draw: AssertSpecial nobg leaves the cleared screen, globalnoshadow no shadows.
    if (!w.globalFlag('nobg')) tinted(dimBg, () => opts.background?.());
  }
  // Fight_DrawHud(0): in front of the background, behind the players.
  opts.hud?.(0);
  if (!env) {
    if (!w.globalFlag('globalnoshadow')) drawShadows(r, w, sx, sy);
  } else if (env.time > 0 && env.under) envFill();

  const list: Drawable[] = [];
  const top: Drawable[] = [];
  let order = 0;
  const sprite = (s: Sprite | undefined, palette: Uint8Array | undefined, x: number, y: number, scaleX: number, scaleY: number, angle: number, blend: Blend, palfx?: PalFx) => {
    if (!s) return;
    r.draw({ sprite: s, palette, x, y, scaleX, scaleY, angle, blend, palfx });
  };

  // Game_Draw queues the players (first to last), the projectiles (last to
  // first), the explods (slot order) and the afterimages (last to first);
  // SpriteQueue_Add puts an item before the queued items of its layer, so
  // among equal priorities the later one is drawn first (below).
  const players = w.allPlayers();
  for (const p of players) {
    if (p.special.has('invisible')) continue;
    list.push({ priority: p.sprPriority, order: order++, draw: () => tinted(dimOf(p), () => drawPlayer(p)) });
  }

  for (const pr of [...w.projectiles].reverse()) {
    if (pr.phase === 'dead' || pr.phase === 'removing') continue;
    list.push({
      priority: pr.sprPriority,
      order: order++,
      draw: () => tinted(dimOf(pr.owner), () => {
        const v = pr.anim.view();
        if (!v || v.element.group < 0) return;
        const o = pr.owner;
        const s = o.prog.data.sff.get(v.element.group, v.element.number);
        sprite(s, s ? o.prog.data.paletteFor(s, o.palRemap ?? o.palNo) : undefined, sx(pr.x + pr.facing * v.x * pr.scale[0]), sy(pr.y + v.y * pr.scale[1]), pr.facing * (v.element.flipH ? -1 : 1) * v.scaleX * pr.scale[0], (v.element.flipV ? -1 : 1) * v.scaleY * pr.scale[1], pr.facing * v.angle, v.blend, palFxUniforms(o.palFx));
      }),
    });
  }

  for (const e of w.explods) {
    const d: Drawable = { priority: e.sprPriority, order: order++, draw: () => tinted(e.common ? dimBg : dimOf(e.owner), () => drawExplod(e)) };
    if (e.onTop || e.space === 'screen') top.push(d);
    else list.push(d);
  }

  for (const p of [...players].reverse()) {
    // AfterImage_Draw queues the newest image first.
    for (const ai of afterImageDraws(p.afterImage).reverse()) {
      const f = ai.frame;
      // The k-th newest image sits at min(its recorded layer, the
      // player's) - 1 - k.
      list.push({
        priority: Math.min(f.layer, p.sprPriority) - 1 - ai.k,
        order: order++,
        draw: () => tinted(dimOf(p), () => sprite(f.sprite, f.palette, sx(f.x), sy(f.y), f.scaleX, f.scaleY, f.angle, p.afterImage.blend, { add: ai.add, mul: ai.mul, color: ai.color, invertAll: ai.invertAll })),
      });
    }
  }

  list.sort((a, b) => a.priority - b.priority || b.order - a.order);
  for (const d of list) d.draw();
  opts.hud?.(1);
  if (!w.globalFlag('nofg')) tinted(dimBg, () => opts.foreground?.());
  opts.systemElements?.();
  if (env && env.time > 0 && !env.under) envFill();
  for (const d of top) d.draw();
  opts.hud?.(2);

  function drawPlayer(p: Player): void {
    const v = p.anim.view();
    if (!v || v.element.group < 0) return;
    const s = p.prog.data.sff.get(v.element.group, v.element.number);
    const fx = palFxUniforms(p.palFx);
    const angle = p.angleDraw ? p.angle : v.angle;
    const k = p.scale;
    sprite(
      s,
      s ? p.prog.data.paletteFor(s, p.palRemap ?? p.palNo) : undefined,
      sx((p.pos.x + p.facing * (v.x + p.drawOffset[0])) * k),
      sy((p.pos.y + v.y + p.drawOffset[1]) * k),
      p.facing * (v.element.flipH ? -1 : 1) * v.scaleX * p.drawScale[0] * p.const('size.xscale') * k,
      (v.element.flipV ? -1 : 1) * v.scaleY * p.drawScale[1] * p.const('size.yscale') * k,
      p.facing * angle,
      p.trans ?? v.blend,
      fx,
    );
    if (opts.clsn) {
      const x0 = sx(p.wx);
      const y0 = sy(p.wy);
      for (const [boxes, color] of [
        [v.element.clsn2, [60, 120, 255, 90]],
        [v.element.clsn1, [255, 60, 60, 110]],
      ] as const) {
        for (const b of boxes ?? []) r.rect(x0 + p.facing * b.x1 * k, y0 + b.y1 * k, x0 + p.facing * b.x2 * k, y0 + b.y2 * k, [...color]);
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
    const k = e.drawScale;
    sprite(s, palette, x + e.facing * v.x * k * e.scale[0], y + e.vfacing * v.y * k * e.scale[1], e.facing * (v.element.flipH ? -1 : 1) * v.scaleX * e.scale[0] * k, e.vfacing * (v.element.flipV ? -1 : 1) * v.scaleY * e.scale[1] * k, e.facing * (v.angle + e.angle), e.trans ?? v.blend, fx);
  }
}

/** Floor shadows: each player's sprite flattened onto the ground (stage [Shadow]). */
function drawShadows(r: Renderer, w: World, sx: (x: number) => number, sy: (y: number) => number): void {
  // Shadow_Draw: the floor line ("top") includes the character's
  // [Size] shadowoffset; ty is the sprite position's height above it (the
  // player's height plus the AIR element offset, both scaled).
  const refl = Math.max(0, Math.min(256, w.reflection));
  const sh = w.shadow;
  for (const p of w.allPlayers()) {
    if (p.special.has('invisible')) continue;
    const v = p.anim.view();
    if (!v || v.element.group < 0) continue;
    const s = p.prog.data.sff.get(v.element.group, v.element.number);
    if (!s) continue;
    const k = p.scale;
    const top = sy(p.const('size.shadowoffset') * k);
    const ty = top - sy((p.pos.y + v.y + p.drawOffset[1]) * k);
    const x = sx((p.pos.x + p.facing * (v.x + p.drawOffset[0])) * k);
    const scaleX = p.facing * (v.element.flipH ? -1 : 1) * v.scaleX * p.drawScale[0] * p.const('size.xscale') * k;
    const scaleY = (v.element.flipV ? -1 : 1) * v.scaleY * p.drawScale[1] * p.const('size.yscale') * k;
    // The reflection: mirrored about the floor line, blended with alpha
    // intensity / 256 (drawn before the shadow).
    if (refl > 0) {
      r.draw({
        sprite: s,
        palette: p.prog.data.paletteFor(s, p.palRemap ?? p.palNo),
        x,
        y: top + ty,
        scaleX,
        scaleY: -scaleY,
        palfx: palFxUniforms(p.palFx),
        blend: { kind: 'add', src: refl, dst: 256 - refl },
      });
    }
    // The shadow: the sprite squashed by -yscale (a positive yscale falls
    // towards the screen) at top + ty * yscale, fading out between the
    // fade.range heights. ([Shadow] xshear is not supported: no stage in
    // the reference tree uses it.)
    if (!sh || sh.intensity <= 0 || p.special.has('noshadow')) continue;
    let fade = 1;
    const [lo, hi] = sh.fadeRange;
    if (lo < hi) {
      if (lo >= p.pos.y) continue;
      if (hi > p.pos.y) fade = (p.pos.y - lo) / (hi - lo);
    }
    const a = Math.round((sh.intensity / 256) * fade * 256);
    if (a <= 0) continue;
    r.draw({
      sprite: s,
      palette: p.prog.data.paletteFor(s, p.palNo),
      x,
      y: top + ty * sh.yscale,
      scaleX,
      scaleY: -sh.yscale * scaleY,
      // Shadow color with partial opacity: multiply to black, blend by alpha.
      palfx: { add: [sh.color[0] / 255, sh.color[1] / 255, sh.color[2] / 255], mul: [0, 0, 0], color: 1, invertAll: false },
      blend: { kind: 'add', src: a, dst: 256 - a },
    });
  }
}

