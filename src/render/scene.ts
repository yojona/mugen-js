// Draws a World: players, afterimages, and explods, in MUGEN order.

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

/** Stage coordinates to the screen's, in stage units. */
export function stageToScreen(w: World): { sx: (x: number) => number; sy: (y: number) => number } {
  const camLeft = w.camera.x - w.screenWidth / 2;
  // EnvShake: the camera moves by whole stage units (camera_y_base); a
  // screen of another height shows the stage from crop_top down.
  const shakeY = -(w.shakeBase + w.cropTop);
  return {
    sx: (x) => x - camLeft,
    // The ground line, minus the camera's vertical follow.
    sy: (y) => w.groundY + y - w.camera.y + shakeY,
  };
}

export function drawScene(r: Renderer, w: World, opts: SceneOptions = {}): void {
  const { sx, sy } = stageToScreen(w);

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
  const dimOf = (owner: Player | undefined): [number, number, number] | undefined =>
    pauser && owner !== pauser ? DARKEN_PLAYER : undefined;
  const tinted = (t: [number, number, number] | undefined, f: () => void) => {
    r.tint = t;
    f();
    r.tint = undefined;
  };
  // The stage's palette group: dimmed like the rest, with its BGPalFX.
  const stageLayer = (f: () => void) => {
    r.groupFx = palFxUniforms(w.bgPalFx);
    tinted(dimBg, f);
    r.groupFx = undefined;
  };
  if (!env) {
    // Game_Draw: AssertSpecial nobg leaves the cleared screen, globalnoshadow no shadows.
    if (!w.globalFlag('nobg')) stageLayer(() => opts.background?.());
  }
  // Fight_DrawHud(0): in front of the background, behind the players.
  opts.hud?.(0);
  if (!env) {
    if (!w.globalFlag('globalnoshadow')) drawShadows(r, w, sx, sy);
  } else if (env.time > 0 && env.under) envFill();

  const list: Drawable[] = [];
  const top: Drawable[] = [];
  let order = 0;
  const sprite = (
    s: Sprite | undefined,
    palette: Uint8Array | undefined,
    x: number,
    y: number,
    scaleX: number,
    scaleY: number,
    angle: number,
    blend: Blend,
    palfx?: PalFx,
  ) => {
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
    if (pr.phase === 'dead') continue;
    list.push({
      priority: pr.sprPriority,
      order: order++,
      draw: () =>
        tinted(dimOf(pr.owner), () => {
          const v = pr.anim.view();
          if (!v || v.element.group < 0) return;
          const o = pr.owner;
          const s = o.prog.data.sff.get(v.element.group, v.element.number);
          sprite(
            s,
            s ? o.prog.data.paletteFor(s, o.palRemap ?? o.palNo) : undefined,
            sx(pr.x + pr.facing * v.x * pr.scale[0]),
            sy(pr.y + v.y * pr.scale[1]),
            pr.facing * (v.element.flipH ? -1 : 1) * v.scaleX * pr.scale[0],
            (v.element.flipV ? -1 : 1) * v.scaleY * pr.scale[1],
            pr.facing * v.angle,
            v.blend,
            palFxUniforms(o.palFx),
          );
        }),
    });
  }

  for (const e of w.explods) {
    const d: Drawable = {
      priority: e.sprPriority,
      order: order++,
      draw: () => tinted(e.common ? dimBg : dimOf(e.owner), () => drawExplod(e)),
    };
    // explod.c: only ontop leaves the sprite queue; a screen-space explod sorts by priority too.
    if (e.onTop) top.push(d);
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
        draw: () =>
          tinted(dimOf(p), () =>
            sprite(f.sprite, f.palette, sx(f.x), sy(f.y), f.scaleX, f.scaleY, f.angle, p.afterImage.blend, {
              add: ai.add,
              mul: ai.mul,
              color: ai.color,
              invertAll: ai.invertAll,
            }),
          ),
      });
    }
  }

  list.sort((a, b) => a.priority - b.priority || b.order - a.order);
  for (const d of list) d.draw();
  opts.hud?.(1);
  if (!w.globalFlag('nofg')) stageLayer(() => opts.foreground?.());
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
      // Player_Draw: a player shaking from a hit moves a 320th of the screen on odd ticks.
      sx(
        p.clsnX +
          p.facing * v.x * k * ownerAnimScale(p)[0] +
          (p.moveType === 'h' && p.ghv.hitshaketime > 0 ? (w.screenWidth / 320) * (p.time % 2) * p.facing : 0),
      ),
      sy(p.clsnY + v.y * k * ownerAnimScale(p)[1]),
      p.facing * (v.element.flipH ? -1 : 1) * v.scaleX * p.drawScale[0] * p.const('size.xscale') * k,
      (v.element.flipV ? -1 : 1) * v.scaleY * p.drawScale[1] * p.const('size.yscale') * k,
      p.facing * angle,
      p.trans ?? v.blend,
      fx,
    );
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
    sprite(
      s,
      palette,
      x + e.facing * v.x * k * e.scale[0],
      y + e.vfacing * v.y * k * e.scale[1],
      e.facing * (v.element.flipH ? -1 : 1) * v.scaleX * e.scale[0] * k,
      e.vfacing * (v.element.flipV ? -1 : 1) * v.scaleY * e.scale[1] * k,
      e.facing * (v.angle + e.angle),
      e.trans ?? v.blend,
      fx,
    );
  }
}

