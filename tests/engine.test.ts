import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCharacter } from '../src/engine/character';
import { IN_A, IN_D, IN_L, IN_R, IN_U, IN_X, IN_Y } from '../src/engine/cmd';
import { nodeSource } from '../src/engine/node-source';
import { loadProgram, Player, type CharacterProgram } from '../src/engine/player';
import { parseStates } from '../src/engine/cns';
import { Vfs } from '../src/engine/vfs';
import { World, type FightFx } from '../src/engine/world';
import { parseAir } from '../src/formats/air';
import { parseSff } from '../src/formats/sff';

let prog: CharacterProgram;
let fightFx: FightFx;

beforeAll(async () => {
  const vfs = new Vfs(nodeSource(join(__dirname, '..', 'ref', 'mugen-1.1b1')));
  prog = await loadProgram(vfs, await loadCharacter(vfs, 'chars/kfm/kfm.def'));
  fightFx = { anims: parseAir(await vfs.text('data/fightfx.air')), sff: await parseSff(await vfs.read('data/fightfx.sff')) };
});

function match(): { w: World; p1: Player; p2: Player } {
  const w = new World();
  w.fightFx = fightFx;
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

function run(w: World, ticks: number, input = 0, input2 = 0): void {
  for (let i = 0; i < ticks; i++) w.tick([input, input2]);
}

function close(): { w: World; p1: Player; p2: Player } {
  const m = match();
  m.p1.pos.x = -25;
  m.p2.pos.x = 25;
  return m;
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
    // Built-in transitions apply on the next tick (measured against MUGEN 1.1),
    // then action 10 = 11,0 x2 and 11,1 x2, then crouch (action 11) with no stand frame between.
    expect(seen).toEqual(['0:0,0', '10:11,0', '10:11,0', '10:11,1', '10:11,1', '11:11,2']);
  });
});

describe('kfm combat', () => {
  it('lands a standing punch: damage, hit pause, hit state and recovery', () => {
    const { w, p1, p2 } = close();
    run(w, 1, IN_X);
    let hitTick = -1;
    for (let i = 0; i < 30 && hitTick < 0; i++) {
      run(w, 1);
      if (p2.moveType === 'h') hitTick = i;
    }
    expect(hitTick).toBeGreaterThanOrEqual(0);
    expect(p2.stateNo).toBe(5000);
    // Damage lands one tick after the hit (measured against MUGEN 1.1).
    expect(p2.life).toBe(1000);
    run(w, 1);
    expect(p2.life).toBeLessThan(1000);
    expect(p1.moveHit).toBeGreaterThan(0);
    expect(p1.hitPause).toBeGreaterThan(0);
    const life = p2.life;
    run(w, 60);
    expect(p2.life).toBe(life); // a single HitDef hits once
    expect(p2.stateNo).toBe(0);
    expect(p2.ctrl).toBe(true);
    expect(p1.stateNo).toBe(0);
  });

  it('guards when holding back', () => {
    const { w, p1, p2 } = close();
    // P2 faces left, so "back" is right.
    run(w, 1, IN_X, IN_R);
    let guarded = false;
    let p1Guarded = false;
    for (let i = 0; i < 30; i++) {
      run(w, 1, 0, IN_R);
      if (p2.stateNo >= 150 && p2.stateNo <= 153) guarded = true;
      if (p1.moveGuarded > 0) p1Guarded = true;
    }
    expect(guarded).toBe(true);
    expect(p1Guarded).toBe(true);
    expect(p2.life).toBe(1000);
  });

  it('knocks down with the Kung Fu Palm and the opponent gets back up', () => {
    const { w, p1, p2 } = close();
    for (const bits of [IN_D, IN_D | IN_R, IN_R, IN_R | IN_X]) run(w, 1, bits);
    expect(p1.stateNo).toBe(1000);
    const states = new Set<number>();
    for (let i = 0; i < 240; i++) {
      run(w, 1);
      states.add(p2.stateNo);
    }
    expect(states.has(5000) || states.has(5020)).toBe(true);
    expect([...states].some((s) => s >= 5050 && s <= 5120)).toBe(true);
    expect(p2.stateNo).toBe(0);
    expect(p2.life).toBeLessThan(1000);
  });

  it('throws: P2 runs in P1-owned states, takes damage and returns to its own states', () => {
    const { w, p1, p2 } = match();
    p1.pos.x = -16;
    p2.pos.x = 16;
    run(w, 2);
    run(w, 1, IN_R | IN_Y);
    expect([800, 810]).toContain(p1.stateNo); // the grab can connect on its first tick
    let borrowed = false;
    let minY = 0;
    for (let i = 0; i < 60; i++) {
      run(w, 1);
      if (p2.stateOwner === p1) borrowed = true;
      minY = Math.min(minY, p2.pos.y);
    }
    expect(borrowed).toBe(true);
    expect(minY).toBeLessThan(-80); // carried over KFM's head by TargetBind
    expect(p2.life).toBeLessThan(1000);
    run(w, 240);
    expect(p2.stateOwner).toBeUndefined();
    expect(p2.stateNo).toBe(0);
  });

  it('super move: SuperPause freezes play, costs power and leaves afterimages', () => {
    const { w, p1, p2 } = close();
    p1.power = 3000;
    // The final forward is held one tick so the stand-up state (12) is entered
    // before the button: built-in transitions apply on the next tick, as in MUGEN.
    const seq = [IN_D, IN_D | IN_R, IN_R, 0, IN_D, IN_D | IN_R, IN_R, IN_R, IN_R | IN_X];
    for (const bits of seq) run(w, 1, bits);
    expect(p1.stateNo).toBe(3000);
    let paused = false;
    let after = false;
    let p2Hit = false;
    for (let i = 0; i < 120; i++) {
      run(w, 1);
      if (w.superPause) paused = true;
      if (p1.afterImage.history.length > 0) after = true;
      if (p2.moveType === 'h') p2Hit = true;
    }
    expect(paused).toBe(true);
    expect(after).toBe(true);
    expect(p2Hit).toBe(true);
    expect(p1.power).toBeLessThanOrEqual(2000 + 200);
  });
});

