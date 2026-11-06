// A page embedding the engine: all it needs is a canvas and the MUGEN files.

import { createEngine, httpSource, type DummySettings, type LoadProgress } from '../src/index';

const status = document.getElementById('status')!;
const help = document.getElementById('help')!;
const keyHelp = help.textContent ?? '';

const PHASES: Record<LoadProgress['phase'], string> = { motif: 'motif', characters: 'personajes', hud: 'HUD', loading: 'partida' };

function showProgress(p: LoadProgress | undefined): void {
  if (!p) {
    status.textContent = '';
    return;
  }
  const count = p.phase === 'characters' && p.done !== undefined ? ` ${p.done}/${p.total}` : '';
  status.textContent = `Cargando ${PHASES[p.phase]}…${count}`;
}

/** The key help, or the training dummy's settings while it runs. */
function showDummy(d: DummySettings | undefined): void {
  if (!d) {
    help.textContent = keyHelp;
    return;
  }
  const stance = ['de pie', 'agachado', 'salta', 'salta seguido'][d.stance];
  const button = d.button ? 'abcxyzs'[d.button - 1] : 'ninguno';
  help.textContent = `Entrenamiento: 1 postura (${stance}) / 2 bloqueo (${d.guard ? 'sí' : 'no'}) / 3 distancia (${d.distance || 'libre'}) / 4 alejarse (${d.jumpDistance || 'no'}) / 5 botón (${button}) / Esc volver`;
}

status.textContent = 'Cargando archivos…';
const engine = await createEngine({
  canvas: document.getElementById('screen') as HTMLCanvasElement,
  source: await httpSource('/ref/mugen-1.1b1', '/__ref.json'),
  onProgress: showProgress,
  onTrainingDummy: showDummy,
  onExit: () => location.reload(),
});
engine.start();
