import { describe, expect, it } from 'vitest';
import { formatClipboard } from '../src/engine/clipboard';

describe('formatClipboard', () => {
  it('prints each parameter by its specifier', () => {
    expect(formatClipboard('AI = %d - X = %f - Y = %5.2f', [1, 0.5, 2])).toBe('AI = 1 - X = 0.500000 - Y =  2.00');
  });
  it('prints a float given to %d with %g, and bottom as text', () => {
    expect(formatClipboard('%d %i', [1.5, undefined])).toBe('1.5 (bottom)');
  });
  it('keeps literal percents and turns \\n into lines', () => {
    expect(formatClipboard('100%%\\nnext', [])).toBe('100%\nnext');
  });
});
