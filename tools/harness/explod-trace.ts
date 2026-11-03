// Explods alive after each frame of an Iori vs Kyo CPU match (frames from..to):
//   EX frame roundstate count owner+id:age/removetime/animtime[F]... [SP|P]
// to compare with the explod count of mugen.exe ([[0x5040e8]+0x10C20]+8).
// Usage: tsx tools/harness/explod-trace.ts <from> <to>
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
const prog1 = await loadProgram(vfs, await loadCharacter(vfs, `chars/iori-yagami-kofa/iori-yagami-kofa.def`));
const prog2 = await loadProgram(vfs, await loadCharacter(vfs, `chars/kyo-kofa/kyo-kofa.def`));
const stage = await loadStage(vfs, `stages/kfm.def`);
const hud = await FightHud.load(vfs, 'data/fight.def');
const w = new World();
w.applyStage(stage.info);
w.fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
const p1 = new Player(prog1, w, 0), p2 = new Player(prog2, w, 1);
p2.palNo = 2; w.players.push(p1, p2);
[p1, p2].forEach((p) => (p.ai = new MugenAI(p, 4)));
const m = new Match(w, hud.roundConfig(), [
  { x: stage.info.p1.x, y: stage.info.p1.y, facing: stage.info.p1.facing },
  { x: stage.info.p2.x, y: stage.info.p2.y, facing: stage.info.p2.facing },
]);
w.seed = 16808;
const [from, to] = process.argv.slice(2).map(Number);
for (let i = 1; i <= to!; i++) {
  const go = m.tick();
  if (go) w.tick([0, 0]);
  if (i >= from!) console.log(`EX ${i} ${w.roundState} ${w.explods.length} ${w.explods.map((e) => `${e.owner.name[0]}${e.id}:${e.age}/${e.removeTime}/${e.anim.totalTime}${e.common ? "F" : ""}`).join(",")} ${go ? '' : 'skip'} ${w.superPause ? 'SP' : w.pause ? 'P' : ''}`);
}
