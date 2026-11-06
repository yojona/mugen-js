// Runs a CPU team match and prints its course: rounds, KOs, members.
// Usage: tsx tools/harness/team-run.ts <mode0>:<c1,c2..> <mode1>:<c1,..> [frames]
//   mode: single | simul | turns
import { join } from 'node:path';
import { loadCharacter } from '../../src/engine/character';
import { Match, type TeamMode, type TeamPlan } from '../../src/engine/match';
import { nodeSource } from '../../src/engine/node-source';
import { loadProgram, Player, type CharacterProgram } from '../../src/engine/player';
import { Vfs } from '../../src/engine/vfs';
import { World } from '../../src/engine/world';
import { MugenAI } from '../../src/engine/ai';
import { parseAir } from '../../src/formats/air';
import { parseSff } from '../../src/formats/sff';
import { FightHud } from '../../src/motif/fight';
import { loadStage } from '../../src/stage/stage';

const [a0, a1, framesArg] = process.argv.slice(2);
const vfs = new Vfs(nodeSource(join(import.meta.dirname, '..', '..', 'ref', 'mugen-1.1b1')));
const stage = await loadStage(vfs, 'stages/kfm.def');
const hud = await FightHud.load(vfs, 'data/fight.def');
const w = new World();
w.applyStage(stage.info);
w.fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
const progs = new Map<string, CharacterProgram>();
const prog = async (c: string) =>
  progs.get(c) ?? progs.set(c, await loadProgram(vfs, await loadCharacter(vfs, `chars/${c}/${c}.def`))).get(c)!;
const plan = async (arg: string, side: number): Promise<TeamPlan> => {
  const [mode, list] = arg.split(':') as [TeamMode, string];
  const chars = list.split(',');
  const ps = await Promise.all(chars.map(prog));
  return {
    mode,
    count: chars.length,
    spawn(member, k) {
      const p = new Player(ps[mode === 'simul' ? k : member]!, w, side);
      p.ai = new MugenAI(p, 4);
      p.warn = () => {};
      return p;
    },
  };
};
const teams: [TeamPlan, TeamPlan] = [await plan(a0!, 0), await plan(a1!, 1)];
const i = stage.info;
const m = new Match(w, hud.roundConfig(), [i.p1, i.p2, i.p3, i.p4], { teams });
m.autoRematch = false;
w.seed = 16808;
let last = '';
for (let f = 1; f <= Number(framesArg ?? 30000) && !m.finished; f++) {
  if (m.tick()) w.tick([0, 0]);
  const s =
    `round ${m.round} rs ${w.roundState} wins ${m.wins} | ` +
    w.players.map((p) => `P${p.slotNo} ${p.name} ${p.life}/${p.lifeMax} st ${p.stateNo}`).join(' | ');
  const key = `${m.round}${w.roundState}${w.players.map((p) => p.name + p.alive).join()}`;
  if (key !== last) console.log(`f ${f}: ${s}`);
  last = key;
}
console.log(`finished ${m.finished} winner ${m.winner?.name ?? 'draw'} wins ${m.wins}`);
