// Run the probe match in mugen-web and write the harness log (same format as
// the Lua dumper in overlay/data/init.lua).
// Usage: npx tsx tools/harness/run-ours.ts <ticks> <out.log>

import { writeFileSync } from 'node:fs';
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

const ROOT = join(import.meta.dirname, '..', '..');

/** The reference tree with the harness overlay on top. */
function overlaySource(base: FileSource, top: FileSource): FileSource {
  const topFiles = new Set(top.list().map((p) => p.toLowerCase()));
  return {
    list: () => [...base.list().filter((p) => !topFiles.has(p.toLowerCase())), ...top.list()],
    read: (p) => (topFiles.has(p.toLowerCase()) ? top.read(p) : base.read(p)),
  };
}

const ticks = parseInt(process.argv[2] ?? '700', 10);
const out = process.argv[3] ?? 'ours.log';
const vfs = new Vfs(overlaySource(nodeSource(join(ROOT, 'ref', 'mugen-1.1b1')), nodeSource(join(import.meta.dirname, 'overlay'))));
const prog = await loadProgram(vfs, await loadCharacter(vfs, 'chars/probe/probe.def'));
const stage = await loadStage(vfs, 'stages/kfm.def');
const hud = await FightHud.load(vfs, 'data/fight.def');
const w = new World();
w.applyStage(stage.info);
w.fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
const p1 = new Player(prog, w, 0);
const p2 = new Player(prog, w, 1);
p2.palNo = 2;
w.players.push(p1, p2);
const m = new Match(w, hud.roundConfig(), [
  { x: stage.info.p1.x, y: stage.info.p1.y, facing: stage.info.p1.facing },
  { x: stage.info.p2.x, y: stage.info.p2.y, facing: stage.info.p2.facing },
]);

const lines: string[] = [];
const dump = () => {
  w.players.forEach((p, i) => {
    const f = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(4));
    lines.push(
      [
        'H', String(w.gameTime), 'fight', String(i + 1),
        `stateno=${p.stateNo}`, `prevstateno=${p.prevStateNo}`, `anim=${p.animNo}`, `animtime=${p.anim.animTime()}`,
        `ctrl=${p.ctrl}`, `statetype=${p.stateType.toUpperCase()}`, `movetype=${p.moveType.toUpperCase()}`,
        `life=${p.life}`, `power=${p.power}`, `facing=${p.facing}`, `hitpausetime=${p.hitPause}`,
        `hitshakeover=${p.ghv.hitshaketime <= 0}`, `hitover=${p.ghv.hittime <= 0}`,
        `movecontact=${p.moveContact}`, `movehit=${p.moveHit}`, `moveguarded=${p.moveGuarded}`, `alive=${p.alive}`,
        `pos=(${f(p.pos.x - w.camera.x / p.scale)}, ${f(p.pos.y)})`, `vel=(${f(p.vel.x)}, ${f(p.vel.y)})`,
        `elem=${p.anim.animElemNo(0) ?? -1}`, `clock=${p.vars[58]}`,
      ].join('|'),
    );
  });
};
for (let i = 0; i < ticks; i++) {
  dump();
  if (m.tick()) w.tick([0, 0]);
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`${lines.length} lines -> ${out}`);
