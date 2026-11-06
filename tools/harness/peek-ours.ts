// mugen-web side of a NOPROBE capture (drive.py with NOPROBE=1 and PEEKALL):
// any two characters, CPU vs CPU, one line per tick with the same fields as
// tools/harness/peek-fields.txt reads out of mugen.exe:
//   P|tick|gametime,roundstate,rng,{stateno,time,life,x,y,velx,vely} x2
// Positions are in character units (MUGEN keeps them as doubles in p+0x1f8).
//
// Usage: tsx tools/harness/peek-ours.ts <ticks> <out.log> <char1> <char2> <seed> [ai1,ai2] [stage]
//   seed: mugen.exe's match RNG right before the first RoundState 2 tick, or
//   "gt:value" for its RNG after the tick with that gametime (e.g. the first
//   captured frame, so the intros draw the same numbers).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCharacter } from '../../src/engine/character';
import { Match } from '../../src/engine/match';
import { quickVsPal } from './peek-run';
import { nodeSource } from '../../src/engine/node-source';
import { loadProgram, Player } from '../../src/engine/player';
import { Vfs } from '../../src/engine/vfs';
import { World } from '../../src/engine/world';
import { compileExpr } from '../../src/expr/compile';
import { playerEnv } from '../../src/engine/triggers';
import { MugenAI } from '../../src/engine/ai';
import { parseAir } from '../../src/formats/air';
import { parseSff } from '../../src/formats/sff';
import { FightHud } from '../../src/motif/fight';
import { loadStage } from '../../src/stage/stage';

const [ticksArg, out, c1, c2, seedArg, aiArg, stageArg] = process.argv.slice(2);
if (!ticksArg || !out || !c1 || !c2 || !seedArg) throw new Error('usage: peek-ours.ts ticks out char1 char2 seed [ai1,ai2] [stage]');
const ROOT = join(import.meta.dirname, '..', '..');
const vfs = new Vfs(nodeSource(join(ROOT, 'ref', 'mugen-1.1b1')));
const prog1 = await loadProgram(vfs, await loadCharacter(vfs, `chars/${c1}/${c1}.def`));
const prog2 = c2 === c1 ? prog1 : await loadProgram(vfs, await loadCharacter(vfs, `chars/${c2}/${c2}.def`));
const stage = await loadStage(vfs, `stages/${stageArg ?? 'kfm'}.def`);
const hud = await FightHud.load(vfs, process.env.FIGHTDEF ?? 'data/fight.def');
const w = new World();
w.applyStage(stage.info);
w.fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
const levels = (aiArg ?? '4,4').split(',').map(Number);
// P3 / P4 (env): simul partners, as mugen.exe's quick VS -p3 / -p4.
const partner = [process.env.P3, process.env.P4];
const partnerProg = await Promise.all(partner.map(async (c) => (c ? loadProgram(vfs, await loadCharacter(vfs, `chars/${c}/${c}.def`)) : undefined)));
const mkPlayer = (prog: typeof prog1, side: number, slot: number) => {
  const p = new Player(prog, w, side);
  p.palNo = quickVsPal(prog.data.def.palDefaults, slot);
  p.ai = new MugenAI(p, levels[side] ?? 4);
  p.warn = (msg) => console.error(`${p.name}: ${msg}`);
  return p;
};
const teams = [0, 1].map((side) => {
  const pp = partnerProg[side];
  return {
    mode: pp ? ('simul' as const) : ('single' as const),
    count: pp ? 2 : 1,
    spawn: (_m: number, k: number) => mkPlayer(k ? pp! : side ? prog2 : prog1, side, side + 1 + 2 * k),
  };
}) as [import('../../src/engine/match').TeamPlan, import('../../src/engine/match').TeamPlan];
const m = new Match(w, hud.roundConfig(), [stage.info.p1, stage.info.p2, stage.info.p3, stage.info.p4], { teams, quickVs: true });
const [p1, p2] = [w.slot(1)!, w.slot(2)!];
const lines: string[] = [];
let seeded = false;
const seedAt = seedArg.includes(':') ? (seedArg.split(':').map(Number) as [number, number]) : undefined;
const ticks = Number(ticksArg);
if (seedAt && seedAt[0] === 0) {
  w.seed = seedAt[1];
  seeded = true;
}
for (let i = 1; i <= ticks; i++) {
  const go = m.tick();
  if (!seeded && !seedAt && w.roundState === 2) {
    w.seed = Number(seedArg);
    seeded = true;
  }
  const evalAt = process.env.EVALAT?.split('-').map(Number);
  if (process.env.EVAL && evalAt && i >= evalAt[0]! && i <= (evalAt[1] ?? evalAt[0]!)) {
    // Evaluate expressions on P1 right before this tick (EVAL='a;b;c').
    for (const e of process.env.EVAL.split(';')) {
      // EVALSLOT=n: evaluate on player slot n instead of P1.
      const who = process.env.EVALSLOT ? (w.slot(Number(process.env.EVALSLOT)) ?? p1) : p1;
      const v = compileExpr(e, playerEnv)(who);
      console.log(`EVAL frame ${i} gt ${w.gameTime + 1} ${e} = ${v}`);
    }
  }
  if (go) w.tick([0, 0]);
  if (seedAt && !seeded && w.gameTime === seedAt[0]) {
    w.seed = seedAt[1];
    seeded = true;
  }
  const f = (x: number) => x.toFixed(4);
  // Frames, like mugen.exe's counter (G+0x11e98), which runs on through the KO slowdown.
  const row = [i, w.roundState, w.seed];
  const shown = [w.slot(1), w.slot(2), ...(partner.some(Boolean) ? [w.slot(3)] : []), ...(partner[1] ? [w.slot(4)] : [])].filter((p): p is Player => !!p);
  const pl = shown.flatMap((p: Player) => [p.stateNo, p.time, p.life, f(p.pos.x), f(p.pos.y), f(p.vel.x * p.facing), f(p.vel.y)]);
  if (process.env.AIQ) {
    const q = [p1, p2].flatMap((p) => [p.stateNo, p.time, p.hitPause, p.ai!.state, p.ai!.stateTime, p.ai!.queued, p.moveContact]);
    lines.push(`P|${i}|${[w.gameTime, w.roundState, w.seed, ...q].join(',')}`);
  } else if (process.env.VARS) {
    // mugen.exe's enums: statetype S=1 C=2 A=3 L=4, movetype I=0 A=1 H=2.
    const st = { s: 1, c: 2, a: 3, l: 4 }[p1.stateType as string] ?? 0;
    const mt = { i: 0, a: 1, h: 2 }[p1.moveType as string] ?? 0;
    const fv = Array.from(p1.fvars, (x) => x.toFixed(4));
    lines.push(`P|${i}|${[w.gameTime, w.roundState, w.seed, p1.stateNo, p1.ctrl ? 1 : 0, st, mt, p1.power, ...p1.vars, ...fv, p1.inGuardDist() ? 1 : 0, (p1.pos.y * 2).toFixed(4)].join(',')}`);
  } else {
    // CAM=1: the camera in mugen.exe units (camera_offset_x / _y) at the end of each row.
    const cam = process.env.CAM ? [w.camera.x * (w.gameWidth / w.screenWidth), w.camera.y * (w.gameWidth / w.screenWidth)].map(f) : [];
    lines.push(`P|${i}|${[...row, ...pl, ...cam].join(',')}`);
  }
  if (m.finished) break;
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`${lines.length} lines -> ${out}`);
