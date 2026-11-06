// createEngine: the game behind a small API. It takes what it needs from its
// host (canvas, files, storage) and touches nothing else of the page.

import { Mixer } from '../audio/mixer';
import { Music } from '../audio/music';
import type { DummySettings } from '../engine/ai';
import { withContentFixes } from '../engine/content-fixes';
import { Vfs, type FileSource } from '../engine/vfs';
import { findSection, getValue, parseIni } from '../formats/text';
import { loadMotif } from '../motif/system';
import { Renderer } from '../render/renderer';
import { loadFont } from '../motif/font';
import { loadAssets, type LoadProgress } from './assets';
import { DebugMode, readDebugConfig } from './debug';
import { FightScreen } from './fight-screen';
import { createGameFlow } from './flow';
import { GameOptions, type OptionsStorage } from './game-options';
import { Keyboard } from './input';
import type { AppContext, Screen } from './screen';

/** Speedup: the ticks run for this long per animation frame. */
const SPEEDUP_MS = 12;

export interface EngineOptions {
  /** Where it draws. */
  canvas: HTMLCanvasElement;
  /** The MUGEN tree (httpSource, or any other FileSource). */
  source: FileSource;
  /** Motif def; by default mugen.cfg's, else data/system.def. */
  motif?: string;
  /** Output pixels per motif unit; by default as many whole ones as fit 960. */
  zoom?: number;
  /** Where the options screen saves: localStorage by default, null for nowhere. */
  storage?: OptionsStorage | null;
  /** Keyboard events; window by default. */
  inputTarget?: EventTarget;
  /** The session RNG's seed; from the clock by default. */
  sessionSeed?: number;
  /** false: the files exactly as they are, without the content fixes. */
  contentFixes?: boolean;
  /** mugen.cfg's keys instead of the browser's default ones. */
  keysFromCfg?: boolean;
  /** As if the options screen's truetype font were missing. */
  noTtf?: boolean;
  /** Every change of `loading`, from the start of createEngine on. */
  onProgress?: (progress: LoadProgress | undefined) => void;
  /** Training mode: the dummy's settings changed; undefined when it ends. */
  onTrainingDummy?: (dummy: DummySettings | undefined) => void;
  /** The title's Exit; without it Exit returns to the title. */
  onExit?: () => void;
  /**
   * mugen.exe's debug mode: Ctrl+D the display, Ctrl+C the collision boxes, the
   * F keys and Space in a fight. By default as mugen.cfg's [Debug] says, like
   * mugen.exe; true allows all of it and false takes every debug key away.
   */
  debug?: boolean;
  /** The host calls step() and draws itself: no animation frame loop. */
  manual?: boolean;
}

/** Called around every tick (the comparison harness). */
export interface EngineHooks {
  before?: (screen: Screen) => void;
  after?: (screen: Screen) => void;
}

export interface Engine {
  readonly canvas: HTMLCanvasElement;
  readonly keys: Keyboard;
  /** What mugen.cfg asks of the host: a page can't enter fullscreen by itself. */
  readonly config: { readonly fullScreen: boolean };
  hooks: EngineHooks | undefined;
  readonly screen: Screen;
  /** What is loading now (a fight's characters and stage too); undefined when nothing is. */
  readonly loading: LoadProgress | undefined;
  /** Loading: ticks do nothing meanwhile. */
  readonly busy: boolean;
  /** The browser is waiting for a key press, click or touch to play sound. A pad button doesn't count. */
  readonly audioLocked: boolean;
  readonly running: boolean;
  /** Starts the game flow and, unless manual, the loop. */
  start(): void;
  pause(): void;
  resume(): void;
  /** One tick. */
  step(): void;
  setZoom(zoom?: number): void;
  /** Stops the loop and frees the listeners, the audio and the WebGL context. */
  destroy(): void;
}