describe('helpers and projectiles (synthetic states on KFM data)', () => {
  const CNS = `
[Statedef 9000]
type = S
movetype = A
physics = S
anim = 0
ctrl = 0
[State 9000, spawn helper]
type = Helper
trigger1 = Time = 0
id = 7
name = "Clone"
stateno = 9100
pos = -40, 0
[State 9000, fire]
type = Projectile
trigger1 = Time = 1
projid = 5
projanim = 9999
velocity = 6, 0
offset = 20, -50
attr = S, SP
damage = 40
pausetime = 4, 6
ground.velocity = -3
ground.hittime = 12
ground.slidetime = 8
[State 9000, saw hit]
type = VarSet
trigger1 = ProjHit5 = 1
var(11) = 1
[State 9000, count]
type = VarSet
trigger1 = 1
var(12) = NumHelper(7)
[State 9000, done]
type = ChangeState
trigger1 = Time = 90
value = 0
ctrl = 1

[Statedef 9100]
type = S
movetype = I
physics = N
anim = 0
[State 9100, tell parent]
type = ParentVarSet
trigger1 = Time = 0
var(10) = 42
[State 9100, parent time]
type = VarSet
trigger1 = Time = 1
var(1) = parent, Time
[State 9100, bye]
type = DestroySelf
trigger1 = Time = 20
`;
  const AIR = `
[Begin Action 9999]
Clsn1Default: 1
 Clsn1[0] = -10, -10, 10, 10
Clsn2Default: 1
 Clsn2[0] = -10, -10, 10, 10
0,0, 0,0, -1
`;

  function synthetic(): { w: World; p1: Player; p2: Player } {
    const states = new Map(prog.states);
    parseStates(CNS, 'synthetic.cns', states);
    const anims = new Map(prog.data.anims);
    for (const [k, v] of parseAir(AIR)) anims.set(k, v);
    const prog2: CharacterProgram = { ...prog, states, compiled: new Map(), data: { ...prog.data, anims } };
    const w = new World();
    w.fightFx = fightFx;
    const p1 = new Player(prog2, w, 0);
    const p2 = new Player(prog, w, 1);
    p1.pos.x = -80;
    p2.pos.x = 60;
    p2.facing = -1;
    w.players.push(p1, p2);
    p1.changeState(0);
    p2.changeState(0);
    return { w, p1, p2 };
  }

  it('spawns a helper that talks to its parent and destroys itself', () => {
    const { w, p1 } = synthetic();
    p1.changeState(9000);
    run(w, 3);
    expect(w.helpers).toHaveLength(1);
    const h = w.helpers[0]!;
    expect(h.isHelper).toBe(true);
    expect(h.name).toBe('Clone');
    expect(h.pos.x).toBeCloseTo(p1.pos.x - 40, 0);
    expect(p1.vars[10]).toBe(42);
    expect(p1.vars[12]).toBe(1);
    expect(h.vars[1]).toBeGreaterThan(0); // read parent's Time through a redirect
    run(w, 30);
    expect(w.helpers).toHaveLength(0);
    expect(p1.vars[12]).toBe(0);
  });

  it('fires a projectile that hits P2 and reports ProjHit', () => {
    const { w, p1, p2 } = synthetic();
    p1.changeState(9000);
    let hit = false;
    for (let i = 0; i < 60; i++) {
      run(w, 1);
      if (p2.moveType === 'h') hit = true;
    }
    expect(hit).toBe(true);
    expect(p2.life).toBe(960);
    expect(p1.vars[11]).toBe(1);
    expect(w.projectiles).toHaveLength(0);
  });
});
