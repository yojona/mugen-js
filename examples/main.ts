// A page embedding the engine: all it needs is a canvas and the MUGEN files.

import { createEngine, httpSource, type DummySettings, type LoadProgress } from '../src/index';

const status = document.getElementById('status')!;
const help = document.getElementById('help')!;
const keyHelp = help.textContent ?? '';

const PHASES: Record<LoadProgress['phase'], string> = { motif: 'motif', characters: 'characters', hud: 'HUD', loading: 'match' };

function showProgress(p: LoadProgress | undefined): void {
  if (!p) {
    status.textContent = '';
    return;
  }
  const count = p.phase === 'characters' && p.done !== undefined ? ` ${p.done}/${p.total}` : '';
  status.textContent = `Loading ${PHASES[p.phase]}…${count}`;
}

/** The key help, or the training dummy's settings while it runs. */
function showDummy(d: DummySettings | undefined): void {
  if (!d) {
    help.textContent = keyHelp;
    return;
  }
  const stance = ['standing', 'crouching', 'jumping', 'jumping often'][d.stance];
  const button = d.button ? 'abcxyzs'[d.button - 1] : 'none';
  help.textContent = `Training: 1 stance (${stance}) / 2 guard (${d.guard ? 'yes' : 'no'}) / 3 distance (${d.distance || 'free'}) / 4 back off (${d.jumpDistance || 'no'}) / 5 button (${button}) / Esc back`;
}

status.textContent = 'Loading files…';
const engine = await createEngine({
  canvas: document.getElementById('screen') as HTMLCanvasElement,
  source: await httpSource('/ref/mugen-1.1b1', '/__ref.json'),
  // The dark title screen, whatever mugen.cfg's motif says.
  motif: 'data/system.def',
  onProgress: showProgress,
  onTrainingDummy: showDummy,
  onExit: () => location.reload(),
});
engine.start();
