import { describe, expect, it } from 'vitest';
import { CommandInput, IN_X, parseCmd } from '../src/engine/cmd';


describe('CommandInput.reset', () => {
  it('forgets the command history (Player_Reset every round)', () => {
    const set = parseCmd('[Command]\nname = "x"\ncommand = x\n\n[Command]\nname = "tap"\ncommand = ~x, x\ntime = 30\n');
    const run = (ci: CommandInput, raw: number, t: number) => ci.tick(raw, 1, t, false);

    const kept = new CommandInput(set);
    let t = 1;
    run(kept, IN_X, t++);
    run(kept, IN_X, t++);
    run(kept, 0, t++);
    run(kept, 0, t++);
    run(kept, IN_X, t++);
    run(kept, IN_X, t++);
    expect(kept.active().has('tap')).toBe(true);

    const cleared = new CommandInput(set);
    t = 1;
    run(cleared, IN_X, t++);
    run(cleared, IN_X, t++);
    run(cleared, 0, t++);
    run(cleared, 0, t++);
    cleared.reset();
    run(cleared, IN_X, t++);
    run(cleared, IN_X, t++);
    expect(cleared.active().has('tap')).toBe(false);
  });
});
