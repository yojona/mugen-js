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
      expect(p1.ctrl).toBe(false);
    }
    expect(seen).toEqual(new Set(['round', 'fight']));
    expect(w.roundState).toBe(2);
    // Control arrives ctrl.time (30) ticks after RoundState 2 (measured against MUGEN 1.1).
    step(29);
    expect(p1.ctrl).toBe(false);
    step(1);
    expect(p1.ctrl).toBe(true);
  });

  it('counts down the clock', () => {
    const { m, step, untilFight } = setup();
    untilFight();
    expect(m.clockSeconds).toBe(99);
    // The clock starts at ctrl.time (30): 100 * 60 - 1 ticks, 99 shown.
    step(30 + 60);
    expect(m.clockSeconds).toBe(98);
  });

  it('KO ends the round, the winner scores and round 2 starts with full life', () => {
    const { w, p1, p2, m, step, untilFight } = setup();
    untilFight();
    p2.life = 0;
    step();
    expect(m.announce?.kind).toBe('ko');
    expect(w.roundState).toBe(3);
    // Nobody settles here (P1 never got control, P2 falls in place), so the
    // round ends on the 900-tick limit (mugen.exe 0x414d9f).
    for (let i = 0; i < 2000 && m.round === 1; i++) step();
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
      for (let i = 0; i < 2000 && m.round === r + 1 && !m.matchOver; i++) step();
    }
    step(400);
    expect(m.wins[0]).toBe(2);
    expect(m.matchOver).toBe(true);
    expect(m.announce?.kind).toBe('win');
  });

  it('time over gives the round to the player with more life', () => {
    const { p1, m, step, untilFight } = setup();
    untilFight();
    p1.life = 500;
    step(30 + 100 * 60 + 1);
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

describe('camera', () => {
  it('does not oscillate when players are far apart (jumping forward from the left edge)', async () => {
    const st = await loadStage(vfs, 'stages/kfm.def');
    const w = new World();
    w.applyStage(st.info);
    w.screenWidth = Math.round((240 * 16) / 9);
    const p1 = new Player(prog, w, 0);
    const p2 = new Player(prog, w, 1);
    w.players.push(p1, p2);
    p1.setWorldPos(-70, 0);
    p2.setWorldPos(70, 0);
    p2.facing = -1;
    p1.changeState(0);
    p2.changeState(0);
    for (let i = 0; i < 200; i++) w.tick([4, 0]); // walk to the left edge
    const xs: number[] = [];
    for (let i = 0; i < 60; i++) {
      w.tick([i < 2 ? 1 | 8 : 0, 0]); // up + forward
      xs.push(w.camera.x);
    }
    // The camera may only move one way while P1 travels right.
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]! - 1e-6);
  });
});

describe('content fixes', () => {
  it('kfm720 no longer gets stuck mid-air after a knock-down', async () => {
    const { withContentFixes } = await import('../src/engine/content-fixes');
    const fixed = new Vfs(withContentFixes(nodeSource(join(__dirname, '..', 'ref', 'mugen-1.1b1'))));
    const hd = await loadProgram(fixed, await loadCharacter(fixed, 'chars/kfm720/kfm720.def'));
    const w = new World();
    const a = new Player(prog, w, 0);
    const b = new Player(hd, w, 1);
    w.players.push(a, b);
    a.setWorldPos(-25);
    b.setWorldPos(25);
    b.facing = -1;
    a.changeState(0);
    b.changeState(0);
    // Kung Fu Palm (QCF + x) knocks kfm720 down.
    for (const bits of [2, 2 | 8, 8, 8 | 128]) w.tick([bits, 0]);
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) {
      w.tick([0, 0]);
      seen.add(b.stateNo);
    }
    expect(seen.has(5101)).toBe(true);
    expect(seen.has(5110)).toBe(true); // reached the ground instead of hovering in 5101
    expect(b.stateNo).toBe(0);
    expect(b.pos.y).toBe(0);
  });
});
