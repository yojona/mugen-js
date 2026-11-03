// Helper slots 5-8 of a mugen.exe capture (PEEKALL: gametime, camera
// edges, then stateno/x/y of each slot) against ours, at full precision.
// A destroyed helper's slot keeps its last values, as in mugen.exe.
// Usage: C1=char C2=char tsx tools/harness/helper-diff.ts <mugen.log> <frames>
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
const c1 = process.env.C1!, c2 = process.env.C2!;
const prog1 = await loadProgram(vfs, await loadCharacter(vfs, `chars/${c1}/${c1}.def`));
const prog2 = await loadProgram(vfs, await loadCharacter(vfs, `chars/${c2}/${c2}.def`));
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
import { readFileSync } from 'node:fs';
const [log, framesArg] = process.argv.slice(2);
const ref = new Map<number, number[]>();
for (const l of readFileSync(log!, 'latin1').split('\n')) {
  if (!l.startsWith('P|')) continue;
  const v = l.split('|')[2]!.split(',').map(Number);
  if (!ref.has(v[0]!)) ref.set(v[0]!, v);
}
const k = w.gameWidth / w.screenWidth;
const lastObj: (Player | undefined)[] = [];
let shown = 0;
for (let i = 1; i <= Number(framesArg); i++) {
  if (m.tick()) w.tick([0, 0]);
  const r = ref.get(w.gameTime);
  if (!r) continue;
  const ours: number[] = [w.gameTime, 0, 0];
  for (let s = 0; s < 4; s++) {
    const h = w.helperSlots[s] ?? lastObj[s];
    if (w.helperSlots[s]) lastObj[s] = w.helperSlots[s]!;
    ours.push(...(h ? [h.stateNo, h.wx * k, h.wy * k] : [0, 0, 0]));
  }
  for (let j = 3; j < r.length; j++) {
    if (Math.abs(r[j]! - ours[j]!) > 1e-9) {
      console.log(`frame ${i} gt ${w.gameTime} field ${j} mugen ${r[j]} ours ${ours[j]}`);
      console.log('  M', r.join(','));
      console.log('  O', ours.join(','));
      if (++shown >= 5) process.exit(0);
      break;
    }
  }
}
console.log(shown ? '' : 'helpers identical');
