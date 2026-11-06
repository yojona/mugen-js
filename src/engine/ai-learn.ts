// MUGEN 1.1's AI learning layer, reverse-engineered from mugen.exe
// (0x42f800 start_record, 0x42f9c0 recorder_tick, 0x430330 finish_record,
// 0x432c90 merge_record, 0x4305f0 / 0x430660 messages).
//
// Every player (human or CPU) records each move it starts through a
// command-triggered state change: when its first hitbox appears, how far it
// travelled, the union of its Clsn boxes, its guard flags and attributes, and
// when it ended or gave back control. Records are kept per stateno and merged
// with an exponential average (0.05 new, 0.95 old). A CPU opponent "watches"
// a move it has a record for, guards it when the recorded hitbox would reach
// it, and picks its own recorded moves to counter.

import { hitAttrTypeBits } from './hitdef';
import type { Player } from './player';

/** Stat16 {mean, min, max, dev}; only the mean and deviation are ever read. */
export interface Stat {
  mean: number;
  dev: number;
}

export interface TimePos {
  time: Stat;
  dx: Stat;
  dy: Stat;
}

/** Union box as four Stat means (x1, y1, x2, y2), or null when unset (-FLT_MAX). */
export type BoxStat = [Stat, Stat, Stat, Stat] | null;

export interface StartEntry {
  stateNo: number;
  stateType: string;
  moveType: string;
  ctrl: boolean;
}

/** AttackRecord (0x4b4 bytes in mugen.exe). */
export interface AttackRecord {
  entries: StartEntry[];
  stateNo: number;
  stateType: string;
  cmd: number[];
  total: Stat;
  dx: Stat;
  dy: Stat;
  /** Last active tick, per contact kind (0 none, 1 guarded, 2 hit). */
  hit: [TimePos, TimePos, TimePos];
  /** Clsn1 and Clsn2 unions. */
  clsn: [BoxStat, BoxStat];
  guardFlag: number;
  attr: number;
  /** ReversalDef reversal.attr (p+0x12ec), 0 for a plain HitDef. */
  revAttr: number;
  /** First tick with control after contact kind k. */
  recov: [TimePos, TimePos, TimePos];
  end: [TimePos, TimePos, TimePos];
}

const f = Math.fround;
const ftoi = Math.trunc;
const stat = (v: number): Stat => ({ mean: f(v), dev: 0 });
const zero = (): Stat => ({ mean: 0, dev: 0 });
const tp = (): TimePos => ({ time: zero(), dx: zero(), dy: zero() });
const tpInit = (t: number, dx: number, dy: number): TimePos => ({ time: stat(t), dx: stat(dx), dy: stat(dy) });

/**
 * A character's learned AI file (<def name>.ai, read at load by mugen.exe
 * 0x42ef90): "ElecbyteAIB", version 0x100 and a date in a 0x40-byte header,
 * then for the standing/crouching and the air table a count and that many
 * raw AttackRecords (0x4b4 bytes each), then the idle Clsn2 unions.
 */
