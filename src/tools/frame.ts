// Development page: a CPU match played to a frame and drawn at 640x480, to
// compare with a mugen.exe screenshot of the same frame (tools/harness SHOTS).
// ?c1=&c2=&frame=N[&seed=16808][&stage=stages/kfm.def]  -> window.__done
import { withContentFixes } from '../engine/content-fixes';
import { Mixer } from '../audio/mixer';
import { loadCharacter } from '../engine/character';
import { loadProgram } from '../engine/player';
import { httpSource, Vfs } from '../engine/vfs';
import { parseAir } from '../formats/air';
import { parseSff } from '../formats/sff';
import { parseSnd } from '../formats/snd';
import { FightHud } from '../motif/fight';
import { loadMotif } from '../motif/system';
import { Renderer } from '../render/renderer';
import { loadStage } from '../stage/stage';
import { FightScreen } from '../app/fight-screen';
import { Keyboard } from '../app/input';
import type { RosterChar } from '../app/select';

const q = new URLSearchParams(location.search);
const vfs = new Vfs(withContentFixes(await httpSource('/ref/mugen-1.1b1', '/__ref.json')));
// The harness runs mugen.exe with data/system.def.
const motif = await loadMotif(vfs, 'data/system.def');
const renderer = new Renderer(document.getElementById('screen') as HTMLCanvasElement);
const [mw, mh] = motif.localCoord;
renderer.resize(mw, mh, 640 / mw);
const ctx = { renderer, mixer: new Mixer(), keys: new Keyboard(), motif, aiLevel: 4 };
const c1 = q.get('c1') ?? 'kfm';
const c2 = q.get('c2') ?? 'kfm';
const load = async (c: string) => {
  const data = await loadCharacter(vfs, `chars/${c}/${c}.def`);
  return { data, prog: await loadProgram(vfs, data) };
};
const [a, b] = await Promise.all([load(c1), load(c2)]);
const roster = (data: typeof a.data): RosterChar => ({ entry: { def: data.defPath, order: 1, includeStage: true } as never, data, defPath: data.defPath });
const hud = await FightHud.load(vfs, motif.fightDef, mw);
const fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
const commonSnd = await vfs.read('data/common.snd').then(parseSnd).catch(() => undefined);
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
screen.draw();
(window as unknown as { __done: boolean }).__done = true;
