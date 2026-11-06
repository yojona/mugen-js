// Helpers alive after each frame of a CPU match (frames from..to), in
// mugen.exe's units (x2 for 320-localcoord characters):
//   HL frame [owner:stateno/time x,y vx,vy]...
// Usage: C1=char C2=char tsx tools/harness/helper-trace.ts <from> <to>
import { join } from 'node:path';
import { loadCharacter } from '../../src/engine/character';
import { Match } from '../../src/engine/match';
import { nodeSource } from '../../src/engine/node-source';
import { loadProgram, Player } from '../../src/engine/player';
import { Vfs } from '../../src/engine/vfs';
import { World } from '../../src/engine/world';
import { MugenAI } from '../../src/engine/ai';
import { parseAir } from '../../src/formats/air';
import { parseSff } from '../../src/formats/sff';
import { FightHud } from '../../src/motif/fight';
import { loadStage } from '../../src/stage/stage';
const vfs = new Vfs(nodeSource(join(import.meta.dirname, '..', '..', 'ref', 'mugen-1.1b1')));
const c1 = process.env.C1!,
  c2 = process.env.C2!;
const prog1 = await loadProgram(vfs, await loadCharacter(vfs, `chars/${c1}/${c1}.def`));
const prog2 = await loadProgram(vfs, await loadCharacter(vfs, `chars/${c2}/${c2}.def`));
const stage = await loadStage(vfs, `stages/kfm.def`);
const hud = await FightHud.load(vfs, 'data/fight.def');
const w = new World();
w.applyStage(stage.info);
w.fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
const p1 = new Player(prog1, w, 0),
  p2 = new Player(prog2, w, 1);
p2.palNo = 2;
w.players.push(p1, p2);
[p1, p2].forEach((p) => (p.ai = new MugenAI(p, 4)));
const m = new Match(w, hud.roundConfig(), [
  { x: stage.info.p1.x, y: stage.info.p1.y, facing: stage.info.p1.facing },
  { x: stage.info.p2.x, y: stage.info.p2.y, facing: stage.info.p2.facing },
]);
w.seed = 16808;
const [from, to] = process.argv.slice(2).map(Number);
const k = w.gameWidth / w.screenWidth;
for (let i = 1; i <= to!; i++) {
  if (m.tick()) w.tick([0, 0]);
  if (i >= from!)
    console.log(
      `HL ${i} ` +
        w.helpers
          .map(
            (h) =>
              `${h.root.name[0]}:${h.stateNo}/${h.time} ${(h.wx * k).toFixed(2)},${(h.wy * k).toFixed(2)} ${(h.vel.x * h.facing * h.scale * k).toFixed(2)},${(h.vel.y * h.scale * k).toFixed(2)} hd=${h.hitDefActive ? 1 : 0}`,
          )
          .join(' | '),
    );
}
