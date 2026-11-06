# mugen-js

M.U.G.E.N 1.1 rebuilt from scratch for the browser, in TypeScript and WebGL2. It
plays existing MUGEN content (characters, stages, motifs) and is checked frame by
frame against the original `mugen.exe`.

The package renders the engine and nothing else. It draws on the canvas you give
it, reads files through a source you give it, and reports loading through a
callback. The page around it is yours: `examples/` is only an example.

No game data is included. You supply a MUGEN tree.

## Install

There is no npm release. Either install from GitHub, which builds it:

```sh
npm i github:yojona/mugen-js
```

or download `mugen.min.js` from a [GitHub Release](https://github.com/yojona/mugen-js/releases) and copy it next to your page:

```html
<script type="module">
  import { createEngine, httpSource } from './mugen.min.js';
</script>
```

## Quick start

```ts
import { createEngine, httpSource } from 'mugen-js';

const engine = await createEngine({
  canvas: document.querySelector('canvas')!,
  source: await httpSource('/mugen', '/mugen/files.json'),
  onProgress: (p) => console.log(p ?? 'ready'),
  onExit: () => history.back(),
});
engine.start();
```

`httpSource(baseUrl, listUrl)` needs `listUrl` to answer with a JSON array of every
file path, relative to the MUGEN root. Generate it with
`npx tsx tools/file-list.ts <mugen root> > files.json`. Serving `Range` requests
makes loading faster but is not required.

## API

### `createEngine(options): Promise<Engine>`

Only `canvas` and `source` are required.

| Option | Type | Default | Purpose |
|---|---|---|---|
| `canvas` | `HTMLCanvasElement` | | Where it draws |
| `source` | `FileSource` | | The MUGEN tree |
| `motif` | `string` | `mugen.cfg`, then `data/system.def` | Motif def |
| `zoom` | `number` | Whole factor that fits 960 px | Output pixels per motif unit |
| `storage` | `OptionsStorage \| null` | `localStorage` | Where the options screen saves; `null` for nowhere |
| `inputTarget` | `EventTarget` | `window` | Where keyboard events come from |
| `sessionSeed` | `number` | From the clock | Seed of the session RNG |
| `contentFixes` | `boolean` | `true` | `false` reads files exactly as they are |
| `keysFromCfg` | `boolean` | `false` | `mugen.cfg` keys instead of the browser defaults (for the harness) |
| `noTtf` | `boolean` | `false` | Behave as if TrueType fonts were missing (for the harness) |
| `debug` | `boolean` | `mugen.cfg` `[Debug]` | See [Debug mode](#debug-mode) |
| `onProgress` | `(p: LoadProgress \| undefined) => void` | | Loading progress; `undefined` when done |
| `onTrainingDummy` | `(d: DummySettings \| undefined) => void` | | Training dummy changed; `undefined` when training ends |
| `onExit` | `() => void` | | The title screen's Exit (or Escape there); without it, the title stays |
| `manual` | `boolean` | `false` | No animation loop: you call `step()` and draw |

`LoadProgress` is `{ phase: 'motif' | 'hud' | 'loading' }` or
`{ phase: 'characters', done?, total? }`.

### `Engine`

| Member | Purpose |
|---|---|
| `start()` | Starts the game flow and, unless `manual`, the loop |
| `pause()` / `resume()` | Stop and continue the loop |
| `step()` | Runs one tick |
| `setZoom(zoom?)` | Changes the output scale |
| `destroy()` | Stops everything and releases listeners, audio and GL |
| `canvas`, `keys` | The canvas and the keyboard |
| `config.fullScreen` | `mugen.cfg` `[Video] FullScreen`. A page cannot enter fullscreen by itself, so the host decides |
| `screen` | The current screen |
| `loading`, `busy` | What is loading now; ticks do nothing while busy |
| `running` | Whether the loop is running |
| `hooks` | Called around every tick (used by the comparison harness) |

### `FileSource`

Any object with these methods can feed the engine, such as a zip, IndexedDB or a
drag and drop:

```ts
interface FileSource {
  list(): string[];                         // '/'-separated, relative to the root
  read(path: string): Promise<Uint8Array>;
  readRange?(path: string, start: number, end: number): Promise<Uint8Array>;
}
```

## Debug mode

Debug mode follows `data/mugen.cfg`, as in the original:

```ini
[Debug]
Debug = 0            ; every match starts with the display on
AllowDebugMode = 1   ; Ctrl+D turns the display on
AllowDebugKeys = 1   ; the debug keys work with the display off
Speedup = 0          ; no frame limit
```

The `debug` option overrides that file: `true` allows everything and `false`
removes every debug key. **The stock `mugen.cfg` allows the debug keys**, so Space
or F1 change a fight unless the file or the host turns them off. Pass `debug: false`
for a public page. Keys are only taken from the browser during a fight, where F5
no longer reloads the page.

| Key | Action |
|---|---|
| Ctrl+D | Display: next player, then off |
| Ctrl+C | Collision boxes: outlines, filled, off |
| Ctrl+S | Run at maximum speed |
| Ctrl+L | Hide or show the HUD |
| Ctrl+I | Force both players to stand |
| Ctrl+1..4 | Toggle the AI of that player |
| Space | Reset life, power and round time |
| F1 / Ctrl+F1 | Player 2 / player 1 life to 0 |
| F2 / Ctrl+F2 | Player 2 / player 1 life to 1 |
| F3 / Ctrl+Shift+F3 | Full power / keep power full |
| F4 / Shift+F4 | Restart the round / the match |
| F5 | Round time to 1 |
| Pause / Scroll Lock | Pause / advance one tick |

The display shows the player's name, action, sprite, state and clipboard
(`DisplayToClipboard`), plus the life numbers on the bars.

Not ported: the console (Ctrl+\`), Ctrl+T, Ctrl+Alt+1..4 (toggle player), Ctrl+F
(frame skip), Ctrl+V (vsync), F8 and the engine log shown at the top of the screen.
Pause works only in a fight.

## Compatibility

**Target:** MUGEN 1.1 beta 1. Development started from Elecbyte's documentation. The
engine is based on the work of zxmarcos in
[mugen-unleashed](https://github.com/zxmarcos/mugen-unleashed), a C reconstruction of the
same binary, rewritten here in TypeScript. The result is measured against the binary under
Wine.

### What is verified

`tools/harness` runs `mugen.exe` and this engine in lockstep with the same keys and
seed, then compares both. A fight is compared on state, animation, position, velocity,
life, power, camera and RNG, on every tick.

| Compared with `mugen.exe` | Result |
|---|---|
| KFM scenarios (moves, guard, AI, supers, whole match) | No differences (`tests/harness.test.ts`) |
| Community characters: 16 one-on-one and 15 simul matches | No differences (`tests/community.test.ts`) |
| Whole-game flow: title, select, storyboards, versus, fights, victory, continue | Same screens and frames |
| Pixels, Andy vs Ash | 5073 ticks; at most 0.15% of pixels differ visibly in a capture |
| Loading a public pack | 283 of 285 characters compile; the other two have broken files |

These are samples, not the whole roster: there is no overall "1:1" percentage, because
we have no basis for one. See [Known gaps](#known-gaps) for what still differs, and
`docs/STATUS.md` for the detail. The community tests are skipped unless those characters
are in `ref/`.

### What is implemented

| Area | Support |
|---|---|
| Formats | DEF, CNS, ST, CMD, AIR, ACT, SND; SFF v1 and v2 (PCX, RLE8, RLE5, LZ5, PNG); FNT and TrueType |
| Modes | Arcade, Versus, Team Arcade, Team Versus, Team Co-op, Survival, Survival Co-op, Training, Watch; demo fights |
| Screens | Title, select, versus, storyboards, victory, continue, results, options, key config |
| Engine | Expressions and triggers, state controllers, HitDef and guard, helpers, projectiles, explods, CPU AI with levels, ramps and learning |
| Stages | Layers, camera, zoom, parallax and shadows |
| Input | Keyboard and gamepad (played on a real one), configurable |
| Output | Palette effects and blend modes in WebGL2, sound effects in Web Audio |

### Known gaps

- **No music.** Stage and menu music do not play. Only sound effects do.
- **No Lua.** Features of `mugen.exe` that rely on Lua are absent.
- **Coverage is a sample.** Controllers and triggers that the tested characters do
  not use come from the decompilation, without a comparison. Most of the 295
  characters in the test pack have not been played against the original.
- **Open differences:** in Kim vs Kensou on the wood stage, the world is 1 px off at
  frame 3000 (cause unknown). Andy's flames differ slightly at frame 3000. The
  session seed differs for 2 ticks at the end of a fight.

### Browser notes

- Needs WebGL2 and Web Audio.
- Audio starts on the first key press, as browsers require.
- Files are read through `fetch`, so a page opened from `file://` will not work.
- Browsers keep some shortcuts for themselves, such as Ctrl+W and Ctrl+T.

## Development

```sh
npm install
# Put your own copy of MUGEN 1.1 beta 1 in ref/mugen-1.1b1 (not committed)
npm run dev         # the example at http://localhost:8120
npm run check       # formatting, types and tests
npm run build       # dist/: the ES module, mugen.min.js and the type declarations
```

| Path | Contents |
|---|---|
| `src/index.ts` | The public API |
| `src/app` | `createEngine`, game flow, screens, input, debug mode |
| `src/engine` | The simulation: characters, controllers, triggers, world, match, AI |
| `src/formats` | File parsers |
| `src/motif`, `src/stage` | Motif, HUD and stage |
| `src/render`, `src/audio` | WebGL2 and Web Audio |
| `examples` | A page that embeds the engine |
| `tools/pages` | Dev-only pages (harness, viewer, training), never in a build |
| `tools/harness` | The comparison with `mugen.exe` (Docker and Wine; bring your own copy) |
| `docs/STATUS.md` | Detailed verification history |

## Roadmap

### Before a first release

1. A review of the legal position on the MUGEN name and on using the decompilation
   as a reference. See [License](#license).
2. Decide which options stay public. `hooks`, `noTtf` and `keysFromCfg` exist for the
   harness.
3. Publish on npm. Today it is GitHub only and `private` in `package.json`.

### Compatibility

4. Stage and menu music.
5. More character pairs against the original, focused on controllers no test covers.
6. Resolve the open differences listed above.
7. The rest of debug mode: console and toggle player.

### Later

8. Loading user content from files or zips through a `FileSource`.
9. Pause on every screen, as in the original.

## License

[MIT](LICENSE), for the code written for this project. It does not cover MUGEN itself,
its data files, or any characters, stages and motifs you load, which belong to their
owners. It also grants no rights over the parts based on mugen-unleashed, whose code carries
no license, or that the owners of the original work may hold. M.U.G.E.N is a name of Elecbyte, and this
project is not affiliated with or endorsed by them.