export async function createEngine(options: EngineOptions): Promise<Engine> {
  const vfs = new Vfs(options.contentFixes === false ? options.source : withContentFixes(options.source));

  // Motif: ?motif=, else mugen.cfg's "motif =", else data/system.def.
  async function motifPath(): Promise<string> {
    const q = options.motif;
    if (q && vfs.resolve(q)) return vfs.resolve(q)!;
    try {
      const cfg = parseIni(await vfs.text('data/mugen.cfg'));
      const m =
        getValue(findSection(cfg, 'Options'), 'motif') ?? cfg.sections.flatMap((s) => s.entries).find((e) => e.key === 'motif')?.value;
      if (m && vfs.resolve(m)) return vfs.resolve(m)!;
    } catch {
      /* fall through */
    }
    return 'data/system.def';
  }

  let loading: LoadProgress | undefined;
  const report = (progress: LoadProgress | undefined) => {
    loading = progress;
    options.onProgress?.(progress);
  };
  report({ phase: 'motif' });
  const motif = await loadMotif(vfs, await motifPath());
  const [mw, mh] = motif.localCoord;
  const renderer = new Renderer(options.canvas);
  // Output pixels per motif unit; the harness compares at the reference's 640x480.
  const defaultZoom = Math.max(1, Math.floor(960 / mw));
  renderer.resize(mw, mh, options.zoom || defaultZoom);
  const mixer = new Mixer();
  const keys = new Keyboard(options.inputTarget ?? window);
  keys.onFirstInput = () => mixer.unlock();
  // A page that already had a gesture can start its audio without another one.
  const unlockIfAllowed = () => {
    if (navigator.userActivation?.hasBeenActive) mixer.unlock();
  };
  keys.onPadPress = unlockIfAllowed;
  // System_Init: Config_Load, Options_SetDefaults, Options_Load. The options
  // screen's saves live in localStorage (not under the flow harness, which
  // compares against a fresh mugen.cfg).
  let fullScreen = false;
  const gameOptions = await (async () => {
    const cfg = await vfs
      .text('data/mugen.cfg')
      .then(parseIni)
      .catch(() => undefined);
    let storage: OptionsStorage | undefined;
    if (options.storage !== undefined) storage = options.storage ?? undefined;
    else {
      try {
        storage = window.localStorage;
      } catch {
        storage = undefined;
      }
    }
    fullScreen = (getValue(cfg && findSection(cfg, 'Video'), 'fullscreen') ?? '').trim() === '1';
    return new GameOptions(cfg, storage, {
      keysFromCfg: options.keysFromCfg,
      onRemap: (k, j, active) => keys.setMaps(k, j, active),
      padCount: () => keys.padCount(),
    }).init();
  })();
  keys.onPadsChanged = () => gameOptions.initPads();
  // The sounds play at MasterVolume * WavVolume (Sound_SetVolume).
  mixer.volume = gameOptions.wavGain;
  const music = new Music(mixer, (path) => vfs.read(path));
  music.volume = gameOptions.bgmGain;

  // [Options] Difficulty: the CPU's AILevel (clamped 1..8).
  const ctx: AppContext = {
    renderer,
    mixer,
    music,
    keys,
    motif,
    aiLevel: Math.max(1, Math.min(8, gameOptions.difficulty)),
    frames: 0,
    options: gameOptions,
    onTrainingDummy: options.onTrainingDummy,
  };

  const assets = await loadAssets(vfs, motif, { noTtf: options.noTtf, onProgress: report });
  let debug: DebugMode | undefined;
  if (options.debug !== false) {
    const config = readDebugConfig(
      await vfs
        .text('data/mugen.cfg')
        .then(parseIni)
        .catch(() => undefined),
    );
    if (options.debug) config.allowDebugMode = config.allowDebugKeys = true;
    const font = await loadFont(vfs, 'font/f-4x6.def').catch(() => undefined);
    ctx.debug = debug = new DebugMode(config, font, assets.systemFont, ctx.aiLevel);
  }
  report(undefined);
  const flow = createGameFlow(
    ctx,
    vfs,
    motif,
    gameOptions,
    assets,
    { sessionSeed: options.sessionSeed, onExit: options.onExit, onProgress: report },
    () => engine.hooks,
  );

  // Only in a fight: on the other screens these keys stay the page's.
  if (debug) keys.onKeyDown = (e) => flow.screen instanceof FightScreen && debug.keyDown(e);

  let started = false;
  let destroyed = false;
  let raf = 0;
  let acc = 0;
  let last = 0;
  const frame = (now: number) => {
    acc += Math.min(now - last, 250);
    last = now;
    // Match_Setup: a match runs at the game speed's frame rate, the other screens at 60.
    if (ctx.debug?.speedup) {
      // GameVars.speedup: no frame limit, leaving the browser time to draw.
      const end = performance.now() + SPEEDUP_MS;
      do flow.step();
      while (performance.now() < end && !flow.busy);
      acc = 0;
    }
    for (;;) {
      const tick = 1000 / (flow.screen instanceof FightScreen ? gameOptions.matchFps : 60);
      if (acc < tick) break;
      flow.step();
      acc -= tick;
    }
    if (!flow.busy) flow.screen.draw();
    raf = requestAnimationFrame(frame);
  };

  const engine: Engine = {
    canvas: options.canvas,
    keys,
    config: { fullScreen },
    hooks: undefined,
    get screen() {
      return flow.screen;
    },
    get loading() {
      return loading;
    },
    get busy() {
      return flow.busy;
    },
    get audioLocked() {
      return mixer.locked;
    },
    get running() {
      return raf !== 0;
    },
    start() {
      if (started || destroyed) return;
      started = true;
      unlockIfAllowed();
      void flow.run();
      if (!options.manual) engine.resume();
    },
    pause() {
      cancelAnimationFrame(raf);
      raf = 0;
      mixer.pause();
    },
    resume() {
      if (raf !== 0 || !started || destroyed || options.manual) return;
      mixer.resume();
      acc = 0;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },
    step() {
      if (!destroyed) flow.step();
    },
    setZoom(zoom) {
      renderer.resize(mw, mh, zoom || defaultZoom);
    },
    destroy() {
      if (destroyed) return;
      engine.pause();
      destroyed = true;
      keys.dispose();
      music.stop();
      mixer.close();
      renderer.dispose();
    },
  };
  return engine;
}