/**
 * Player_Draw: an element of the custom state owner's AIR has its offset in
 * the owner's scale (the sprite itself stays in the player's).
 */
function ownerAnimScale(p: Player): [number, number] {
  const o = p.animProg;
  if (!o || o === p.prog || !p.stateOwner) return [1, 1];
  const ro = p.world.localWidth / (o.data.def.localCoord[0] || 320);
  const f = (name: string) => Math.fround((o.consts.get(name) ?? 1) * ro) / Math.fround(p.const(name) * p.scale);
  return [f('size.xscale'), f('size.yscale')];
}

interface ShadowCaster {
  sprite: Sprite;
  palette: Uint8Array | undefined;
  /** Screen position of the sprite's axis. */
  x: number;
  y: number;
  /** Screen y of the floor line the sprite is mirrored about. */
  top: number;
  /** World height, for the shadow's fade.range. */
  height: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  /** The animation element's own transparency. */
  blend: Blend;
  palfx: PalFx | undefined;
}

/**
 * Shadow_Draw: the reflection (mirrored about the floor line) and the shadow
 * (squashed by -yscale, solid black: [Shadow] color is parsed but unused,
 * xshear is not supported as no stage in the reference tree has it). Both
 * inherit the element's transparency: a sprite adding fully to the background
 * casts no shadow.
 */
function castShadow(r: Renderer, w: World, c: ShadowCaster): void {
  const ty = c.top - c.y;
  const refl = w.reflection;
  const add = c.blend.kind === 'add' ? c.blend : undefined;
  if (refl > 0) {
    const src = refl / 256;
    const dst = 1 - src;
    r.draw({
      sprite: c.sprite,
      palette: c.palette,
      x: c.x,
      y: c.top + ty,
      scaleX: c.scaleX,
      scaleY: -c.scaleY,
      angle: c.angle,
      palfx: c.palfx,
      blend: { kind: 'add', src: 256 * (add ? src * (add.src / 256) : src), dst: 256 * (add ? dst + (1 - dst) * (add.dst / 256) : dst) },
    });
  }
  const sh = w.shadow;
  if (!sh) return;
  const elemDst = add ? add.dst / 256 : c.blend.kind === 'sub' ? 1 : 0;
  let alpha = (1 - elemDst) * (sh.intensity / 256);
  const [lo, hi] = sh.fadeRange;
  if (lo < hi) {
    if (lo >= c.height) return;
    if (hi > c.height) alpha = (alpha * (c.height - lo)) / (hi - lo);
  }
  if (alpha <= 0) return;
  r.draw({
    sprite: c.sprite,
    palette: c.palette,
    x: c.x,
    y: c.top + ty * sh.yscale,
    scaleX: c.scaleX,
    scaleY: -sh.yscale * c.scaleY,
    angle: c.angle,
    palfx: { add: [0, 0, 0], mul: [0, 0, 0], color: 1, invertAll: false },
    blend: { kind: 'add', src: alpha * 256, dst: (1 - alpha) * 256 },
  });
}

