import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCharacter } from '../src/engine/character';
import { IN_A, IN_D, IN_L, IN_R, IN_U, IN_X } from '../src/engine/cmd';
import { nodeSource } from '../src/engine/node-source';
import { loadProgram, Player, type CharacterProgram } from '../src/engine/player';
import { Vfs } from '../src/engine/vfs';
import { World } from '../src/engine/world';

let prog: CharacterProgram;

beforeAll(async () => {
  const vfs = new Vfs(nodeSource(join(__dirname, '..', 'ref', 'mugen-1.1b1')));
  prog = await loadProgram(vfs, await loadCharacter(vfs, 'chars/kfm/kfm.def'));
});

function match(): { w: World; p1: Player; p2: Player } {
  const w = new World();
  const p1 = new Player(prog, w, 0);
  const p2 = new Player(prog, w, 1);
  p1.pos.x = -70;
  p2.pos.x = 70;
  p2.facing = -1;
  w.players.push(p1, p2);
  p1.changeState(0);
  p2.changeState(0);
  return { w, p1, p2 };
}

function run(w: World, ticks: number, input = 0): void {
  for (let i = 0; i < ticks; i++) w.tick([input, 0]);
}

describe('kfm state machine', () => {
  it('loads every state without compile errors', () => {
    const w = new World();
    const p = new Player(prog, w, 0);
    for (const no of prog.states.keys()) p.compiledState(no);
    expect(p.warnings).toEqual([]);
    expect(prog.states.size).toBeGreaterThan(100);
  });

  it('stands idle', () => {
    const { w, p1 } = match();
    run(w, 30);
    expect(p1.stateNo).toBe(0);
    expect(p1.animNo).toBe(0);
    expect(p1.ctrl).toBe(true);
  });

  it('walks forward and back', () => {
    const { w, p1 } = match();
    const x0 = p1.pos.x;
    run(w, 10, IN_R);
    expect(p1.stateNo).toBe(20);
    expect(p1.animNo).toBe(20);
    expect(p1.pos.x).toBeGreaterThan(x0 + 15);
    run(w, 5, 0);
    expect(p1.stateNo).toBe(0);
    run(w, 5, IN_L);
    expect(p1.animNo).toBe(21);
  });

  it('crouches and stands up', () => {
    const { w, p1 } = match();
    run(w, 20, IN_D);
    expect(p1.stateNo).toBe(11);
    expect(p1.stateType).toBe('c');
    run(w, 20, 0);
    expect(p1.stateNo).toBe(0);
  });

  it('jumps, lands and recovers control', () => {
    const { w, p1 } = match();
    run(w, 2, IN_U);
    expect([40, 50]).toContain(p1.stateNo);
    let minY = 0;
    let landed = false;
    for (let i = 0; i < 120; i++) {
      run(w, 1, 0);
      minY = Math.min(minY, p1.pos.y);
      if (p1.stateNo === 52) landed = true;
    }
    expect(minY).toBeLessThan(-60);
    expect(landed).toBe(true);
    expect(p1.stateNo).toBe(0);
    expect(p1.pos.y).toBe(0);
  });

  it('attacks with x and a', () => {
    const { w, p1 } = match();
    run(w, 1, IN_X);
    expect(p1.stateNo).toBe(200);
    expect(p1.moveType).toBe('a');
    run(w, 60, 0);
    expect(p1.stateNo).toBe(0);
    run(w, 1, IN_A);
    expect(p1.stateNo).toBe(230);
  });

  it('performs a quarter-circle special (QCF + x)', () => {
    const { w, p1 } = match();
    for (const bits of [IN_D, IN_D, IN_D | IN_R, IN_D | IN_R, IN_R, IN_R | IN_X]) run(w, 1, bits);
    expect(p1.stateNo).toBe(1000);
  });

  it('shows each element for its exact time and never draws a wrapped frame', () => {
    const { w, p1 } = match();
    run(w, 5);
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      w.tick([IN_D, 0]);
      const e = p1.anim.current!;
      seen.push(`${p1.animNo}:${e.group},${e.number}`);
    }
    // Action 10 = 11,0 x2 then 11,1 x2, then crouch (action 11) with no stand frame between.
    expect(seen).toEqual(['10:11,0', '10:11,0', '10:11,1', '10:11,1', '11:11,2', '11:11,2']);
  });
});
