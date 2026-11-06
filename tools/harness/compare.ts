// Compare harness state logs (MUGEN vs mugen-web), aligned on the probe's
// script clock var(58). Both sides log S|step|side|vars(60)|fvars(40).

/** Fields the probe CNS captures (overlay/chars/probe/probe.st). */
const VARS: Record<number, string> = {
  40: 'stateno',
  41: 'prevstateno',
  42: 'anim',
  43: 'animtime',
  44: 'animelemno',
  45: 'time',
  46: 'ctrl',
  47: 'statetype',
  48: 'movetype',
  49: 'life',
  50: 'power',
  51: 'facing',
  52: 'hitpausetime',
  53: 'movecontact',
  54: 'hitshake/hitover',
  58: 'clock',
};
const FVARS: Record<number, string> = {
  30: 'pos x',
  31: 'pos y',
  32: 'vel x',
  33: 'vel y',
  34: 'screenpos x',
  35: 'p2dist x',
  36: 'camerapos x',
};

export interface Row {
  v: number[];
  f: number[];
}

export function parseLog(text: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  // The clock restarts every round (5900 clears the variables): later rounds
  // are keyed as round * 100000 + clock.
  const last = new Map<string, number>();
  const round = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('S|')) continue;
    const [, , side, vs, fs] = line.split('|');
    const v = vs!.split(',').map(Number);
    const f = (fs ?? '').split(',').map(Number);
    const clock = v[58]!;
    if (clock <= 0) continue; // compare from the moment the script runs
    const s = side!;
    if (clock < (last.get(s) ?? 0)) round.set(s, (round.get(s) ?? 0) + 1);
    last.set(s, clock);
    const key = `${(round.get(s) ?? 0) * 100000 + clock}|${side}`;
    if (!rows.has(key)) rows.set(key, { v, f });
  }
  return rows;
}

export interface CompareResult {
  compared: number;
  /** First differing "clock|side", if any. */
  first?: string;
  perField: Map<string, number>;
  reports: string[];
}

export function compareLogs(mugen: string, ours: string, maxReports = 40): CompareResult {
  const A = parseLog(mugen);
  const B = parseLog(ours);
  const keys = [...A.keys()].filter((k) => B.has(k)).sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));
  const perField = new Map<string, number>();
  const reports: string[] = [];
  let first: string | undefined;
  for (const k of keys) {
    const a = A.get(k)!;
    const b = B.get(k)!;
    const diffs: string[] = [];
    for (const [i, name] of Object.entries(VARS)) {
      if (a.v[+i] !== b.v[+i]) diffs.push(`${name} ${a.v[+i]}≠${b.v[+i]}`);
    }
    for (const [i, name] of Object.entries(FVARS)) {
      const x = a.f[+i]!;
      const y = b.f[+i]!;
      if (Math.abs(x - y) > 1e-3 * Math.max(1, Math.abs(x))) diffs.push(`${name} ${x}≠${y}`);
    }
    for (const d of diffs) perField.set(d.split(' ')[0]!, (perField.get(d.split(' ')[0]!) ?? 0) + 1);
    if (diffs.length) {
      first ??= k;
      if (reports.length < maxReports) reports.push(`clock ${k.replace('|', ' P')}: ${diffs.join(', ')}   (MUGEN≠ours)`);
    }
  }
  return { compared: keys.length, first, perField, reports };
}