export function parseAiFile(buf: Uint8Array): { sc: RecordTable; air: RecordTable } | undefined {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 0x40 || new TextDecoder().decode(buf.subarray(0, 11)) !== 'ElecbyteAIB' || v.getInt32(0xc, true) !== 0x100)
    return undefined;
  const ST = ['', 's', 'c', 'a', 'l'];
  const MT = ['i', 'a', 'h'];
  const stat = (o: number): Stat => ({ mean: v.getFloat32(o, true), dev: v.getFloat32(o + 12, true) });
  const tpAt = (o: number): TimePos => ({ time: stat(o), dx: stat(o + 0x10), dy: stat(o + 0x20) });
  const box = (o: number): BoxStat =>
    v.getFloat32(o, true) === -3.4028234663852886e38 ? null : [stat(o), stat(o + 0x10), stat(o + 0x20), stat(o + 0x30)];
  const tables = [new Map(), new Map()] as [RecordTable, RecordTable];
  let o = 0x40;
  for (const t of tables) {
    if (o + 4 > buf.byteLength) return undefined;
    const n = v.getInt32(o, true);
    o += 4;
    for (let k = 0; k < n; k++, o += 0x4b4) {
      if (o + 0x4b4 > buf.byteLength) return undefined;
      const r = newRecord();
      const count = Math.min(32, v.getInt32(o + 0x200, true));
      for (let e = 0; e < count; e++) {
        const b = o + e * 16;
        r.entries.push({
          stateNo: v.getInt32(b, true),
          stateType: ST[v.getInt32(b + 4, true)] ?? '',
          moveType: MT[v.getInt32(b + 8, true)] ?? 'i',
          ctrl: v.getInt32(b + 12, true) !== 0,
        });
      }
      r.stateNo = v.getInt32(o + 0x204, true);
      r.stateType = ST[v.getInt32(o + 0x208, true)] ?? '';
      for (let c = 0; c < 10; c++) {
        const x = v.getInt32(o + 0x20c + c * 4, true);
        if (x === -1) break;
        r.cmd.push(x);
      }
      r.total = stat(o + 0x234);
      r.dx = stat(o + 0x244);
      r.dy = stat(o + 0x254);
      r.hit = [tpAt(o + 0x264), tpAt(o + 0x294), tpAt(o + 0x2c4)];
      r.clsn = [box(o + 0x2f4), box(o + 0x334)];
      r.guardFlag = v.getInt32(o + 0x378, true);
      r.attr = v.getInt32(o + 0x37c, true);
      r.revAttr = v.getInt32(o + 0x380, true);
      r.recov = [tpAt(o + 0x394), tpAt(o + 0x3c4), tpAt(o + 0x3f4)];
      r.end = [tpAt(o + 0x424), tpAt(o + 0x454), tpAt(o + 0x484)];
      if (!t.has(r.stateNo)) t.set(r.stateNo, r);
    }
  }
  return { sc: tables[0], air: tables[1] };
}

function newRecord(): AttackRecord {
  return {
    entries: [],
    stateNo: 0,
    stateType: '',
    cmd: [],
    total: zero(),
    dx: zero(),
    dy: zero(),
    hit: [tp(), tp(), tp()],
    clsn: [null, null],
    guardFlag: 0,
    attr: 0,
    revAttr: 0,
    recov: [tp(), tp(), tp()],
    end: [tp(), tp(), tp()],
  };
}

export function cloneRecord(r: AttackRecord): AttackRecord {
  return structuredClone(r);
}

/** stat_merge: exponential average in x87 double precision, stored as float. */
function merge(d: Stat, s: Stat): void {
  const old = d.mean;
  d.mean = f(s.mean * 0.05 + old * 0.95);
  d.dev = f(Math.abs(ftoi(s.mean - old)) * 0.05 + d.dev * 0.95);
}

function mergeTP(d: TimePos, s: TimePos): void {
  merge(d.time, s.time);
  merge(d.dx, s.dx);
  merge(d.dy, s.dy);
}

/** 0x432c90 (ck = -1 merges every contact kind). */
export function mergeRecord(dst: AttackRecord, src: AttackRecord, ck: number): void {
  for (const e of src.entries) {
    if (!dst.entries.some((d) => d.stateNo === e.stateNo) && dst.entries.length < 32) dst.entries.push({ ...e });
  }
  dst.cmd = src.cmd.length ? [src.cmd[0]!] : [];
  merge(dst.total, src.total);
  merge(dst.dx, src.dx);
  merge(dst.dy, src.dy);
  for (let k = 0; k < 3; k++) {
    if (ftoi(src.hit[k]!.time.mean) !== 0 && (ck === -1 || ck === k)) {
      if (ftoi(dst.hit[k]!.time.mean) !== 0) mergeTP(dst.hit[k]!, src.hit[k]!);
      else dst.hit[k] = structuredClone(src.hit[k]!);
    }
  }
  for (let c = 0; c < 2; c++) {
    const s = src.clsn[c];
    if (!s) continue;
    const d = dst.clsn[c];
    if (d) for (let i = 0; i < 4; i++) merge(d[i]!, s[i]!);
    else dst.clsn[c] = structuredClone(s);
  }
  if (dst.guardFlag !== src.guardFlag) dst.guardFlag = -1;
  if (dst.attr !== src.attr && dst.attr && src.attr) dst.attr = -1;
  if (dst.revAttr !== src.revAttr && dst.revAttr && src.revAttr) dst.revAttr = -1;
  for (let k = 0; k < 3; k++) {
    if (ftoi(src.recov[k]!.time.mean) !== 0 && (ck === -1 || ck === k)) {
      if (ftoi(dst.recov[k]!.time.mean) !== 0) mergeTP(dst.recov[k]!, src.recov[k]!);
      else dst.recov[k] = structuredClone(src.recov[k]!);
    }
    if (src.end[k]!.time.mean !== 0) {
      if (dst.end[k]!.time.mean !== 0) mergeTP(dst.end[k]!, src.end[k]!);
      else dst.end[k] = structuredClone(src.end[k]!);
    }
  }
}

