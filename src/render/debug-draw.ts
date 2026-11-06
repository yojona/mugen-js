// The collision display of mugen.exe's debug mode (Ctrl+C): Player_DrawDebug,
// Projectile_DrawClsn and Clsn_Draw, drawn in game pixels over the fight.

import type { Clsn } from '../formats/air';
import type { Player } from '../engine/player';
import type { World } from '../engine/world';
import { drawText, fontColor } from '../motif/element';
import type { Font } from '../motif/font';
import type { DrawBlend, Renderer } from './renderer';
import { stageToScreen } from './scene';

type Rgb = [number, number, number];

const ADD: DrawBlend = { kind: 'add', src: 256, dst: 256 };
const SUB: DrawBlend = { kind: 'sub' };

/** Video_MapRGB and the alpha a solid rectangle wants. */
function solid(c: Rgb): [number, number, number, number] {
  return [c[0], c[1], c[2], 255];
}

/** An outline over the inclusive box, each corner once: additive colours must not add up twice. */
function outline(r: Renderer, x1: number, y1: number, x2: number, y2: number, c: Rgb, blend: DrawBlend): void {
  const color = solid(c);
  r.rect(x1, y1, x2 + 1, y1 + 1, color, blend);
  if (y2 > y1) r.rect(x1, y2, x2 + 1, y2 + 1, color, blend);
  if (y2 - y1 > 1) {
    r.rect(x1, y1 + 1, x1 + 1, y2, color, blend);
    if (x2 > x1) r.rect(x2, y1 + 1, x2 + 1, y2, color, blend);
  }
}

/** Clsn_Draw: every box's outline darkened by 0x20, then drawn over, or the box filled in mode 2. */
function drawBoxes(r: Renderer, boxes: readonly Clsn[] | null, x: number, y: number, scaleX: number, scaleY: number, facing: number, color: Rgb, filled: boolean): void {
  if (!boxes || scaleX === 0 || scaleY === 0) return;
  for (const b of boxes) {
    const xa = Math.trunc(b.x1 * scaleX * facing + x);
    const ya = Math.trunc(b.y1 * scaleY + y);
    const xb = Math.trunc(b.x2 * scaleX * facing + x);
    const yb = Math.trunc(b.y2 * scaleY + y);
    const [x1, x2] = xa < xb ? [xa, xb] : [xb, xa];
    const [y1, y2] = ya < yb ? [ya, yb] : [yb, ya];
    outline(r, x1, y1, x2, y2, [0x20, 0x20, 0x20], SUB);
    if (filled) r.rect(x1, y1, x2 + 1, y2 + 1, solid(color), ADD);
    else outline(r, x1, y1, x2, y2, color, ADD);
  }
}

/** "SCA|NSH|NSH|NSH": the attributes the player can be hit by; a blank where not. */
function hitByText(m: number): string {
  const bits = 'SCANSHNSHNSH';
  let s = '';
  for (let i = 0; i < 12; i++) {
    if (i === 3 || i === 6 || i === 9) s += '|';
    s += m & (1 << i) ? ' ' : bits[i];
  }
  return s;
}

