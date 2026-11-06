// The page: the engine on #screen, its options from the URL.

import type { DummySettings } from '../src/engine/ai';
import { httpSource } from '../src/engine/vfs';
import { createEngine } from '../src/index';
import { makeHarness } from './harness';

const params = new URLSearchParams(location.search);
const status = document.getElementById('status')!;
const setStatus = (t: string) => (status.textContent = t);

setStatus('Cargando archivos…');
const rawSource = await httpSource('/ref/mugen-1.1b1', '/__ref.json');
// ?selectb64=: a select.def (base64) in place of data/select.def, e.g. the
// flow harness's roster (tools/harness/overlay/data/select.def).
const selectB64 = params.get('selectb64');
const source: typeof rawSource = selectB64
  ? {
      ...rawSource,
      list: () => rawSource.list(),
      readRange: rawSource.readRange?.bind(rawSource),
      read: async (path) => (path.toLowerCase() === 'data/select.def' ? Uint8Array.from(atob(selectB64), (c) => c.charCodeAt(0)) : rawSource.read(path)),
    }
  : rawSource;

/** The key help, or the training dummy's settings while it runs. */
const help = document.getElementById('help')!;
const keyHelp = help.textContent ?? '';
function showDummy(d: DummySettings | undefined): void {
  if (!d) {
    help.textContent = keyHelp;
    return;
  }
  const stance = ['de pie', 'agachado', 'salta', 'salta seguido'][d.stance];
  const button = d.button ? 'abcxyzs'[d.button - 1] : 'ninguno';
  help.textContent = `Entrenamiento: 1 postura (${stance}) / 2 bloqueo (${d.guard ? 'sí' : 'no'}) / 3 distancia (${d.distance || 'libre'}) / 4 alejarse (${d.jumpDistance || 'no'}) / 5 botón (${button}) / Esc volver`;
}

const ticksParam = params.get('ticks');
const engine = await createEngine({
  canvas: document.getElementById('screen') as HTMLCanvasElement,
  source,
  motif: params.get('motif') ?? undefined,
  zoom: Number(params.get('zoom')) || undefined,
  // The flow harness compares against a fresh mugen.cfg.
  storage: params.get('flowlog') ? null : undefined,
  sessionSeed: parseInt(params.get('sessionseed') ?? '', 10) || undefined,
  // ?pristine=1: harness comparisons with mugen.exe.
  contentFixes: !params.get('pristine'),
  keysFromCfg: params.has('cfgkeys'),
  noTtf: !!params.get('nottf'),
  onProgress: (p) => {
    if (!p) return setStatus('');
    const count = p.phase === 'characters' && p.done !== undefined ? ` ${p.done}/${p.total}` : '';
    setStatus(`Cargando ${{ motif: 'motif', characters: 'personajes', hud: 'HUD', loading: '' }[p.phase]}…${count}`.replace(' …', '…'));
  },
  onTrainingDummy: showDummy,
  // The page starts afresh.
  onExit: () => location.reload(),
  manual: !!ticksParam,
});
engine.hooks = makeHarness(engine, params);
// ?debug: the engine for the browser console.
if (params.has('debug')) (globalThis as unknown as { mugenEngine: typeof engine }).mugenEngine = engine;

engine.start();

if (ticksParam) {
  // Headless: advance a fixed number of ticks, yielding between ticks so screen
  // transitions (promises) settle exactly as they do in real time; then draw.
  const target = parseInt(ticksParam, 10);
  void (async () => {
    for (let done = 0; done < target; ) {
      if (engine.busy) {
        await new Promise((r) => setTimeout(r, 0));
        continue;
      }
      engine.step();
      done++;
      await Promise.resolve();
      await Promise.resolve();
    }
    engine.screen.draw();
    document.title = 'listo';
  })();
}