/** Records keyed by stateno, in insertion (slot) order. */
export type RecordTable = Map<number, AttackRecord>;

/** KeyedArray capacities of the two tables (Ai_Alloc): stand/crouch, air. */
export const TABLE_CAP = { sc: 80, air: 40 } as const;

/** Merge a whole table (0x42f4a0), used to carry records across matches; moves that do not fit are dropped. */
export function mergeTables(dst: RecordTable, src: RecordTable, cap: number): void {
  for (const [no, r] of src) {
    const d = dst.get(no);
    if (d) mergeRecord(d, r, -1);
    else if (dst.size < cap) dst.set(no, cloneRecord(r));
  }
}

// ---------------------------------------------------------------------------
// HitDef attributes as mugen.exe's bitmasks.

/**
 * A HitDef's guardflag as mugen.exe stores it: HitFlags_Parse of the text
 * (2 by default, - clears it, + 0x100, H 4, L 8, M 0xC, A 0x10, F 0x20,
 * D 0x40, P 0x80), or 0 without a guardflag.
 */
export function guardFlagBits(flags: string): number {
  if (!flags) return 0;
  let b = 2;
  for (const ch of flags.toLowerCase()) {
    if (ch === '+') b |= 0x100;
    else if (ch === '-') b &= ~2;
    else if (ch === 'a') b |= 0x10;
    else if (ch === 'd') b |= 0x40;
    else if (ch === 'f') b |= 0x20;
    else if (ch === 'h') b |= 4;
    else if (ch === 'l') b |= 8;
    else if (ch === 'm') b |= 0xc;
    else if (ch === 'p') b |= 0x80;
  }
  return b;
}

/** attr: bits 1/2/4 = S/C/A, then one bit per kind (A/T/P) and class (N/S/H). */
export function attrBits(list: readonly string[]): number {
  let b = 0;
  const st = list[0] ?? '';
  if (st.includes('s')) b |= 1;
  if (st.includes('c')) b |= 2;
  if (st.includes('a')) b |= 4;
  for (const t of list.slice(1)) b |= hitAttrTypeBits(t);
  return b;
}

// ---------------------------------------------------------------------------

/** Clsn box in character-local units, normalised (x1 <= x2, y1 <= y2). */
interface IBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Internal units (GameWidth based) per world unit, as the AI measures. */
export const internalScale = (p: Player): number => p.world.gameWidth / p.world.screenWidth;

/**
 * A frame's Clsn boxes in internal units: mugen.exe scales them by GameWidth
 * over the character's localcoord at load (measured: KFM's jab reaches an
 * opponent 130 internal units away, which its raw 61 never would).
 */
function scaledBoxes(p: Player, list: readonly IBox[] | null | undefined): IBox[] {
  if (!list?.length) return [];
  const k = p.world.gameWidth / p.prog.data.def.localCoord[0];
  const t = (v: number) => Math.trunc(v * k);
  return list.map((b) => ({ x1: t(b.x1), y1: t(b.y1), x2: t(b.x2), y2: t(b.y2) }));
}

const IDLE_STATES = [0, 20, 11, 50];

/** Union of boxes offset by (dx, dy) into four float means (0x430020). */
function unionInto(s: BoxStat, boxes: readonly IBox[], dx: number, dy: number): BoxStat {
  if (!boxes.length) return s;
  if (!s) {
    const b = boxes[0]!;
    s = [stat(b.x1 + dx), stat(b.y1 + dy), stat(b.x2 + dx), stat(b.y2 + dy)];
  }
  for (const b of boxes) {
    s[0].mean = f(Math.min(ftoi(s[0].mean), b.x1 + dx));
    s[1].mean = f(Math.min(ftoi(s[1].mean), b.y1 + dy));
    s[2].mean = f(Math.max(ftoi(s[2].mean), b.x2 + dx));
    s[3].mean = f(Math.max(ftoi(s[3].mean), b.y2 + dy));
  }
  return s;
}

/**
 * Per-player recorder block (p+0x1dd8), kept across rounds. Tables move to
 * the character when the player is destroyed and back on the next load.
 */
