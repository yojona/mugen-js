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
import { drawScene } from '../render/scene';
import { drawStageLayer } from '../render/stage-draw';
import { loadStage, StageRuntime } from '../stage/stage';
import { Match } from '../engine/match';
import { FightHud } from '../motif/fight';

const KEYS: Record<string, number> = {
  ArrowUp: IN_U, ArrowDown: IN_D, ArrowLeft: IN_L, ArrowRight: IN_R,
  KeyA: IN_X, KeyS: IN_Y, KeyD: IN_Z, KeyZ: IN_A, KeyX: IN_B, KeyC: IN_C, Enter: IN_S,
};
// Second player (match mode): I J K L to move, U O P / M , . buttons.
const KEYS2: Record<string, number> = {
  KeyI: IN_U, KeyK: IN_D, KeyJ: IN_L, KeyL: IN_R,
  KeyU: IN_X, KeyO: IN_Y, KeyP: IN_Z, KeyM: IN_A, Comma: IN_B, Period: IN_C,
};
let held = 0;
let held2 = 0;
addEventListener('keydown', (e) => {
  const b = KEYS2[e.code];
  if (b) {
    held2 |= b;
    e.preventDefault();
  }
});
addEventListener('keyup', (e) => {
  const b = KEYS2[e.code];
  if (b) held2 &= ~b;
});
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
const stageParam = new URLSearchParams(location.search).get('stage') ?? 'stages/kfm.def';
const stage = await loadStage(vfs, stageParam);
const bg = new StageRuntime(stage);
const world = new World();
world.applyStage(stage.info);
const p1 = new Player(prog, world, 0);
const p2 = new Player(prog, world, 1);
p1.pos.x = stage.info.p1.x;
p1.pos.y = stage.info.p1.y;
p1.facing = stage.info.p1.facing;
p2.pos.x = stage.info.p2.x;
p2.pos.y = stage.info.p2.y;
p2.facing = stage.info.p2.facing;
p2.palNo = 2;
world.players.push(p1, p2);
world.fightFx = {
  anims: parseAir(await vfs.text('data/fightfx.air')),
  sff: await parseSff(await vfs.read('data/fightfx.sff')),
};
const commonSnd = parseSnd(await vfs.read('data/common.snd'));
const isMatch = new URLSearchParams(location.search).get('mode') === 'match';
const hud = isMatch ? await FightHud.load(vfs) : undefined;
const match = hud
  ? new Match(world, hud.roundConfig(), [
      { x: stage.info.p1.x, y: stage.info.p1.y, facing: stage.info.p1.facing },
      { x: stage.info.p2.x, y: stage.info.p2.y, facing: stage.info.p2.facing },
    ])
  : undefined;
if (isMatch) document.querySelector('h1')!.textContent = 'Partida';

/** One simulation tick (match flow, world, stage, HUD). */
function step(in1: number, in2: number): void {
  const simulate = match ? match.tick() : true;
  if (simulate) {
    world.tick([in1, in2]);
    if (!world.superPause && !world.pause) bg.tick();
  }
  if (match && hud) {
    hud.tick(match);
    for (const [g, n] of match.sounds) mixer.play(hud.snd?.get(g, n));
  }
}
p1.changeState(0);
p2.changeState(0);

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
  renderer.clear(0, 0, 0);
  const W = world.screenWidth;
  const H = world.screenHeight;
  drawScene(renderer, world, {
    clsn: clsn.checked,
    background: () => drawStageLayer(renderer, bg, world.camera, 0, W, H),
    foreground: () => drawStageLayer(renderer, bg, world.camera, 1, W, H),
  });
  if (match && hud) hud.draw(renderer, match);
  else drawLifebars();
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

// ?demo=<script>:<ticks>: scripted inputs for headless checks.
const demoParam = new URLSearchParams(location.search).get('demo');
if (demoParam) {
  const [name, ticks] = demoParam.includes(':') ? demoParam.split(':') : ['palm', demoParam];
  const scripts: Record<string, number[]> = {
    palm: [...Array(40).fill(IN_R), 0, IN_D, IN_D | IN_R, IN_R, IN_R | IN_X],
    super: [...Array(40).fill(IN_R), 0, IN_D, IN_D | IN_R, IN_R, 0, IN_D, IN_D | IN_R, IN_R, IN_R | IN_X],
    throw: [...Array(48).fill(IN_R), IN_R | IN_Y],
  };
  if (name === 'super') p1.power = 3000;
  // In match mode, scripts start once the round is under way.
  if (match) {
    for (let i = 0; i < 600 && world.roundState !== 2; i++) step(0, 0);
    const lowLife = new URLSearchParams(location.search).get('p2life');
    if (lowLife) p2.life = parseInt(lowLife, 10);
  }
  const script = scripts[name!] ?? [];
  for (let i = 0; i < parseInt(ticks!, 10); i++) step(script[i] ?? 0, 0);
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
    step(held, isMatch ? held2 : 0);
    acc -= TICK;
  }
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
