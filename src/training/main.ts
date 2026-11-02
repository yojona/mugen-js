// Training mode: P1 on keyboard vs an idle P2, rendered with the real engine.

import { loadCharacter } from '../engine/character';
import { IN_A, IN_B, IN_C, IN_D, IN_L, IN_R, IN_S, IN_U, IN_X, IN_Y, IN_Z } from '../engine/cmd';
import { loadProgram, Player } from '../engine/player';
import { httpSource, Vfs } from '../engine/vfs';
import { World } from '../engine/world';
import { Mixer } from '../audio/mixer';
import { parseAir } from '../formats/air';
import { parseSff } from '../formats/sff';
import { parseSnd } from '../formats/snd';
import { Renderer } from '../render/renderer';

const KEYS: Record<string, number> = {
  ArrowUp: IN_U, ArrowDown: IN_D, ArrowLeft: IN_L, ArrowRight: IN_R,
  KeyA: IN_X, KeyS: IN_Y, KeyD: IN_Z, KeyZ: IN_A, KeyX: IN_B, KeyC: IN_C, Enter: IN_S,
};
let held = 0;
const mixer = new Mixer();
addEventListener('keydown', (e) => {
  mixer.unlock();
  const b = KEYS[e.code];
  if (b) {
    held |= b;
    e.preventDefault();
  }
});
addEventListener('keyup', (e) => {
  const b = KEYS[e.code];
  if (b) held &= ~b;
});
addEventListener('blur', () => (held = 0));

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const info = document.getElementById('info')!;
const clsn = document.getElementById('clsn') as HTMLInputElement;
const renderer = new Renderer(canvas);
renderer.resize(320, 240, 2);

const vfs = new Vfs(await httpSource('/ref/mugen-1.1b1', '/__ref.json'));
const prog = await loadProgram(vfs, await loadCharacter(vfs, 'chars/kfm/kfm.def'));
const world = new World();
const p1 = new Player(prog, world, 0);
const p2 = new Player(prog, world, 1);
p1.pos.x = -70;
p2.pos.x = 70;
p2.facing = -1;
p2.palNo = 2;
world.players.push(p1, p2);
world.fightFx = {
  anims: parseAir(await vfs.text('data/fightfx.air')),
  sff: await parseSff(await vfs.read('data/fightfx.sff')),
};
const commonSnd = parseSnd(await vfs.read('data/common.snd'));
p1.changeState(0);
p2.changeState(0);

function drawPlayer(p: Player): void {
  const v = p.anim.view();
  if (!v || v.element.group < 0) return;
  const sprite = p.prog.data.sff.get(v.element.group, v.element.number);
  if (!sprite) return;
  const sx = p.pos.x - (world.camera.x - world.screenWidth / 2);
  const sy = world.groundY + p.pos.y;
  renderer.draw({
    sprite,
    palette: p.prog.data.paletteFor(sprite, p.palNo),
    x: sx + p.facing * v.x,
    y: sy + v.y,
    scaleX: p.facing * (v.element.flipH ? -1 : 1) * v.scaleX,
    scaleY: (v.element.flipV ? -1 : 1) * v.scaleY,
    angle: p.facing * v.angle,
    blend: v.blend,
  });
  if (clsn.checked) {
    for (const [list, color] of [[v.element.clsn2, [60, 120, 255, 90]], [v.element.clsn1, [255, 60, 60, 110]]] as const) {
      for (const b of list ?? []) renderer.rect(sx + p.facing * b.x1, sy + b.y1, sx + p.facing * b.x2, sy + b.y2, [...color]);
    }
  }
}

function drawEffects(): void {
  for (const e of world.effects) {
    const v = e.anim.view();
    if (!v || v.element.group < 0) continue;
    const sff = e.owner ? e.owner.prog.data.sff : world.fightFx?.sff;
    const sprite = sff?.get(v.element.group, v.element.number);
    if (!sprite || !sff) continue;
    const palette = e.owner ? e.owner.prog.data.paletteFor(sprite, e.owner.palNo) : sff.palettes[sprite.palette];
    renderer.draw({
      sprite,
      palette,
      x: e.x - (world.camera.x - world.screenWidth / 2) + e.facing * v.x,
      y: world.groundY + e.y + v.y,
      scaleX: e.facing * (v.element.flipH ? -1 : 1) * v.scaleX,
      scaleY: (v.element.flipV ? -1 : 1) * v.scaleY,
      angle: e.facing * v.angle,
      blend: v.blend,
    });
  }
}

function drawLifebars(): void {
  const w = 120;
  for (const [i, p] of world.players.entries()) {
    const x = i === 0 ? 12 : 320 - 12 - w;
    renderer.rect(x - 1, 9, x + w + 1, 17, [20, 20, 24, 255]);
    const fill = Math.max(0, p.life / p.const('data.life')) * w;
    if (i === 0) renderer.rect(x + w - fill, 10, x + w, 16, [240, 200, 40, 255]);
    else renderer.rect(x, 10, x + fill, 16, [240, 200, 40, 255]);
  }
}

function playSounds(): void {
  for (const s of world.sounds) {
    const snd = s.owner ? s.owner.prog.data.snd : commonSnd;
    mixer.play(snd?.get(s.group, s.number));
  }
  world.sounds.length = 0;
}

function draw(): void {
  renderer.clear(0.24, 0.3, 0.42);
  renderer.rect(0, world.groundY, 320, 240, [70, 64, 58, 255]);
  const order = [...world.players].sort((a, b) => a.sprPriority - b.sprPriority);
  for (const p of order) drawPlayer(p);
  drawEffects();
  drawLifebars();
  playSounds();
  const f = (n: number) => n.toFixed(2);
  info.textContent = [
    `Estado ${p1.stateNo} (anterior ${p1.prevStateNo}) / tiempo ${p1.time}`,
    `Animación ${p1.animNo} / elemento ${p1.anim.elem + 1} / AnimTime ${p1.anim.animTime()}`,
    `Tipo ${p1.stateType.toUpperCase()} / movimiento ${p1.moveType.toUpperCase()} / física ${p1.physics.toUpperCase()} / control ${p1.ctrl ? 'sí' : 'no'}`,
    `Posición ${f(p1.pos.x)}, ${f(p1.pos.y)}`,
    `Velocidad ${f(p1.vel.x)}, ${f(p1.vel.y)}`,
    `Comandos: ${[...p1.commands].join(', ') || 'ninguno'}`,
    `Vida P1 ${p1.life} / P2 ${p2.life} / Poder P1 ${p1.power}`,
    `Rival: estado ${p2.stateNo} / ${p2.moveType === 'h' ? 'recibiendo golpe' : 'libre'}`,
    p1.warnings.length ? `Avisos: ${p1.warnings.slice(-3).join(' / ')}` : '',
  ].join('\n');
}

// ?demo=<ticks>: scripted inputs for headless checks (walk, then QCF + x).
const demo = new URLSearchParams(location.search).get('demo');
if (demo) {
  const script = [...Array(40).fill(IN_R), 0, IN_D, IN_D | IN_R, IN_R, IN_R | IN_X, ...Array(9).fill(0)];
  const stop = parseInt(demo, 10);
  for (let i = 0; i < stop; i++) world.tick([script[i] ?? 0, 0]);
  draw();
  throw new Error('demo');
}

const TICK = 1000 / 60;
let acc = 0;
let last = performance.now();
function frame(now: number): void {
  acc += Math.min(now - last, 250);
  last = now;
  while (acc >= TICK) {
    world.tick([held, 0]);
    acc -= TICK;
  }
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