/** Game_Draw: the shadows of the players, the projectiles (both last to first) and the explods. */
function drawShadows(r: Renderer, w: World, sx: (x: number) => number, sy: (y: number) => number): void {
  const players = [...w.allPlayers()].reverse();
  for (const p of players) {
    if (p.special.has('invisible') || p.special.has('noshadow')) continue;
    const v = p.anim.view();
    if (!v || v.element.group < 0) continue;
    const s = p.prog.data.sff.get(v.element.group, v.element.number);
    if (!s) continue;
    // The floor line includes the character's [Size] shadowoffset.
    const k = p.scale;
    castShadow(r, w, {
      sprite: s,
      palette: p.prog.data.paletteFor(s, p.palRemap ?? p.palNo),
      x: sx(p.clsnX + p.facing * v.x * k * ownerAnimScale(p)[0]),
      y: sy(p.clsnY + v.y * k * ownerAnimScale(p)[1]),
      top: sy(p.const('size.shadowoffset') * k),
      height: p.pos.y,
      scaleX: p.facing * (v.element.flipH ? -1 : 1) * v.scaleX * p.drawScale[0] * p.const('size.xscale') * k,
      scaleY: (v.element.flipV ? -1 : 1) * v.scaleY * p.drawScale[1] * p.const('size.yscale') * k,
      angle: p.facing * (p.angleDraw ? p.angle : v.angle),
      blend: v.blend,
      palfx: palFxUniforms(p.palFx),
    });
  }
  for (const owner of players) {
    for (const pr of w.projectiles) {
      if (pr.owner !== owner || !pr.shadow || pr.phase === 'dead') continue;
      const v = pr.anim.view();
      if (!v || v.element.group < 0) continue;
      const s = owner.prog.data.sff.get(v.element.group, v.element.number);
      if (!s) continue;
      castShadow(r, w, {
        sprite: s,
        palette: owner.prog.data.paletteFor(s, owner.palRemap ?? owner.palNo),
        x: sx(pr.x + pr.facing * v.x * pr.scale[0]),
        y: sy(pr.y + v.y * pr.scale[1]),
        top: sy(0),
        height: pr.y,
        scaleX: pr.facing * (v.element.flipH ? -1 : 1) * v.scaleX * pr.scale[0],
        scaleY: (v.element.flipV ? -1 : 1) * v.scaleY * pr.scale[1],
        angle: pr.facing * v.angle,
        blend: v.blend,
        palfx: palFxUniforms(owner.palFx),
      });
    }
  }
  for (const e of w.explods) {
    if (!e.shadow) continue;
    const v = e.anim.view();
    if (!v || v.element.group < 0) continue;
    const sff = e.common ? w.fightFx?.sff : e.owner.prog.data.sff;
    const s = sff?.get(v.element.group, v.element.number);
    if (!s || !sff) continue;
    const k = e.drawScale;
    castShadow(r, w, {
      sprite: s,
      palette: e.common ? sff.palettes[s.palette] : e.owner.prog.data.paletteFor(s, e.owner.palRemap ?? e.owner.palNo),
      x: (e.space === 'screen' ? e.x : sx(e.x)) + e.facing * v.x * k * e.scale[0],
      y: (e.space === 'screen' ? e.y : sy(e.y)) + e.vfacing * v.y * k * e.scale[1],
      top: sy(0),
      height: e.y,
      scaleX: e.facing * (v.element.flipH ? -1 : 1) * v.scaleX * e.scale[0] * k,
      scaleY: e.vfacing * (v.element.flipV ? -1 : 1) * v.scaleY * e.scale[1] * k,
      angle: e.facing * (v.angle + e.angle),
      blend: v.blend,
      palfx: e.ownPal ? undefined : palFxUniforms(e.owner.palFx),
    });
  }
}
