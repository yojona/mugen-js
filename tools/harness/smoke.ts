// Smoke test of every character in ref/mugen-1.1b1/chars: load it and run a
// CPU match against an opponent (default kfm) for some frames, reporting
// load errors, exceptions and the distinct warnings.
// Usage: tsx tools/harness/smoke.ts [frames=3000] [opponent=kfm] [filter]
import { readdirSync } from 'node:fs';
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

const [framesArg, oppArg, filter] = process.argv.slice(2);
const frames = Number(framesArg ?? 3000);
const opp = oppArg ?? 'kfm';
const ROOT = join(import.meta.dirname, '..', '..', 'ref', 'mugen-1.1b1');
const vfs = new Vfs(nodeSource(ROOT));
const stage = await loadStage(vfs, 'stages/kfm.def');
const hud = await FightHud.load(vfs, 'data/fight.def');
const fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
const oppProg = await loadProgram(vfs, await loadCharacter(vfs, `chars/${opp}/${opp}.def`));

const chars = readdirSync(join(ROOT, 'chars')).filter((c) => (!filter || c.includes(filter)) && vfs.resolve(`chars/${c}/${c}.def`));
let ok = 0;
for (const c of chars.sort()) {
  const warns = new Map<string, number>();
  const t0 = performance.now();
  try {
    const prog = await loadProgram(vfs, await loadCharacter(vfs, `chars/${c}/${c}.def`));
    const w = new World();
    w.applyStage(stage.info);
    w.fightFx = fightFx;
    const p1 = new Player(prog, w, 0);
    const p2 = new Player(oppProg, w, 1);
    w.players.push(p1, p2);
    for (const p of [p1, p2]) {
      p.ai = new MugenAI(p, 4);
      p.warn = (m) => {
        if (p !== p1) return;
        const k = m.replace(/\d+/g, 'N');
        warns.set(k, (warns.get(k) ?? 0) + 1);
      };
    }
    const m = new Match(w, hud.roundConfig(), [
      { x: stage.info.p1.x, y: stage.info.p1.y, facing: stage.info.p1.facing },
      { x: stage.info.p2.x, y: stage.info.p2.y, facing: stage.info.p2.facing },
    ]);
    w.seed = 16808;
    let i = 0;
    for (; i < frames && !m.finished; i++) if (m.tick()) w.tick([0, 0]);
    const ms = (performance.now() - t0).toFixed(0);
    const top = [...warns].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n}x ${k}`);
    console.log(`OK   ${c} ${i}f ${ms}ms life ${p1.life}/${p2.life}${top.length ? ' | ' + top.join(' | ') : ''}`);
    ok++;
  } catch (e) {
    console.log(`FAIL ${c}: ${String((e as Error)?.stack ?? e).split('\n').slice(0, 3).join(' / ')}`);
  }
}
console.log(`${ok}/${chars.length} ok`);