function drawPlayer(r: Renderer, w: World, p: Player, x: number, y: number, zoom: number, mode: number, font: Font | undefined): void {
  const v = p.anim.view();
  if (!v) return;
  const filled = mode === 2;
  let m = 0xfff;
  for (const slot of p.hitBy) if (slot) m &= slot.mask;
  const muteki = (m & 7) === 0 || p.nohitTime > 0 || (m & 0xff8) === 0;
  let clsn2: Rgb = [0, 0, 0xff];
  if (m !== 0xfff || muteki) {
    if (font) drawText(r, font, muteki ? 'MUTEKI' : hitByText(m), x - 0x1c, y - 2, 0, 1, [1, 1], fontColor(0x100, 0x100, 0xd4));
    clsn2 = [0, 0x7f, 0x7f];
  } else if (p.inGuardDist()) {
    clsn2 = [0x40, 0, 0xc0];
  }
  drawBoxes(r, v.element.clsn2, x, y, zoom, zoom, p.facing, clsn2, filled);
  drawBoxes(r, v.element.clsn1, x, y, zoom, zoom, p.facing, [0xff, 0, 0], filled);
  // The axis.
  const axis = solid([0xc0, 0, 0]);
  r.rect(x - 1, y, x + 2, y + 1, axis);
  r.rect(x, y - 1, x + 1, y + 2, axis);
  // The widths: the body's (ground or air) and the Width controller's edges.
  const air = p.stateType === 'a' ? 'air' : 'ground';
  const back = p.const(`size.${air}.back`);
  const front = p.const(`size.${air}.front`);
  const [edgeFront, edgeBack] = p.width.edge ?? [0, 0];
  const [playerFront, playerBack] = p.width.player ?? [0, 0];
  const right1 = p.facing === 1;
  const left = right1 ? edgeBack + back : edgeFront + front;
  const wl = right1 ? back + playerBack : front + playerFront;
  const right = right1 ? edgeFront + front : edgeBack + back;
  const wr = right1 ? front + playerFront : back + playerBack;
  const ratio = w.gameWidth / (p.prog.data.def.localCoord[0] || 320);
  const ia = Math.trunc(wl * ratio);
  const ib = Math.trunc(ratio * wr);
  const xl = x - ia;
  const xr = ib + x;
  const body = solid([0x40, 0x7f, 0]);
  const edge = solid([0x7f, 0x40, 0]);
  r.rect(xl, y, xr + 1, y + 1, body, ADD);
  r.rect(xl, y - 1, xl + 1, y + 2, body, ADD);
  r.rect(xr, y - 1, xr + 1, y + 2, body, ADD);
  if (left !== ia) r.rect(x - left, y - 1, x - left + 1, y + 2, edge, ADD);
  if (right !== ib) r.rect(right + x, y - 1, right + x + 1, y + 2, edge, ADD);
  if (left > ia) r.rect(x - left, y, xl + 1, y + 1, edge, ADD);
  if (right > ib) r.rect(xr, y, right + x + 1, y + 1, edge, ADD);
  if (!font) return;
  // The name, the id and whether a HitDef is active.
  drawText(r, font, `${p.name}, ${p.id}${p.hitDefActive ? ' H' : ''}`, x - 0x14, y + 6, 0, 1);
  if (p.targets.size > 0) {
    const targets = [...p.targets.keys()].map((t) => `${t.id} ${p.targetJuggle.get(t) ?? 0}`);
    drawText(r, font, `Target ${targets.join(', ')}`, x - 0x14, y + 0xc, 0, 1, [1, 1], fontColor(0x100, 0xc0, 0x100));
  }
}

/** Game_Draw with clsn_draw_mode set (1 outlines, 2 filled): the players last to first, then the projectiles. */
export function drawCollisionDebug(r: Renderer, w: World, mode: number, font?: Font): void {
  const view = r.view;
  const k = w.gameWidth / w.screenWidth;
  const { sx, sy } = stageToScreen(w);
  const px = (x: number) => Math.trunc((view.ox + view.s * sx(x)) * k);
  const py = (y: number) => Math.trunc((view.oy + view.s * sy(y)) * k);
  r.view = { s: 1, ox: 0, oy: 0 };
  r.setProjection(w.gameWidth, w.screenHeight * k);
  const players = w.allPlayers();
  for (let i = players.length - 1; i >= 0; i--) {
    const p = players[i]!;
    drawPlayer(r, w, p, px(p.clsnX), py(p.clsnY), p.scale * k * view.s, mode, font);
  }
  for (const pr of w.projectiles) {
    const v = pr.anim.view();
    if (!v || pr.phase === 'dead') continue;
    const zoom = pr.owner.scale * k * view.s;
    const [sxs, sys] = pr.clsnScale;
    drawBoxes(r, v.element.clsn2, px(pr.x), py(pr.y), sxs * zoom, sys * zoom, pr.facing, [0, 0, 0xff], mode === 2);
    drawBoxes(r, v.element.clsn1, px(pr.x), py(pr.y), sxs * zoom, sys * zoom, pr.facing, [0xff, 0, 0], mode === 2);
  }
  r.view = view;
  r.setProjection(w.screenWidth, w.screenHeight);
}
