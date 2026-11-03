// CNS / ST / CMD state files: [Statedef n] blocks with [State n, label] controllers,
// plus the character constants ([Data], [Size], [Velocity], [Movement]).

import { parseIni, type Entry, type IniDoc } from '../formats/text';

export interface ControllerDef {
  /** Lowercased controller type, e.g. "changestate". */
  type: string;
  label: string;
  /** triggerall conditions (AND). */
  triggerAll: string[];
  /** trigger1..N; each group is AND, groups are OR. Stops at the first gap. */
  triggers: string[][];
  /** Remaining parameters (lowercased keys; first occurrence wins). */
  params: Map<string, string>;
  file: string;
  line: number;
}

export interface StateDef {
  number: number;
  params: Map<string, string>;
  controllers: ControllerDef[];
  file: string;
  line: number;
}

export type StateMap = Map<number, StateDef>;

/** atoi: optional blanks and sign, then digits (0 if none). */
function atoi(s: string): number {
  const m = /^[ \t]*([-+]?\d+)/.exec(s);
  return m ? parseInt(m[1]!, 10) : 0;
}
const TRIGGER_RE = /^trigger(all|\d+)$/;

/**
 * Parse state definitions. If `into` is given, states already present are kept
 * (first definition wins, which is how character states override common1.cns
 * when files are loaded in priority order). This applies to the special states
 * -1/-2/-3 too: MUGEN 1.1 ignores a later [Statedef -2] (measured).
 */
export function parseStates(text: string, file: string, into: StateMap = new Map()): StateMap {
  const doc = parseIni(text);
  let cur: StateDef | null = null;
  let skip = false;
  for (const sec of doc.sections) {
    // mugen.exe (load_statedefs / StateDef_Parse 0x45B210): a group named
    // "Statedef <atoi>", then every following group whose name starts with
    // "State " is one of its controllers, whatever its label; the first other
    // group ends the list.
    if (/^statedef /i.test(sec.name)) {
      const number = atoi(sec.name.slice(9));
      const existing = into.get(number);
      if (existing) {
        // Duplicate statedef: the earlier one wins, special states included
        // (measured against MUGEN 1.1 with two [Statedef -2] blocks).
        cur = null;
        skip = true;
        continue;
      }
      skip = false;
      cur = { number, params: paramMap(sec.entries), controllers: [], file, line: sec.line };
      into.set(number, cur);
      continue;
    }
    if (/^state /i.test(sec.name)) {
      if (skip || !cur) continue;
      const comma = sec.name.indexOf(',');
      cur.controllers.push(controllerFrom(sec.entries, comma < 0 ? '' : sec.name.slice(comma + 1).trim(), file, sec.line));
    } else {
      cur = null;
    }
  }
  return into;
}

/**
 * The key Ini_GetValue finds a line under: it matches a key at the start of
 * the line followed by a blank or '=', so "value >= 0" is read as value and
 * "Type<full-width space> = x" as type.
 */
function iniKey(key: string): string {
  // VarSet's "var(n) = x" lines are read whole (parse_var_line).
  if (/^(sys)?f?var\s*\(/.test(key)) return key;
  return key.split(/[ \t\v\f]/)[0]!;
}

function paramMap(entries: Entry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) {
    const k = iniKey(e.key);
    if (!m.has(k)) m.set(k, e.value);
  }
  return m;
}

function controllerFrom(entries: Entry[], label: string, file: string, line: number): ControllerDef {
  const triggerAll: string[] = [];
  const groups = new Map<number, string[]>();
  const params = new Map<string, string>();
  let type = '';
  for (const raw of entries) {
    const e = { ...raw, key: iniKey(raw.key) };
    const tm = TRIGGER_RE.exec(e.key);
    if (tm) {
      if (tm[1] === 'all') triggerAll.push(e.value);
      else {
        const n = parseInt(tm[1]!, 10);
        const g = groups.get(n) ?? [];
        g.push(e.value);
        groups.set(n, g);
      }
    } else if (e.key === 'type') {
      // Ini_GetValue returns the first occurrence of a key.
      if (!type) type = e.value.toLowerCase().trim();
    } else if (!params.has(e.key)) params.set(e.key, e.value);
  }
  // trigger1, trigger2, ... in order; a missing number ends the list.
  const triggers: string[][] = [];
  for (let n = 1; groups.has(n); n++) triggers.push(groups.get(n)!);
  return { type, label, triggerAll, triggers, params, file, line };
}

// ---------------------------------------------------------------------------
// Constants

/** Flattened constants keyed by Const() name, e.g. "velocity.walk.fwd.x". */
export type Constants = Map<string, number>;

