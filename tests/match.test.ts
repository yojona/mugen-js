import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCharacter } from '../src/engine/character';
import { Match } from '../src/engine/match';
import { nodeSource } from '../src/engine/node-source';
import { loadProgram, Player, type CharacterProgram } from '../src/engine/player';
import { Vfs } from '../src/engine/vfs';
import { World } from '../src/engine/world';
import { FightHud } from '../src/motif/fight';
import { loadStage } from '../src/stage/stage';

let prog: CharacterProgram;
let hud: FightHud;
let vfs: Vfs;

beforeAll(async () => {
  vfs = new Vfs(nodeSource(join(__dirname, '..', 'ref', 'mugen-1.1b1')));
  prog = await loadProgram(vfs, await loadCharacter(vfs, 'chars/kfm/kfm.def'));
  hud = await FightHud.load(vfs);
});

function setup() {
  const w = new World();
  const p1 = new Player(prog, w, 0);
  const p2 = new Player(prog, w, 1);
  w.players.push(p1, p2);
  const m = new Match(w, hud.roundConfig(), [
    { x: -70, y: 0, facing: 1 },
    { x: 70, y: 0, facing: -1 },
  ]);
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) if (m.tick()) w.tick([0, 0]);
  };
  const untilFight = () => {
    for (let i = 0; i < 600 && w.roundState !== 2; i++) step();
  };
  return { w, p1, p2, m, step, untilFight };
}

describe('match flow', () => {
  it('announces the round, then Fight, then gives control', () => {
    const { w, p1, m, step } = setup();
    const seen = new Set<string>();
    for (let i = 0; i < 400 && w.roundState !== 2; i++) {
      step();
      if (m.announce) seen.add(m.announce.kind);
      if (w.roundState < 2) expect(p1.ctrl).toBe(false);
    }
    expect(seen).toEqual(new Set(['round', 'fight']));
    expect(w.roundState).toBe(2);
    expect(p1.ctrl).toBe(true);
  });

  it('counts down the clock', () => {
    const { m, step, untilFight } = setup();
    untilFight();
    expect(m.clockSeconds).toBe(99);
    step(61);
    expect(m.clockSeconds).toBe(98);
  });

  it('KO ends the round, the winner scores and round 2 starts with full life', () => {
    const { w, p1, p2, m, step, untilFight } = setup();
    untilFight();
    p2.life = 0;
    step();
    expect(m.announce?.kind).toBe('ko');
    expect(w.roundState).toBe(3);
    step(400);
    expect(m.round).toBe(2);
    expect(m.wins).toEqual([1, 0]);
    expect(p2.life).toBe(1000);
    expect(p1.life).toBe(1000);
  });

  it('two round wins end the match with a win announcement', () => {
    const { p2, m, step, untilFight } = setup();
    for (let r = 0; r < 2; r++) {
      untilFight();
      p2.life = 0;
      step(300);
    }
    expect(m.wins[0]).toBe(2);
    expect(m.matchOver).toBe(true);
    expect(m.announce?.kind).toBe('win');
  });

  it('time over gives the round to the player with more life', () => {
    const { p1, m, step, untilFight } = setup();
    untilFight();
    p1.life = 500;
    step(99 * 60 + 2);
    expect(m.announce?.kind).toBe('to');
    step(400);
    expect(m.wins).toEqual([0, 1]);
  });
});

describe('stage loading', () => {
  it('loads every stage in the reference data', async () => {
    for (const f of ['stages/kfm.def', 'stages/stage0.def', 'stages/stage0-720.def']) {
      const s = await loadStage(vfs, f);
      expect(s.elements.length, f).toBeGreaterThan(0);
      for (const e of s.elements) {
        if (e.type === 'dummy' || e.actionNo >= 0) continue;
        expect(s.sff.get(e.spriteNo[0], e.spriteNo[1]), `${f} ${e.name}`).toBeDefined();
      }
    }
  });
});

describe('mixed coordinate spaces (kfm 320 vs kfm720 1280)', () => {
  it('walks the same world distance and collides at the same distance', async () => {
    const hd = await loadProgram(vfs, await loadCharacter(vfs, 'chars/kfm720/kfm720.def'));
    const w = new World();
    const a = new Player(prog, w, 0);
    const b = new Player(hd, w, 1);
    w.players.push(a, b);
    expect(a.scale).toBe(1);
    expect(b.scale).toBe(0.25);
    a.setWorldPos(-100, 0);
    b.setWorldPos(100, 0);
    b.facing = -1;
    a.changeState(0);
    b.changeState(0);
    // Hold forward for both (P2 faces left, so forward is left).
    for (let i = 0; i < 20; i++) w.tick([8, 4]);
    const da = a.wx + 100;
    const db = 100 - b.wx;
    expect(da).toBeGreaterThan(20);
    expect(Math.abs(da - db)).toBeLessThan(da * 0.25);
    // Walk into each other: the push keeps world bodies apart by ~ both widths.
    for (let i = 0; i < 120; i++) w.tick([8, 4]);
    const gap = b.wx - a.wx;
    expect(gap).toBeGreaterThan(20);
    expect(gap).toBeLessThan(40);
  });
});
