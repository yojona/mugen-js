// Development page: a CPU match played to a frame and drawn at 640x480, to
// compare with a mugen.exe screenshot of the same frame (tools/harness SHOTS).
// ?c1=&c2=&frame=N[&seed=16808][&stage=stages/kfm.def][&motif=data/system.def][&w=640][&cam=x,y]  -> window.__done
import { withContentFixes } from '../../src/engine/content-fixes';
import { Mixer } from '../../src/audio/mixer';
import { Music } from '../../src/audio/music';
import { loadCharacter } from '../../src/engine/character';
import { loadProgram } from '../../src/engine/player';
import { httpSource, Vfs } from '../../src/engine/vfs';
import { parseAir } from '../../src/formats/air';
import { parseSff } from '../../src/formats/sff';
import { parseSnd } from '../../src/formats/snd';
import { FightHud } from '../../src/motif/fight';
import { loadMotif } from '../../src/motif/system';
import { Renderer } from '../../src/render/renderer';
import { loadStage } from '../../src/stage/stage';
import { FightScreen } from '../../src/app/fight-screen';
import { Keyboard } from '../../src/app/input';
import type { RosterChar } from '../../src/app/select';

const q = new URLSearchParams(location.search);
const vfs = new Vfs(withContentFixes(await httpSource('/ref/mugen-1.1b1', '/__ref.json')));
// The harness runs mugen.exe with data/system.def (MOTIF= picks another).
const motif = await loadMotif(vfs, q.get('motif') ?? 'data/system.def');
const renderer = new Renderer(document.getElementById('screen') as HTMLCanvasElement);
const [mw, mh] = motif.localCoord;
renderer.resize(mw, mh, Number(q.get('w') ?? 640) / mw);
const mixer = new Mixer();
const ctx = { renderer, mixer, music: new Music(mixer, (path) => vfs.read(path)), keys: new Keyboard(), motif, aiLevel: 4 };
const c1 = q.get('c1') ?? 'kfm';
const c2 = q.get('c2') ?? 'kfm';
const load = async (c: string) => {
  const data = await loadCharacter(vfs, `chars/${c}/${c}.def`);
  return { data, prog: await loadProgram(vfs, data) };
};
const [a, b] = await Promise.all([load(c1), load(c2)]);
const roster = (data: typeof a.data): RosterChar => ({
  entry: { def: data.defPath, order: 1, includeStage: true } as never,
  data,
  defPath: data.defPath,
});
const hud = await FightHud.load(vfs, motif.fightDef, mw);
const fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
const commonSnd = await vfs
  .read('data/common.snd')
  .then(parseSnd)
  .catch(() => undefined);
const screen = new FightScreen(ctx, {
  seed: Number(q.get('seed') ?? 16808),
  p1: { char: roster(a.data), pal: 1 },
  p2: { char: roster(b.data), pal: 2 },
  progs: [a.prog, b.prog],
  stage: await loadStage(vfs, q.get('stage') ?? 'stages/kfm.def'),
  hud,
  fightFx,
  commonSnd,
  human: [false, false],
  training: false,
});
const frame = Number(q.get('frame') ?? 1);
for (let i = 1; i <= frame; i++) screen.tick();
const w = screen.world;
const k = w.gameWidth / w.screenWidth;
// cam=x,y: mugen.exe's camera_x / camera_y (the shot's), to compare backgrounds.
const cam = q.get('cam')?.split(',').map(Number);
if (cam) w.camera = { x: cam[0]! / k, y: cam[1]! / k };
screen.draw();
document.title = `cam ${(w.camera.x * k).toFixed(3)} ${(w.camera.y * k).toFixed(3)} ground ${(w.groundY * k).toFixed(1)} sw ${w.screenWidth}x${w.screenHeight}`;
(window as unknown as { __done: boolean }).__done = true;
