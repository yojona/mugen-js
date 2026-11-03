import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The engine runs in the browser: Node globals (process.env debug switches)
// throw there. Only node-source.ts may use Node APIs.
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('browser-safe sources', () => {
  it('no process.* outside node-source.ts', () => {
    const bad = files(join(__dirname, '..', 'src'))
      .filter((f) => !f.endsWith('node-source.ts'))
      .filter((f) => /\bprocess\.\w/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
