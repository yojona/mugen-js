// Run the probe match in mugen-web and return harness log lines
// (S|step|side|vars(60)|fvars(40)), the same layout memread.py reads from MUGEN.

import { join } from 'node:path';
import { loadCharacter } from '../../src/engine/character';
import { Match } from '../../src/engine/match';
import { nodeSource } from '../../src/engine/node-source';
import { loadProgram, Player } from '../../src/engine/player';
import { Vfs, type FileSource } from '../../src/engine/vfs';
import { World } from '../../src/engine/world';
import { parseAir } from '../../src/formats/air';
import { parseSff } from '../../src/formats/sff';
import { FightHud } from '../../src/motif/fight';
import { loadStage } from '../../src/stage/stage';
import { readFileSync } from 'node:fs';
import { parseInputs } from './inputs';

const ROOT = join(import.meta.dirname, '..', '..');

/** The reference tree with the harness overlay on top. */
function overlaySource(base: FileSource, top: FileSource): FileSource {
  const topFiles = new Set(top.list().map((p) => p.toLowerCase()));
  return {
    list: () => [...base.list().filter((p) => !topFiles.has(p.toLowerCase())), ...top.list()],
    read: (p) => (topFiles.has(p.toLowerCase()) ? top.read(p) : base.read(p)),
  };
}

export interface ProbeOptions {
  /** Character in overlay/chars (default "probe": scripted, no input). */
  char?: string;
  /** Player 2's character (default: same as char). */
  char2?: string;
  /** Input script under tools/harness/inputs (e.g. "basic"). */
  inputs?: string;
}

export async function runProbe(ticks: number, opts: ProbeOptions = {}): Promise<string[]> {
  const char = opts.char ?? 'probe';
  const script = opts.inputs ? parseInputs(readFileSync(join(import.meta.dirname, 'inputs', `${opts.inputs}.txt`), 'utf8')) : undefined;
  const vfs = new Vfs(overlaySource(nodeSource(join(ROOT, 'ref', 'mugen-1.1b1')), nodeSource(join(import.meta.dirname, 'overlay'))));
  const prog = await loadProgram(vfs, await loadCharacter(vfs, `chars/${char}/${char}.def`));
  const char2 = opts.char2 ?? char;
  const prog2 = char2 === char ? prog : await loadProgram(vfs, await loadCharacter(vfs, `chars/${char2}/${char2}.def`));
  const stage = await loadStage(vfs, 'stages/kfm.def');
  const hud = await FightHud.load(vfs, 'data/fight.def');
  const w = new World();
  w.applyStage(stage.info);
  w.fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
  const p1 = new Player(prog, w, 0);
  const p2 = new Player(prog2, w, 1);
  p2.palNo = 2;
  w.players.push(p1, p2);
  const m = new Match(w, hud.roundConfig(), [
    { x: stage.info.p1.x, y: stage.info.p1.y, facing: stage.info.p1.facing },
    { x: stage.info.p2.x, y: stage.info.p2.y, facing: stage.info.p2.facing },
  ]);
  const lines: string[] = [];
  for (let i = 1; i <= ticks; i++) {
    // Same rule as drive.py: keys for the next tick of the script clock.
    const clock = p1.vars[58]!;
    const keys = script && clock > 0 ? script.at(clock + 1) : [0, 0];
    if (m.tick()) w.tick(keys);
    w.players.forEach((p) => {
      const v = Array.from(p.vars).join(',');
      const f = Array.from(p.fvars, (x) => x.toFixed(4)).join(',');
      lines.push(`S|${i}|${p.side + 1}|${v}|${f}`);
    });
  }
  return lines;
}