export class Recorder {
  enabled = true;
  tblSC: RecordTable = new Map();
  tblAir: RecordTable = new Map();
  /** Clsn2 union for states 0, 20, 11, 50. */
  idle: BoxStat[] = [null, null, null, null];
  // In-progress recording (header).
  active = 0;
  time = 0;
  stateType0 = '';
  x0 = 0;
  y0 = 0;
  facing0 = 1;
  projId = 0;
  contact = 0;
  rec: AttackRecord = newRecord();
  cmdList: number[] = [];
  /** command= triggers seen active by the controller being evaluated. */
  fired: number[] = [];
  projPending = -1;
  prev: StartEntry = { stateNo: 0, stateType: 's', moveType: 'i', ctrl: false };

  // AI block fields kept here because every player has them (reset per round).
  /** p+0x16a8: own record for the current state, or null. */
  curAttack: AttackRecord | null = null;
  /** p+0x1cf8: a command-triggered state change awaits its type-1 message. */
  didCmdMove = false;

  /** 0x42ef50: a new player starts with its character's records. */
  constructor(readonly p: Player) {
    const saved = p.prog.aiRecords;
    if (saved) {
      mergeTables(this.tblSC, saved.sc, TABLE_CAP.sc);
      mergeTables(this.tblAir, saved.air, TABLE_CAP.air);
    }
  }

  /** 0x43a880: when the player is destroyed its records go back to the character. */
  saveToCharacter(): void {
    const prog = this.p.prog;
    prog.aiRecords ??= { sc: new Map(), air: new Map() };
    mergeTables(prog.aiRecords.sc, this.tblSC, TABLE_CAP.sc);
    mergeTables(prog.aiRecords.air, this.tblAir, TABLE_CAP.air);
  }

  table(st: string = this.p.stateType): RecordTable | null {
    return st === 's' || st === 'c' ? this.tblSC : st === 'a' ? this.tblAir : null;
  }

  /** 0x42f5c0: round reset of the AI block (records survive). */
  resetRound(): void {
    this.curAttack = null;
    this.didCmdMove = false;
  }

  private clearHeader(): void {
    this.active = 0;
    this.time = 0;
    this.stateType0 = '';
    this.x0 = this.y0 = 0;
    this.facing0 = 1;
    this.projId = 0;
    this.contact = 0;
    this.rec = newRecord();
  }

  private get ix(): number {
    return this.p.wx * internalScale(this.p);
  }

  private get iy(): number {
    return this.p.wy * internalScale(this.p);
  }

  /** 0x448f50 prologue: the state before a controller runs. */
  beforeController(): void {
    const p = this.p;
    this.prev = { stateNo: p.stateNo, stateType: p.stateType, moveType: p.moveType, ctrl: p.ctrl };
    this.fired = [];
  }

  /** 0x448f50 epilogue: a command-triggered state change starts a record. */
  afterStateChange(): void {
    if (!this.fired.length) return;
    this.cmdList = [...this.fired];
    this.startRecord();
    this.broadcast();
  }

  /** 0x42f800. */
  private startRecord(): void {
    const p = this.p;
    this.curAttack = this.table()?.get(p.stateNo) ?? null;
    if (!this.enabled) return;
    this.clearHeader();
    this.active = 1;
    this.stateType0 = p.stateType;
    this.facing0 = p.facing;
    this.x0 = ftoi(this.ix);
    this.y0 = ftoi(this.iy);
    this.rec.stateNo = p.stateNo;
    this.rec.stateType = p.stateType;
    this.rec.entries = [{ ...this.prev }];
    this.rec.cmd = [...this.cmdList];
  }

  /** 0x4305f0: type-0 message to every CPU player. */
  private broadcast(): void {
    const tbl = this.table();
    this.didCmdMove = true;
    postMessage(this.p, 0, tbl ? this.p.stateNo : 0, tbl !== null);
  }

  /** 0x4301e0. */
  private recordIdle(): void {
    const i = IDLE_STATES.indexOf(this.p.stateNo);
    if (i < 0) return;
    this.idle[i] = unionInto(this.idle[i]!, scaledBoxes(this.p, this.p.anim.current?.clsn2), 0, 0);
  }

  private relPos(): [number, number] {
    return [ftoi((this.ix - this.x0) * this.facing0), ftoi(this.iy - this.y0)];
  }

