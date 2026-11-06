// The player's clipboard: DisplayToClipboard and AppendToClipboard (sctrl.c
// run_clipboard), shown by the debug display.

const SPECIFIER = /%([-+ #0]*)(\d*)(?:\.(\d+))?([a-zA-Z%])/g;

/** C's %g with the default precision. */
function general(v: number): string {
  return String(Number(v.toPrecision(6)));
}

function formatOne(value: number, flags: string, width: string, precision: string | undefined, kind: string): string {
  let s: string;
  if (kind === 'f' || kind === 'F') s = value.toFixed(precision === undefined ? 6 : Number(precision));
  else if (kind === 'e' || kind === 'E') s = value.toExponential(precision === undefined ? 6 : Number(precision));
  else if (kind === 'g' || kind === 'G') s = general(value);
  // A "%d" or "%i" given a float prints it with "%g".
  else s = Number.isInteger(value) ? String(value) : general(value);
  if (flags.includes('+') && value >= 0) s = `+${s}`;
  const w = Number(width) || 0;
  if (flags.includes('-')) return s.padEnd(w);
  return s.padStart(w, flags.includes('0') ? '0' : ' ');
}

/** The text with each parameter printed by its specifier; a bottom value prints as "(bottom)". */
export function formatClipboard(text: string, values: readonly (number | undefined)[]): string {
  let i = 0;
  return text
    .replace(SPECIFIER, (all, flags: string, width: string, precision: string | undefined, kind: string) => {
      if (kind === '%') return '%';
      if (i >= values.length) return all;
      const value = values[i++];
      return value === undefined ? '(bottom)' : formatOne(value, flags, width, precision, kind);
    })
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}
