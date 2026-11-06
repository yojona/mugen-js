import { describe, expect, it } from 'vitest';
import { IN_A, IN_D, IN_R, IN_X } from '../src/engine/cmd';
import { Pad } from '../src/app/input';
import { SelectScreen, resetSelectMemory, type RosterChar } from '../src/app/select';
import type { GameMode } from '../src/app/title';

function make(mode: GameMode) {
  resetSelectMemory();
  const pads = [new Pad(), new Pad()];
  const values: Record<string, string> = { rows: '1', columns: '3', 'teammenu.move.wrapping': '1' };
  const ctx = {
    renderer: {},
    mixer: { play() {} },
    keys: { pads, escape: false },
    aiLevel: 1,
    motif: {
      value: (_s: string, k: string) => values[k],
      section: () => undefined,
      localCoord: [320, 240],
      backgrounds: new Map(),
      assets: {},
      fonts: [],
      snd: undefined,
    },
  };
  const mk = (n: string): RosterChar => ({
    entry: { def: n } as never,
    data: {
      def: { displayName: n, localCoord: [320, 240], palKeymap: [1, 2, 3, 4, 5, 6, 1, 1, 1, 1, 1, 1], palMask: 3 },
      palettes: [new Uint8Array(1), new Uint8Array(1)],
    } as never,
    defPath: n,
  });
  const roster = [mk('a'), mk('b'), mk('c')];
  const sel = new SelectScreen(ctx as never, mode, roster, []);
  const press = (pad: number, bit: number) => {
    pads[pad]!.latch();
    pads[pad]!.bits = bit;
    sel.tick();
    pads[pad]!.latch();
    pads[pad]!.bits = 0;
    sel.tick();
  };
  return { sel, press };
}

describe('team select', () => {
  it('team arcade: simul menu, two picks by P1, CPU partner, computer team by mode', () => {
    const { sel, press } = make('teamarcade');
    press(0, IN_X); // P1 menu: simul (initial item), confirm
    press(0, IN_X); // first character
    press(0, IN_R);
    press(0, IN_X); // second character
    press(0, IN_X); // opponent menu: simul
    for (let i = 0; i < 20; i++) sel.tick();
    for (let i = 0; i < 20 && !sel.result; i++) sel.tick();
    const t = sel.result!.teams!;
    expect(t[0].mode).toBe('simul');
    expect(t[0].picks.map((p) => p.char.entry.def)).toEqual(['a', 'b']);
    expect(t[0].ai).toEqual([false, true]);
    expect(t[1]).toMatchObject({ mode: 'simul', picks: [], count: 2 });
    expect(sel.result!.p1.char.entry.def).toBe('a');
  });

  it('team arcade: turns menu value picks 3 characters', () => {
    const { sel, press } = make('teamarcade');
    press(0, IN_D); // item turns
    press(0, IN_R); // value 3
    press(0, IN_X);
    press(0, IN_X);
    press(0, IN_R);
    press(0, IN_X);
    press(0, IN_A);
    press(0, IN_X); // opponent: single
    for (let i = 0; i < 40 && !sel.result; i++) sel.tick();
    const t = sel.result!.teams!;
    expect(t[0]).toMatchObject({ mode: 'turns', count: 3 });
    expect(t[0].picks).toHaveLength(3);
  });

  it('team coop: second character by the other pad, both human', () => {
    const { sel, press } = make('teamcoop');
    press(0, IN_X);
    press(1, IN_R);
    press(1, IN_X);
    press(0, IN_X); // enemy menu
    for (let i = 0; i < 40 && !sel.result; i++) sel.tick();
    const t = sel.result!.teams!;
    expect(t[0].ai).toEqual([false, false]);
    expect(t[0].picks.map((p) => p.char.entry.def)).toEqual(['a', 'b']);
  });
});