  /** 0x42f9c0, late in the tick. `advanced`: the player was not frozen by a pause. */
  tick(advanced: boolean): void {
    const p = this.p;
    const fr = p.anim.current;
    const tick = this.time;
    let ended = false;
    let commit = false;
    const active = !!fr && this.enabled && this.active !== 0;
    if (p.moveType === 'i' && p.ctrl) {
      if (active) commit = this.active >= 2;
      ended = true;
    }
    if (p.stateOwner || p.moveType === 'h') ended = true;
    if (ended) this.curAttack = null;
    if (this.enabled) this.recordIdle();
    if (!active || !fr) return;
    if (ended) return this.finish(commit);
    let ck = contactKind(p);
    if (this.contact === 0) this.contact = ck;
    else ck = this.contact;
    // `advanced` already holds the tick start's view: run this tick, not
    // in hit pause, no pause running (pause_kind, set from the frame after
    // a pause starts).
    const adv = advanced;
    const rec = this.rec;
    if (adv) {
      const [dx, dy] = this.relPos();
      rec.clsn[0] = unionInto(rec.clsn[0], scaledBoxes(p, fr.clsn1), dx, dy);
      rec.clsn[1] = unionInto(rec.clsn[1], scaledBoxes(p, fr.clsn2), dx, dy);
    }
    const [dx, dy] = this.relPos();
    const hitbox = hitDefOn(p) && !!fr.clsn1?.length;
    if (this.active === 1) {
      if (hitbox) {
        rec.total = stat(tick);
        rec.dx = stat(dx);
        rec.dy = stat(dy);
        rec.hit[ck] = tpInit(tick, dx, dy);
        const hd = p.reversal?.hd ?? p.hitDef;
        rec.guardFlag = hd ? guardFlagBits(hd.guardFlag) : 0;
        rec.attr = hd ? attrBits([hd.attrState, hd.attrType]) : 0;
        rec.revAttr = p.reversal ? attrBits(p.reversal.attrs) : 0;
        this.active = 2;
      }
      if (this.projPending !== -1) {
        rec.total = stat(tick);
        rec.dx = stat(dx);
        rec.dy = stat(dy);
        rec.hit[ck] = tpInit(tick, dx, dy);
        this.projId = this.projPending;
        this.projPending = -1;
        this.active = 2;
      }
    } else if (this.active === 2) {
      const still = hitbox || p.world.projectiles.some((pr) => pr.owner === p && pr.projId === this.projId && pr.phase === 'active');
      if (still) rec.hit[ck] = tpInit(tick, dx, dy);
      if (rec.recov[ck]!.time.mean === 0 && p.ctrl) rec.recov[ck] = tpInit(tick, dx, dy);
    }
    if (adv) this.time++;
  }

  /** 0x430330. */
  private finish(commit: boolean): void {
    if (!this.enabled) return;
    if (!commit) return this.clearHeader();
    const p = this.p;
    const ck = this.contact;
    const tick = this.time;
    const rec = this.rec;
    const [dx, dy] = this.relPos();
    rec.end[ck] = tpInit(tick, dx, dy);
    if (rec.recov[ck]!.time.mean === 0 && p.ctrl) rec.recov[ck] = tpInit(tick, dx, dy);
    const tbl = this.table(this.stateType0);
    if (tbl) {
      const d = tbl.get(rec.stateNo);
      if (d) mergeRecord(d, rec, ck);
      // Ai_FinishMove: a new move in a full table is dropped.
      else if (tbl.size < (tbl === this.tblAir ? TABLE_CAP.air : TABLE_CAP.sc)) tbl.set(rec.stateNo, rec);
    }
    this.clearHeader();
  }
}

/** MoveContact kind (p+0xf0c): 1 guarded, 2 hit, 0 none. */
export function contactKind(p: Player): number {
  return p.moveHit ? 2 : p.moveGuarded ? 1 : 0;
}

/** HitDef (or ReversalDef) active (p+0x1230). */
export function hitDefOn(p: Player): boolean {
  return (p.hitDefSet && !!p.hitDef) || !!p.reversal;
}

// ---------------------------------------------------------------------------
// Messages between players (0x430660): only CPU players receive them.

export interface AiMessage {
  sender: Player;
  /** 0 = command move started, 1 = move resolved, 2 = taken. */
  type: number;
  stateNo: number;
  /** The sender's statetype had a record table (S, C or A). */
  hasTable: boolean;
}

