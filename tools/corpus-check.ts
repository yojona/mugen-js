// Compile every state of every character in a corpus (text files only: no
// sprites needed) and group the failures by kind, not by character. Every
// published character loads in mugen.exe, so anything that fails here is a
// gap in our implementation of MUGEN's grammar or semantics.
//
// Usage: tsx tools/corpus-check.ts <corpus dir> [--examples N] [--json out]
// The corpus dir holds one folder per character; common1.cns comes from
// ref/mugen-1.1b1/data when a character does not ship its own.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAir } from '../src/formats/air';
import { parseCharDef } from '../src/formats/chardef';
import type { CharacterData } from '../src/engine/character';
import { nodeSource } from '../src/engine/node-source';
import { loadProgram, Player } from '../src/engine/player';
import { Vfs, type FileSource } from '../src/engine/vfs';
import { World } from '../src/engine/world';

const args = process.argv.slice(2);
const dir = args[0]!;
const nEx = Number(args[args.indexOf('--examples') + 1]) || 3;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;

// Corpus files first, then the reference tree (data/common1.cns etc.).
function layered(a: FileSource, b: FileSource): FileSource {
  return {
    list: () => [...a.list(), ...b.list()],
    read: async (p) => {
      try {
        return await a.read(p);
      } catch {
        return b.read(p);
      }
    },
  };
}
const ref = nodeSource(join(import.meta.dirname, '..', 'ref', 'mugen-1.1b1'));

/** Error message with the specific bits (numbers, quoted text, positions) masked. */
function kind(msg: string): string {
  return msg
    .replace(/^.*?\] /, '')
    .replace(/^Statedef -?\d+: /, '')
    .replace(/\(at ".*"(, position \d+)?\)/, '')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/-?\d+(\.\d+)?/g, 'N')
    .trim();
}

const byKind = new Map<string, { chars: Set<string>; count: number; examples: string[] }>();
let chars = 0;
let loadFail = 0;
for (const name of readdirSync(dir).sort()) {
  const cdir = join(dir, name);
  if (!statSync(cdir).isDirectory()) continue;
  const defs = readdirSync(cdir).filter((f) => f.toLowerCase().endsWith('.def'));
  const defFile = defs.find((f) => f.toLowerCase() === `${name.toLowerCase()}.def`) ?? defs[0];
  if (!defFile) continue;
  chars++;
  const vfs = new Vfs(layered(nodeSource(dir), ref));
  try {
    const defPath = `${name}/${defFile}`;
    const def = parseCharDef(new TextDecoder('latin1').decode(readFileSync(join(cdir, defFile))));
    const anims = def.files.anim ? parseAir(await vfs.text(def.files.anim, name)) : new Map();
    const data = {
      defPath,
      dir: name,
      def,
      sff: { sprites: [], palettes: [], paletteIds: [], version: 1 } as never,
      anims,
      palettes: [],
      paletteFor: () => undefined,
    } as CharacterData;
    const prog = await loadProgram(vfs, data);
    const w = new World();
    const p = new Player(prog, w, 0);
    w.players.push(p);
    const warns: string[] = [];
    (p as unknown as { warn: (m: string) => void }).warn = (m) => warns.push(m);
    for (const no of prog.states.keys()) p.compiledState(no);
    for (const m of warns) {
      if (m.startsWith('Animation')) continue;
      const k = kind(m);
      let e = byKind.get(k);
      if (!e) byKind.set(k, (e = { chars: new Set(), count: 0, examples: [] }));
      e.chars.add(name);
      e.count++;
      if (e.examples.length < nEx) e.examples.push(`${name}: ${m}`);
    }
  } catch (err) {
    loadFail++;
    const k = `LOAD: ${kind((err as Error).message)}`;
    let e = byKind.get(k);
    if (!e) byKind.set(k, (e = { chars: new Set(), count: 0, examples: [] }));
    e.chars.add(name);
    e.count++;
    if (e.examples.length < nEx) e.examples.push(`${name}: ${(err as Error).message}`);
  }
}
const rows = [...byKind].sort((a, b) => b[1].chars.size - a[1].chars.size);
const clean = chars - new Set(rows.flatMap(([, e]) => [...e.chars])).size;
console.log(`${chars} characters, ${clean} compile clean, ${loadFail} failed to load, ${rows.length} kinds of failure`);
for (const [k, e] of rows) {
  console.log(`\n[${e.chars.size} chars, ${e.count}x] ${k}`);
  for (const ex of e.examples) console.log(`    ${ex.slice(0, 220)}`);
}
if (jsonOut)
  writeFileSync(
    jsonOut,
    JSON.stringify(
      rows.map(([k, e]) => ({ kind: k, chars: e.chars.size, count: e.count, examples: e.examples })),
      null,
      1,
    ),
  );
