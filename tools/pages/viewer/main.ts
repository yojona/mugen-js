// Character viewer: plays AIR actions with the real palette pipeline.

import { withContentFixes } from '../../../src/engine/content-fixes';
import { AnimPlayer } from '../../../src/engine/anim';
import { loadCharacter, type CharacterData } from '../../../src/engine/character';
import { httpSource, Vfs } from '../../../src/engine/vfs';
import { Renderer } from '../../../src/render/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  title: $('title'),
  char: $<HTMLSelectElement>('char'),
  action: $<HTMLSelectElement>('action'),
  palette: $<HTMLSelectElement>('palette'),
  zoom: $<HTMLSelectElement>('zoom'),
  flip: $<HTMLInputElement>('flip'),
  clsn: $<HTMLInputElement>('clsn'),
  play: $<HTMLButtonElement>('play'),
  step: $<HTMLButtonElement>('step'),
  prev: $<HTMLButtonElement>('prev'),
  next: $<HTMLButtonElement>('next'),
  info: $('info'),
};

const renderer = new Renderer($<HTMLCanvasElement>('screen'));
const vfs = new Vfs(withContentFixes(await httpSource('/ref/mugen-1.1b1', '/__ref.json')));

let ch: CharacterData | undefined;
let player: AnimPlayer | undefined;
let paused = false;
let palette = 1;

function setup(): void {
  const [w, h] = ch?.def.localCoord ?? [320, 240];
  renderer.resize(w, h, +ui.zoom.value * (320 / w));
}

async function selectChar(defPath: string): Promise<void> {
  ui.title.textContent = 'Cargando…';
  ch = await loadCharacter(vfs, defPath);
  ui.title.textContent = `${ch.def.displayName} (SFF ${ch.sff.versionText})`;
  ui.action.replaceChildren(...[...ch.anims.keys()].sort((a, b) => a - b).map((n) => new Option(String(n), String(n))));
  ui.palette.replaceChildren(...ch.palettes.flatMap((p, i) => (p ? [new Option(String(i + 1), String(i + 1))] : [])));
  palette = ch.def.palDefaults[0] ?? 1;
  ui.palette.value = String(palette);
  setup();
  selectAction(0);
}

function selectAction(n: number): void {
  if (!ch) return;
  const anim = ch.anims.get(n) ?? ch.anims.values().next().value;
  if (!anim) return;
  ui.action.value = String(anim.action);
  player = new AnimPlayer(anim);
}

function draw(): void {
  renderer.clear(0.18, 0.2, 0.26);
  if (!ch || !player) return;
  const W = renderer.width;
  const H = renderer.height;
  const groundY = Math.round(H * 0.85);
  const x = Math.round(W / 2);
  renderer.rect(0, groundY, W, H, [60, 60, 72, 255]);
  const facing = ui.flip.checked ? -1 : 1;
  const v = player.view();
  if (v && v.element.group >= 0) {
    const sprite = ch.sff.get(v.element.group, v.element.number);
    if (sprite) {
      renderer.draw({
        sprite,
        palette: ch.paletteFor(sprite, palette),
        x: x + facing * v.x,
        y: groundY + v.y,
        scaleX: facing * (v.element.flipH ? -1 : 1) * v.scaleX,
        scaleY: (v.element.flipV ? -1 : 1) * v.scaleY,
        angle: facing * v.angle,
        blend: v.blend,
      });
    }
  }
  if (ui.clsn.checked && v) {
    const boxes: [typeof v.element.clsn1, [number, number, number, number]][] = [
      [v.element.clsn2, [60, 120, 255, 90]],
      [v.element.clsn1, [255, 60, 60, 110]],
    ];
    for (const [list, color] of boxes) {
      for (const b of list ?? []) {
        renderer.rect(x + facing * b.x1, groundY + b.y1, x + facing * b.x2, groundY + b.y2, color);
      }
    }
  }
  renderer.rect(x - 2, groundY, x + 3, groundY + 1, [255, 255, 0, 255]);
  const e = player.current;
  ui.info.textContent = [
    `Acción ${player.anim.action} / elemento ${player.elem + 1} de ${player.anim.elements.length}`,
    `Sprite ${e?.group},${e?.number} / ${e?.time} ticks`,
    `Tiempo en elemento ${player.elemTime} / tiempo total ${player.time}`,
    `Duración del ciclo ${player.anim.totalTime < 0 ? 'infinita' : player.anim.totalTime}`,
  ].join('\n');
}

// Fixed 60 Hz simulation, decoupled from display refresh.
const TICK = 1000 / 60;
let acc = 0;
let last = performance.now();
function frame(now: number): void {
  acc += Math.min(now - last, 250);
  last = now;
  while (acc >= TICK) {
    if (!paused) player?.tick();
    acc -= TICK;
  }
  draw();
  requestAnimationFrame(frame);
}

ui.action.onchange = () => selectAction(+ui.action.value);
ui.palette.onchange = () => (palette = +ui.palette.value);
ui.zoom.onchange = setup;
ui.char.onchange = () => void selectChar(ui.char.value);
ui.play.onclick = () => {
  paused = !paused;
  ui.play.textContent = paused ? 'Reanudar' : 'Pausa';
};
ui.step.onclick = () => player?.tick();
const shift = (d: number) => {
  const opts = [...ui.action.options].map((o) => +o.value);
  const i = opts.indexOf(+ui.action.value);
  selectAction(opts[(i + d + opts.length) % opts.length]!);
};
ui.prev.onclick = () => shift(-1);
ui.next.onclick = () => shift(1);

const defs = ((await (await fetch('/__ref.json')).json()) as string[]).filter(
  (p) => /^chars\/[^/]+\/[^/]+\.def$/i.test(p) && !/(intro|ending)\.def$/i.test(p),
);
ui.char.replaceChildren(...defs.map((d) => new Option(d.split('/')[1]!, d)));
await selectChar(defs[0]!);
requestAnimationFrame(frame);