export function postMessage(sender: Player, type: number, stateNo: number, hasTable: boolean): void {
  for (const q of sender.world.players) {
    if (q === sender || !q.ai || q.ai.msgs.length >= 10) continue;
    q.ai.msgs.push({ sender, type, stateNo, hasTable });
  }
}

/**
 * Type-1 pass before the AI (0x41357b): a player whose command move is over
 * (idle with control, in custom states or being hit) tells the CPU players.
 */
export function postResolvedMessages(players: readonly Player[]): void {
  for (const q of players) {
    const r = q.recorder;
    if (!r?.didCmdMove) continue;
    if ((q.moveType === 'i' && q.ctrl) || q.stateOwner || q.moveType === 'h') {
      r.didCmdMove = false;
      postMessage(q, 1, -1, false);
    }
  }
}

// ---------------------------------------------------------------------------
// 0x431740: would `att`'s recorded hitbox reach `def`'s body right now?

type Box4 = [number, number, number, number];

function boxesOf(p: Player, list: readonly IBox[] | null | undefined): Box4[] | null {
  return list?.length ? scaledBoxes(p, list).map((b) => [b.x1, b.y1, b.x2, b.y2] as Box4) : null;
}

export function attackWouldHit(def: Player, att: Player, rec: AttackRecord | null): boolean {
  const fd = def.anim.current;
  const fa = att.anim.current;
  if (!fd || !fa) return false;
  const k = internalScale(def);
  const dx = ftoi((att.wx - def.wx) * k);
  const dy = ftoi((att.wy - def.wy) * k);
  let listP = boxesOf(def, fd.clsn2);
  let listA = boxesOf(att, fa.clsn1);
  // Defender: its idle body union in states 0/20/11/50, else its own move's Clsn1.
  let sP: BoxStat | undefined = def.recorder?.curAttack?.clsn[0] ?? undefined;
  const idx = IDLE_STATES.indexOf(def.stateNo);
  if (idx >= 0) sP = def.recorder?.idle[idx] ?? null;
  if (sP) listP = [[ftoi(sP[0].mean), ftoi(sP[1].mean), ftoi(sP[2].mean), ftoi(sP[3].mean)]];
  const ra = rec ?? att.recorder?.curAttack ?? null;
  const sA = ra?.clsn[0];
  if (sA) listA = [[ftoi(sA[0].mean), ftoi(sA[1].mean), ftoi(sA[2].mean), ftoi(sA[3].mean)]];
  if (!listP || !listA) return false;
  return boxListsOverlap(def.facing !== 1, att.facing !== 1, listP, listA, dx, dy);
}

/**
 * 0x479b80: does any box of A, offset by (dx, dy), touch a box of P? Boxes
 * of a player facing left are mirrored; edges count (inclusive compares).
 */
export function boxListsOverlap(
  flipP: boolean,
  flipA: boolean,
  listP: readonly Box4[],
  listA: readonly Box4[],
  dx: number,
  dy: number,
): boolean {
  for (const a of listP) {
    const ax1 = flipP ? -a[2] : a[0];
    const ax2 = flipP ? -a[0] : a[2];
    for (const b of listA) {
      const bx1 = (flipA ? -b[2] : b[0]) + dx;
      const bx2 = (flipA ? -b[0] : b[2]) + dx;
      if (bx2 >= ax1 && bx1 <= ax2 && b[3] + dy >= a[1] && b[1] + dy <= a[3]) return true;
    }
  }
  return false;
}

/**
 * 0x43de40: player push needs the two current Clsn2 lists to touch, tested
 * in whole internal units with the distance truncated (measured: an airborne
 * player 0.52 internal units above the other's box still pushes).
 */
export function clsn2TouchInternal(p: Player, q: Player): boolean {
  return clsnTouchInternal(p, 2, q, 2);
}

/** Clsn contact in whole internal units (push, hits, reversals). */
export function clsnTouchInternal(p: Player, wp: 1 | 2, q: Player, wq: 1 | 2): boolean {
  const fp = p.anim.current;
  const fq = q.anim.current;
  const lp = boxesOf(p, wp === 1 ? fp?.clsn1 : fp?.clsn2);
  const lq = boxesOf(q, wq === 1 ? fq?.clsn1 : fq?.clsn2);
  if (!lp || !lq) return false;
  const k = internalScale(p);
  return boxListsOverlap(p.facing !== 1, q.facing !== 1, lp, lq, ftoi((q.clsnX - p.clsnX) * k), ftoi((q.clsnY - p.clsnY) * k));
}