const DEFAULTS: Record<string, number> = {
  'data.life': 1000,
  'data.power': 3000,
  'data.attack': 100,
  'data.defence': 100,
  'data.fall.defence_up': 50,
  'data.liedown.time': 60,
  'data.airjuggle': 15,
  'data.sparkno': 2,
  'data.guard.sparkno': 40,
  'data.ko.echo': 0,
  'data.volume': 0,
  'data.intpersistindex': 60,
  'data.floatpersistindex': 40,
  'size.xscale': 1,
  'size.yscale': 1,
  'size.ground.back': 15,
  'size.ground.front': 16,
  'size.air.back': 12,
  'size.air.front': 12,
  'size.height': 60,
  'size.attack.dist': 160,
  'size.proj.attack.dist': 90,
  'size.proj.doscale': 0,
  'size.head.pos.x': -5,
  'size.head.pos.y': -90,
  'size.mid.pos.x': -5,
  'size.mid.pos.y': -60,
  'size.shadowoffset': 0,
  'size.draw.offset.x': 0,
  'size.draw.offset.y': 0,
  'velocity.walk.fwd.x': 2.4,
  'velocity.walk.back.x': -2.2,
  'velocity.run.fwd.x': 4.6,
  'velocity.run.fwd.y': 0,
  'velocity.run.back.x': -4.5,
  'velocity.run.back.y': -3.8,
  'velocity.jump.y': -8.4,
  'velocity.jump.neu.x': 0,
  'velocity.jump.back.x': -2.55,
  'velocity.jump.fwd.x': 2.5,
  'velocity.runjump.back.x': -2.55,
  'velocity.runjump.back.y': -8.1,
  'velocity.runjump.fwd.x': 4,
  'velocity.runjump.fwd.y': -8.1,
  'velocity.airjump.y': -8.1,
  'velocity.airjump.neu.x': 0,
  'velocity.airjump.back.x': -2.55,
  'velocity.airjump.fwd.x': 2.5,
  'velocity.air.gethit.groundrecover.x': -0.15,
  'velocity.air.gethit.groundrecover.y': -3.5,
  'velocity.air.gethit.airrecover.mul.x': 0.5,
  'velocity.air.gethit.airrecover.mul.y': 0.2,
  'velocity.air.gethit.airrecover.add.x': 0,
  'velocity.air.gethit.airrecover.add.y': -4.5,
  'velocity.air.gethit.airrecover.back': -1,
  'velocity.air.gethit.airrecover.fwd': 0,
  'velocity.air.gethit.airrecover.up': -2,
  'velocity.air.gethit.airrecover.down': 1.5,
  'movement.airjump.num': 0,
  'movement.airjump.height': 35,
  'movement.yaccel': 0.44,
  'movement.stand.friction': 0.85,
  'movement.crouch.friction': 0.82,
  'movement.stand.friction.threshold': 2,
  'movement.crouch.friction.threshold': 0,
  'movement.jump.changeanim.threshold': 0,
  'movement.air.gethit.groundlevel': 10,
  'movement.air.gethit.groundrecover.ground.threshold': -20,
  'movement.air.gethit.groundrecover.groundlevel': 10,
  'movement.air.gethit.airrecover.threshold': -1,
  'movement.air.gethit.airrecover.yaccel': 0.35,
  'movement.air.gethit.trip.groundlevel': 15,
  'movement.down.bounce.offset.x': 0,
  'movement.down.bounce.offset.y': 20,
  'movement.down.bounce.yaccel': 0.4,
  'movement.down.bounce.groundlevel': 12,
  'movement.down.friction.threshold': 0.05,
};

/** Constants that are floats (all others are ints), per trigger.html Const(). */
const FLOAT_PREFIXES = ['velocity.', 'movement.yaccel', 'movement.stand.', 'movement.crouch.', 'movement.jump.', 'movement.air.', 'movement.down.', 'size.xscale', 'size.yscale', 'data.fall.defence_mul'];

export function isFloatConst(name: string): boolean {
  return FLOAT_PREFIXES.some((p) => name.startsWith(p));
}

/** Parameters whose single value means "x" (or the value itself) rather than a pair. */
const SCALAR_VELOCITY = new Set(['walk.fwd', 'walk.back', 'jump.back', 'jump.fwd', 'airjump.back', 'airjump.fwd']);

export function parseConstants(docs: IniDoc[], defaults = DEFAULTS): Constants {
  const c: Constants = new Map(Object.entries(defaults));
  for (const doc of docs) {
    for (const sec of doc.sections) {
      const group = sec.name.toLowerCase();
      if (!['data', 'size', 'velocity', 'movement'].includes(group)) continue;
      for (const e of sec.entries) {
        const parts = e.value.split(',').map((s) => parseFloat(s.trim()));
        const base = `${group}.${e.key}`;
        if (group === 'velocity' && (e.key === 'jump.neu' || e.key === 'airjump.neu')) {
          const stem = e.key === 'jump.neu' ? 'jump' : 'airjump';
          if (Number.isFinite(parts[0])) c.set(`velocity.${stem}.neu.x`, parts[0]!);
          if (Number.isFinite(parts[1])) c.set(`velocity.${stem}.y`, parts[1]!);
          continue;
        }
        if (group === 'velocity' && SCALAR_VELOCITY.has(e.key)) {
          if (Number.isFinite(parts[0])) c.set(`${base}.x`, parts[0]!);
          continue;
        }
        if (parts.length >= 2 && (c.has(`${base}.x`) || group === 'velocity' || e.key.endsWith('.pos') || e.key.endsWith('offset'))) {
          if (Number.isFinite(parts[0])) c.set(`${base}.x`, parts[0]!);
          if (Number.isFinite(parts[1])) c.set(`${base}.y`, parts[1]!);
          continue;
        }
        if (c.has(`${base}.x`) && Number.isFinite(parts[0])) {
          // Pair constant given a single value: only x is set.
          c.set(`${base}.x`, parts[0]!);
          continue;
        }
        if (Number.isFinite(parts[0])) c.set(base, parts[0]!);
      }
    }
  }
  const up = c.get('data.fall.defence_up') ?? 50;
  c.set('data.fall.defence_mul', 100 / (up + 100));
  return c;
}
