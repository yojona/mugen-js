// A CPU vs CPU match of any two characters, logged like a NOPROBE capture of
// mugen.exe (drive.py NOPROBE=1 with the standard PEEKALL fields):
//   P|frame|frame,roundstate,rng,{stateno,time,life,x,y,velx,vely} x2
// x/y/velocities are in character units (mugen.exe keeps internal units: the
// comparison scales them), velx in world space like mugen.exe.
import { join } from 'node:path';
import { MugenAI } from '../../src/engine/ai';
import { loadCharacter } from '../../src/engine/character';
import { Match } from '../../src/engine/match';
import { nodeSource } from '../../src/engine/node-source';
import { loadProgram, Player } from '../../src/engine/player';
import { Vfs } from '../../src/engine/vfs';
import { World } from '../../src/engine/world';
import { parseAir } from '../../src/formats/air';
import { parseSff } from '../../src/formats/sff';
import { FightHud } from '../../src/motif/fight';
import { loadStage } from '../../src/stage/stage';

export interface PeekOptions {
  chars: [string, string];
  frames: number;
  /** The match RNG before the first tick (a session draw + 1: 16808 for -sessionseed 1). */
  seed: number;
  ai?: [number, number];
  stage?: string;
}

export const REF_DIR = join(import.meta.dirname, '..', '..', 'ref', 'mugen-1.1b1');

export async function peekMatch(o: PeekOptions): Promise<string[]> {
  const vfs = new Vfs(nodeSource(REF_DIR));
  const [c1, c2] = o.chars;
  const prog1 = await loadProgram(vfs, await loadCharacter(vfs, `chars/${c1}/${c1}.def`));
  const prog2 = c2 === c1 ? prog1 : await loadProgram(vfs, await loadCharacter(vfs, `chars/${c2}/${c2}.def`));
  const stage = await loadStage(vfs, `stages/${o.stage ?? 'kfm'}.def`);
  const hud = await FightHud.load(vfs, 'data/fight.def');
  const w = new World();
  w.applyStage(stage.info);
  w.fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
  const p1 = new Player(prog1, w, 0);
  const p2 = new Player(prog2, w, 1);
  p2.palNo = 2;
  w.players.push(p1, p2);
  const levels = o.ai ?? [4, 4];
  [p1, p2].forEach((p, i) => (p.ai = new MugenAI(p, levels[i]!)));
  const m = new Match(w, hud.roundConfig(), [
    { x: stage.info.p1.x, y: stage.info.p1.y, facing: stage.info.p1.facing },
    { x: stage.info.p2.x, y: stage.info.p2.y, facing: stage.info.p2.facing },
  ]);
  w.seed = o.seed;
  const lines: string[] = [];
  const f = (x: number) => x.toFixed(4);
  for (let i = 1; i <= o.frames; i++) {
    if (m.tick()) w.tick([0, 0]);
    const pl = [p1, p2].flatMap((p) => [p.stateNo, p.time, p.life, f(p.pos.x), f(p.pos.y), f(p.vel.x * p.facing), f(p.vel.y)]);
    lines.push(`P|${i}|${[i, w.roundState, w.seed, ...pl].join(',')}`);
    if (m.finished) break;
  }
  return lines;
}

/** Compare with a mugen.exe capture by frame; `scale` = internal units per character unit. */
export function peekDiff(mugen: string, ours: string[], from: number, to: number, scale = 2, limit = 10): string[] {
  const load = (lines: string[]) => {
    const rows = new Map<number, string[]>();
    for (const line of lines) {
      if (!line.startsWith('P|')) continue;
      const v = line.split('|')[2]!.trim().split(',');
      if (v.includes('ERR')) continue;
      let gt = Number(v[0]);
      // A framestep read before the frame counter moved is the next frame,
      // unless nothing moved at all (a repeated read of the same frame).
      if (rows.has(gt)) {
        if (rows.get(gt)!.join(',') === v.slice(1).join(',')) continue;
        gt++;
      }
      rows.set(gt, v.slice(1));
    }
    return rows;
  };
  const m = load(mugen.split('\n'));
  const o = load(ours);
  const names = ['rs', 'rng', ...[1, 2].flatMap((s) => ['state', 'time', 'life', 'x', 'y', 'vx', 'vy'].map((k) => `p${s}.${k}`))];
  const out: string[] = [];
  for (let gt = from; gt <= to && out.length < limit; gt++) {
    const a = m.get(gt);
    const b = o.get(gt);
    if (!a || !b) continue;
    const bad: string[] = [];
    names.forEach((n, i) => {
      const x = Number(a[i]);
      let y = Number(b[i]);
      if (/\.(x|y|vx|vy)$/.test(n)) {
        y *= scale;
        if (Math.abs(x - y) > 0.01) bad.push(`${n} ${x}≠${y}`);
      } else if (x !== y) bad.push(`${n} ${a[i]}≠${b[i]}`);
    });
    if (bad.length) out.push(`frame ${gt}: ${bad.join(', ')}`);
  }
  return out;
}
