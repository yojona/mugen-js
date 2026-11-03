// How mugen.exe reads each state controller's parameters (StateCtrl_ParseParams
// 0x444DD0 and the *_ParseParams helpers), as data. Keys not listed are never
// read by mugen.exe (ignored, even if malformed).
//
// General facts (all from the C decompilation, sctrl.c / cnsparse.c / ini.c):
// - Key lookup (Ini_GetValue): the FIRST line of the [State] group whose text starts with the key
//   (case-insensitive unless g_iniCaseSensitive) and is followed by a blank or '='. Later duplicates are
//   ignored. So 'pos' never matches a 'pos2' line.
// - The controller type is `type`, lowercased and compared whole (strcmp). A missing `type` fails.
// - EVERY parse failure (a fatal key, an unknown type, a failed version check) makes StateCtrl_Parse return 0,
//   which makes StateDef_Parse / StateDefs_Load fail, which makes the whole character fail to load. mugen.exe
//   never drops just one controller. `fatal: false` below means the failure is swallowed or defaulted.
// - An absent key is never an error by itself (Expr_Compile(NULL) returns 1 and leaves the Expr untouched),
//   except where `required` is set. Expr_Compile of an empty value is unverified (assumed to fail).
// - Expr_Compile with no end pointer (kind 'expr'): the whole text must be one expression; "1, 2" fails.
// - Cns_ParseValues: values split on ',', the LAST value may be followed by any terminator character that
//   occurs in the source text (a decompiled quirk, cnsparse.c comment), so "ii" on "1, 2, 3" ends at ", 3"
//   and callers that test `*end == '\0'` fail it. An empty value gives count 0 with *end == '\0'.
//   check 'pair' therefore ACCEPTS an empty value (count 0); 'checked' does not (count must be >= 1).
// - `persistent` and `ignorehitpause` (atoi, never fail), `triggerall` and `triggerN` (Expr_Compile ANY, fatal;
//   at least one `trigger1` line required) are read by StateCtrl_Parse for every controller, not listed per type.
//
// Type names accepted CONDITIONALLY (StateCtrl_VersionOk, run AFTER the parameters parsed; a failure is fatal
// and prints "Controller not valid for mugenversion of character"):
// - victoryquote needs the character's mugenversion >= 1.0 (0x01000000).
// - zoom needs mugenversion >= 1.1 (0x01010000).
// - every other accepted type is allowed for any mugenversion.
// An unknown type name (anything not a key below) prints "Not a valid elem type" and is fatal. Several
// parameters also change with mugenversion < 1.0 (compat_version[1]): HitDef snap/mindist/maxdist accept an
// extra z value; the Statedef velset may carry a third value. Explod postype default depends on
// compat_version[2] (see the explod notes).

export type ParamKind =
  /** Expr_Compile of the whole text (no end pointer: a ',' or trailing text fails). want: EXPR_WANT_INT / FLOAT / ANY. */
  | { k: 'expr'; want: 'int' | 'float' | 'any' }
  /** Cns_ParseValues(fmt). check = how the caller treats the result:
   *  'none' (result ignored), 'pair' (parse_pair: absent ok, else *end must be '\0'),
   *  'checked' (parse_pair_checked: >=1 value and *end '\0'), 'endFirst' (parse_pair_end_first),
   *  'atLeast1' (only requires n>=1), or 'custom' (explain in note). */
  | { k: 'values'; fmt: string; check: 'none' | 'pair' | 'checked' | 'endFirst' | 'atLeast1' | 'custom' }
  | { k: 'soundRef' }   // Cns_ParseSoundRef
  | { k: 'animRef' }    // Cns_ParseAnimRef
  | { k: 'velocity' }   // Cns_ParseVelocity
  | { k: 'posType' }    // Cns_ParsePosType
  | { k: 'hitDefAttr' } // HitDefAttr_Parse
  | { k: 'hitFlags' }   // HitFlags_Parse
  | { k: 'word' }       // read as text by letters / keywords (statetype, trans, affectteam, priority words, flags...): describe accepted words in note
  | { k: 'string' }     // free text (Explod/DisplayToClipboard text, helper name...)
  | { k: 'varLine' }    // parse_var_line: the "var(n) = x" line form
  | { k: 'custom' };    // anything else: explain exactly in note

export interface ParamSpec {
  key: string;            // lowercase full key, prefixes expanded (e.g. 'afterimage.palbright', 'fall.envshake.time', 'p1.statetype'?)
  kind: ParamKind;
  required?: boolean;     // missing key makes the controller fail to load
  /** true if a parse failure of this key makes the controller (and the character) fail to load; false if mugen.exe ignores the failure / keeps a default */
  fatal: boolean;
  /** default value or behaviour when absent, and any quirk (only if non-obvious), short */
  note?: string;
}

const INT: ParamKind = { k: 'expr', want: 'int' };
const FLT: ParamKind = { k: 'expr', want: 'float' };
const WORD: ParamKind = { k: 'word' };
const POSTYPE: ParamKind = { k: 'posType' };
const SOUNDREF: ParamKind = { k: 'soundRef' };
const II_PAIR: ParamKind = { k: 'values', fmt: 'ii', check: 'pair' };
const FF_PAIR: ParamKind = { k: 'values', fmt: 'ff', check: 'pair' };
const II_CHECKED: ParamKind = { k: 'values', fmt: 'ii', check: 'checked' };
const FF_CHECKED: ParamKind = { k: 'values', fmt: 'ff', check: 'checked' };
const III_CHECKED: ParamKind = { k: 'values', fmt: 'iii', check: 'checked' };
const CUSTOM: ParamKind = { k: 'custom' };

/** Only the "value" key, compile_required(INT). */
const VALUE_REQUIRED_INT: ParamSpec[] = [
  { key: 'value', kind: INT, required: true, fatal: true },
];
const VALUE_REQUIRED_FLOAT: ParamSpec[] = [
  { key: 'value', kind: FLT, required: true, fatal: true },
];

/** PosSet / PosAdd / VelSet / VelAdd / VelMul: parse_xyz with z. */
const XYZ: ParamSpec[] = [
  { key: 'x', kind: FLT, fatal: true, note: 'given flag set only when the key exists' },
  { key: 'y', kind: FLT, fatal: true },
  { key: 'z', kind: FLT, fatal: true },
];

/** AfterImage_ParseParams with prefix '' (controller) or 'afterimage.' (projectile). */
function afterImageSpecs(prefix: string): ParamSpec[] {
  const p = prefix;
  return [
    { key: p + 'time', kind: INT, fatal: true, note: 'default 1' },
    { key: p + 'length', kind: INT, fatal: true, note: 'default 20' },
    { key: p + 'palcolor', kind: INT, fatal: true, note: 'default 256 (0x100)' },
    { key: p + 'palinvertall', kind: INT, fatal: true, note: 'default 0' },
    { key: p + 'palbright', kind: III_CHECKED, fatal: true,
      note: 'default 30,30,30. BUG kept from mugen.exe (line ~2691): the 1st and 2nd values are both stored into palbright[1]; palbright[0] always keeps 30' },
    { key: p + 'palcontrast', kind: III_CHECKED, fatal: true, note: 'default 120,120,220' },
    { key: p + 'palpostbright', kind: III_CHECKED, fatal: true, note: 'default 0,0,0' },
    { key: p + 'paladd', kind: III_CHECKED, fatal: true, note: 'default 10,10,25' },
    { key: p + 'palmul', kind: { k: 'values', fmt: 'fff', check: 'checked' }, fatal: true, note: 'default 0.65,0.65,0.75' },
    { key: p + 'timegap', kind: INT, fatal: true, note: 'default 1' },
    { key: p + 'framegap', kind: INT, fatal: true, note: 'default 4' },
    { key: p + 'trans', kind: WORD, fatal: false,
      note: 'whole-string, case-insensitive: none | add | addalpha | add1 | sub | default | empty. Absent = trans 0. An INVALID word is silently ignored (trans -2) and alpha is then NOT read. add/sub give alpha 256,256; add1 256,128; addalpha 256,0; none/default 256,0 (Trans_Parse, anim.c:46)' },
    { key: p + 'alpha', kind: II_CHECKED, fatal: true,
      note: 'only read when trans parsed to a valid word; overrides the alpha implied by trans (src,dst); default 256,256' },
  ];
}

/** Explod_ParseParams; shared by Explod (modify 0) and ModifyExplod (modify 1). */
const EXPLOD_KEYS: ParamSpec[] = [
  { key: 'id', kind: INT, fatal: true, note: 'default 0; ModifyExplod default -1' },
  { key: 'anim', kind: { k: 'custom' }, fatal: true,
    note: 'NOT Cns_ParseAnimRef: only an optional leading f/F (fight.def anim, anim_fight=1) then an int Expr; there is NO S prefix ("S5" fails as an expression). Absent: the Expr is never initialised (calloc zero), even for ModifyExplod (no INT_MIN sentinel, line ~2966)' },
  { key: 'space', kind: WORD, fatal: false,
    note: 'whole-string case-insensitive: screen (1) | stage (0) | auto (-1). Any other text is silently ignored. Default -1 (ModifyExplod: unchanged, INT_MIN)' },
  { key: 'pos', kind: FF_CHECKED, fatal: true, note: 'absent: zero (ModifyExplod: Expr untouched, calloc zero; no sentinel)' },
  { key: 'vel', kind: { k: 'values', fmt: 'ff', check: 'checked' }, fatal: true,
    note: 'read from `vel`; if absent `velocity` is read instead (alias, same parsing). Absent: zero' },
  { key: 'velocity', kind: { k: 'values', fmt: 'ff', check: 'checked' }, fatal: true, note: 'alias of vel, only consulted when vel is absent' },
  { key: 'accel', kind: FF_CHECKED, fatal: true },
  { key: 'random', kind: II_CHECKED, fatal: true },
  { key: 'supermove', kind: INT, fatal: true, note: 'default 0; ModifyExplod INT_MIN (unchanged)' },
  { key: 'supermovetime', kind: INT, fatal: true, note: 'default 0; ModifyExplod INT_MIN' },
  { key: 'pausemovetime', kind: INT, fatal: true, note: 'default 0; ModifyExplod INT_MIN' },
  { key: 'removetime', kind: INT, fatal: true, note: 'default -2; ModifyExplod INT_MIN' },
  { key: 'scale', kind: FF_CHECKED, fatal: true, note: 'default 1,1; ModifyExplod -FLT_MAX (unchanged)' },
  { key: 'postype', kind: POSTYPE, fatal: true,
    note: 'first letter: p1/p (P1), p2, f(ront), b(ack), l(eft), r(ight), n(one); other = fatal. Default P1 when owner mugenversion < compat_version[2] (value of that constant not in the sources read), else none (-1); ModifyExplod INT_MIN (unchanged)' },
  { key: 'angle', kind: FLT, fatal: true, note: 'default 0; ModifyExplod -FLT_MAX' },
  { key: 'yangle', kind: FLT, fatal: true, note: 'default 0; ModifyExplod -FLT_MAX' },
  { key: 'xangle', kind: FLT, fatal: true, note: 'default 0; ModifyExplod -FLT_MAX' },
  { key: 'bindid', kind: INT, fatal: true, note: 'default -2 (the removetime default is reused); ModifyExplod INT_MIN' },
  { key: 'bindtime', kind: INT, fatal: true, note: 'default 1; ModifyExplod INT_MIN' },
  { key: 'sprpriority', kind: INT, fatal: true, note: 'default 0; ModifyExplod INT_MIN' },
  { key: 'ontop', kind: INT, fatal: true, note: 'default 0; ModifyExplod INT_MIN' },
  { key: 'facing', kind: INT, fatal: true, note: 'default 1 for BOTH Explod and ModifyExplod (no sentinel, line ~3063)' },
  { key: 'vfacing', kind: INT, fatal: true, note: 'default 1 for BOTH Explod and ModifyExplod' },
  { key: 'shadow', kind: III_CHECKED, fatal: true, note: 'absent: shadow[0] = INT_MIN only for ModifyExplod, otherwise calloc zero' },
  { key: 'ownpal', kind: INT, fatal: true, note: 'default 1 if anim had the f prefix else 0; ModifyExplod INT_MIN' },
  { key: 'remappal', kind: II_CHECKED, fatal: true, note: 'default first value -1 (ModifyExplod INT_MIN); second value untouched when absent' },
  { key: 'removeongethit', kind: INT, fatal: true, note: 'default 0; ModifyExplod INT_MIN' },
  { key: 'ignorehitpause', kind: INT, fatal: true, note: 'default 1 (the bindtime default is reused); ModifyExplod INT_MIN' },
  { key: 'trans', kind: WORD, fatal: false,
    note: 'same words as afterimage trans (Trans_Parse). Default -1 (ModifyExplod INT_MIN). An invalid word returns success immediately: trans left -2 and alpha is NOT read. NOTE the function returns 1 here, so it is the last key read' },
  { key: 'alpha', kind: II_CHECKED, fatal: true, note: 'only read when trans is a valid word; default alpha = the one implied by trans' },
];

/** PalFx_ParseParams with hitdef=0 (controller keys) or 1 (HitDef "palfx." keys). */
function palFxSpecs(prefix: string): ParamSpec[] {
  const p = prefix;
  return [
    { key: p + 'time', kind: INT, fatal: true, note: 'absent: Expr zero (calloc), never initialised' },
    { key: p + 'mul', kind: { k: 'values', fmt: 'iii', check: 'custom' }, fatal: true, note: 'needs EXACTLY 3 values and *end == 0. Default 256,256,256' },
    { key: p + 'add', kind: { k: 'values', fmt: 'iii', check: 'custom' }, fatal: true, note: 'needs EXACTLY 3 values and *end == 0. Absent: zero (calloc)' },
    { key: p + 'sinadd', kind: { k: 'values', fmt: 'iiii', check: 'custom' }, fatal: true, note: '3 or 4 values (4th is period) and *end == 0. Absent: zero' },
    { key: p + 'invertall', kind: INT, fatal: true, note: 'default 0' },
    { key: p + 'color', kind: INT, fatal: true, note: 'default 256 (0x100)' },
  ];
}

/** EnvShake_ParseParams with prefix '' (controller), 'envshake.' or 'fall.envshake.' (HitDef). */
function envShakeSpecs(prefix: string): ParamSpec[] {
  const p = prefix;
  return [
    { key: p + 'time', kind: INT, fatal: true, note: 'default 0' },
    { key: p + 'dir', kind: INT, fatal: true, note: 'default 0 (never evaluated at run time)' },
    { key: p + 'ampl', kind: INT, fatal: true, note: 'default -4' },
    { key: p + 'freq', kind: FLT, fatal: true, note: 'default 60' },
    { key: p + 'phase', kind: FLT, fatal: true, note: 'default 0; when ABSENT and freq >= 90 the run-time phase becomes 90' },
  ];
}

/** HitDef_ParseParams (also used by ReversalDef and by the Projectile controller). Order = source order. */
const HITDEF_KEYS: ParamSpec[] = [
  { key: 'attr', kind: { k: 'hitDefAttr' }, fatal: true,
    note: 'invalid text = fatal (silent). Absent = attr 0, not an error here. HitDefAttr_Parse: state letters (s/c/a) then ", " list of NA/NT/NP/SA/ST/SP/HA/HT/HP (and 2-letter forms, a lone "A" reads as "H")' },
  { key: 'affectteam', kind: WORD, fatal: true, note: 'first letter only: b(oth)=3, e(nemy)=2, f(riendly)=1; default enemy; any other first letter = fatal' },
  { key: 'id', kind: INT, fatal: true, note: 'absent: zero (calloc)' },
  { key: 'chainid', kind: INT, fatal: true, note: 'default -1' },
  { key: 'nochainid', kind: II_CHECKED, fatal: true, note: 'default -1,-1' },
  { key: 'sparkno', kind: CUSTOM, fatal: true,
    note: 'optional leading s/S (own sprites, spark_own=1) then an int Expr. NO F prefix handled (an "F2" goes to Expr_Compile, presumably failing: unverified). Default -2 and fight.def sprites' },
  { key: 'guard.sparkno', kind: CUSTOM, fatal: true, note: 'same parsing as sparkno; default -2' },
  { key: 'sparkxy', kind: II_CHECKED, fatal: true, note: 'absent: zero' },
  { key: 'pausetime', kind: II_CHECKED, fatal: true, note: 'p1 time, p2 time; absent: zero' },
  { key: 'guard.pausetime', kind: { k: 'values', fmt: 'ii', check: 'custom' }, fatal: true,
    note: 'n==0 or *end != 0 fatal. One value: p2 time = pausetime p2. Absent: both cloned from pausetime' },
  { key: 'kill', kind: INT, fatal: true, note: 'default 1' },
  { key: 'guard.kill', kind: INT, fatal: true, note: 'default 1' },
  { key: 'fall.kill', kind: INT, fatal: true, note: 'default 1' },
  { key: 'hitonce', kind: INT, fatal: true, note: 'default 1 if attr is a throw (HITATTR_THROWS) else 0' },
  { key: 'numhits', kind: INT, fatal: true, note: 'default 1' },
  { key: 'damage', kind: II_CHECKED, fatal: true, note: 'hit damage, guard damage; absent: zero' },
  { key: 'getpower', kind: { k: 'values', fmt: 'ii', check: 'custom' }, fatal: true,
    note: 'n==0 or *end != 0 fatal. One value: second = first / 2. Absent: first = damage[0] * attack_life_to_power_mul, second = half of that' },
  { key: 'givepower', kind: { k: 'values', fmt: 'ii', check: 'custom' }, fatal: true,
    note: 'as getpower but absent default uses damage[0] * gethit_life_to_power_mul' },
  { key: 'priority', kind: CUSTOM, fatal: true,
    note: 'Cns_ParseValues("i:,") then optional ", word": first letter after the comma h(it)=0, m(iss)=1, d(odge)=2, anything else (including a trailing comma with nothing after) fatal. Default 4, hit. Trailing text after the int that is not a comma also fatal' },
  { key: 'hitsound', kind: SOUNDREF, fatal: true, note: 'F/S prefix: F = fight.def sounds, S = own. DEFAULT (no prefix) = fight.def (fight flag preset to 1). group,index; one value allowed (index stays zero). Absent: group -1' },
  { key: 'guardsound', kind: SOUNDREF, fatal: true, note: 'same as hitsound; default fight.def, group -1' },
  { key: 'ground.slidetime', kind: INT, fatal: true, note: 'absent: zero' },
  { key: 'ground.hittime', kind: INT, fatal: true, note: 'absent: zero' },
  { key: 'ground.velocity', kind: { k: 'velocity' }, fatal: true, note: 'x[,y]; "n" means none (-FLT_MAX), y optional; absent: zero' },
  { key: 'air.velocity', kind: { k: 'velocity' }, fatal: true, note: 'same parsing as ground.velocity' },
  { key: 'air.juggle', kind: INT, fatal: true, note: 'default -1' },
  { key: 'air.hittime', kind: INT, fatal: true, note: 'default 20' },
  { key: 'snap', kind: { k: 'values', fmt: 'iii', check: 'custom' }, fatal: true,
    note: 'x,y,time. mugenversion < compat_version[1] (1.0): "iiii" x,y,z,time with z discarded. n==0 or *end != 0 fatal. When present, mindist and maxdist are NOT read; both copy (x,y). Default -1025 means not given' },
  { key: 'mindist', kind: { k: 'values', fmt: 'ii', check: 'custom' }, fatal: true,
    note: 'only read when snap is absent. pre-1.0: "iii" with z discarded. n==0 or *end != 0 fatal. Default -1025,-1025' },
  { key: 'maxdist', kind: { k: 'values', fmt: 'ii', check: 'custom' }, fatal: true, note: 'same as mindist; default -1025,-1025' },
  { key: 'p1sprpriority', kind: INT, fatal: true, note: 'default 1; if absent the key `sprpriority` is read instead (same parsing)' },
  { key: 'sprpriority', kind: INT, fatal: true, note: 'fallback alias of p1sprpriority, only read when p1sprpriority is absent' },
  { key: 'p2sprpriority', kind: INT, fatal: true, note: 'default 0' },
  { key: 'p1facing', kind: INT, fatal: true, note: 'default 0' },
  { key: 'p1getp2facing', kind: INT, fatal: true, note: 'absent: zero' },
  { key: 'p2facing', kind: INT, fatal: true, note: 'absent: zero' },
  { key: 'p1stateno', kind: INT, fatal: true, note: 'default -1' },
  { key: 'p2stateno', kind: INT, fatal: true, note: 'default -1. If present, p2getp1state defaults to 1' },
  { key: 'p2getp1state', kind: INT, fatal: true, note: 'default 0, or 1 if p2stateno was given; an explicit value overrides' },
  { key: 'forcestand', kind: INT, fatal: true, note: 'default 0; presence recorded separately (forcestand_given)' },
  { key: 'forcenofall', kind: INT, fatal: true, note: 'default 0' },
  { key: 'fall.damage', kind: INT, fatal: true, note: 'default 0' },
  { key: 'fall.xvelocity', kind: FLT, fatal: true, note: 'default -FLT_MAX (unset)' },
  { key: 'fall.yvelocity', kind: FLT, fatal: true, note: 'default -4.5 in 320-wide units, converted to the character localcoord' },
  { key: 'fall.recover', kind: INT, fatal: true, note: 'default 1' },
  { key: 'fall.recovertime', kind: INT, fatal: true, note: 'default 4' },
  { key: 'yaccel', kind: FLT, fatal: true, note: 'default -FLT_MAX (unset)' },
  { key: 'down.velocity', kind: { k: 'values', fmt: 'ff', check: 'custom' }, fatal: true,
    note: 'n==0 or *end != 0 fatal. One value: y copies air.velocity y. Absent: both copy air.velocity' },
  { key: 'down.bounce', kind: INT, fatal: true, note: 'default 0' },
  { key: 'down.hittime', kind: INT, fatal: true, note: 'default 20' },
  { key: 'guard.slidetime', kind: INT, fatal: true, note: 'absent: copy of ground.slidetime' },
  { key: 'guard.hittime', kind: INT, fatal: true, note: 'absent: copy of ground.hittime' },
  { key: 'guard.velocity', kind: FLT, fatal: true,
    note: 'ONE float only, compiled with Expr_Compile on the whole text ("-5, 2" fails). Absent: copy of ground.velocity x' },
  { key: 'guard.ctrltime', kind: INT, fatal: true, note: 'absent: copy of guard.slidetime' },
  { key: 'guard.dist', kind: INT, fatal: true, note: 'default -1' },
  { key: 'ground.cornerpush.veloff', kind: FLT, fatal: true,
    note: 'absent: 0 if attr has the AIR bit, else guard.velocity * 1.3' },
  { key: 'air.cornerpush.veloff', kind: FLT, fatal: true, note: 'absent: copy of ground.cornerpush.veloff' },
  { key: 'down.cornerpush.veloff', kind: FLT, fatal: true, note: 'absent: copy of ground.cornerpush.veloff' },
  { key: 'guard.cornerpush.veloff', kind: FLT, fatal: true, note: 'absent: copy of ground.cornerpush.veloff' },
  { key: 'airguard.cornerpush.veloff', kind: FLT, fatal: true, note: 'absent: copy of guard.cornerpush.veloff' },
  { key: 'airguard.velocity', kind: { k: 'values', fmt: 'ff', check: 'custom' }, fatal: true,
    note: 'n==0 or *end != 0 fatal. One value: y = air.velocity y * 0.5. Absent: x = air.velocity x * 1.5, y = air.velocity y * 0.5' },
  { key: 'airguard.ctrltime', kind: INT, fatal: true, note: 'absent: copy of guard.ctrltime' },
  { key: 'fall', kind: INT, fatal: true, note: 'default 0; also seeds air.fall' },
  { key: 'air.fall', kind: INT, fatal: true, note: 'default = fall (or 0)' },
  { key: 'guardflag', kind: { k: 'hitFlags' }, fatal: false,
    note: 'never fails. Letters (any case) H=0x04 L=0x08 M=0x0C A=0x10 F=0x20 D=0x40 P=0x80 +=0x100, "-" clears the base bit 0x02; other characters ignored; starts from base 0x02. Absent: 0' },
  { key: 'hitflag', kind: { k: 'hitFlags' }, fatal: false, note: 'same letters as guardflag. Absent: 0x3E' },
  { key: 'animtype', kind: WORD, fatal: true, note: 'first letter: l=0 m=1 h=2 (hard/heavy) b=3 u=4 d=5 (diagup); other = fatal. Default 0' },
  { key: 'air.animtype', kind: WORD, fatal: true, note: 'same letters; default = animtype' },
  { key: 'fall.animtype', kind: WORD, fatal: true, note: 'same letters; default 4 if air.animtype is u, 5 if d, else 3 (back)' },
  { key: 'ground.type', kind: WORD, fatal: true, note: 'first letter: n=0 h=1 l=2 t=3; other = fatal. Default 1 (high)' },
  { key: 'air.type', kind: WORD, fatal: true, note: 'same letters; default = ground.type' },
  ...palFxSpecs('palfx.'),
  ...envShakeSpecs('envshake.'),
  ...envShakeSpecs('fall.envshake.'),
];

/** Projectile_ParseParams, in source order. The HitDef keys are read after projmisstime...supermovetime. */
const PROJECTILE_KEYS: ParamSpec[] = [
  { key: 'projid', kind: INT, fatal: true, note: 'absent: zero' },
  { key: 'projanim', kind: INT, fatal: true,
    note: 'plain Expr int; NO F/S prefix in this parser (Cns_ParseAnimRef is used only by SuperPause). Absent: zero (calloc)' },
  { key: 'offset', kind: II_PAIR, fatal: true, note: 'absent: zero' },
  { key: 'postype', kind: POSTYPE, fatal: true, note: 'default p1; first letter p1/p2/f/b/l/r/n, other = fatal' },
  { key: 'projhitanim', kind: INT, fatal: true, note: 'default -1' },
  { key: 'projremanim', kind: INT, fatal: true, note: 'absent: copy of projhitanim' },
  { key: 'projcancelanim', kind: INT, fatal: true, note: 'absent: copy of projremanim' },
  { key: 'projsprpriority', kind: INT, fatal: true, note: 'default 3' },
  { key: 'projedgebound', kind: INT, fatal: true, note: 'default 40 (320-wide units scaled by game/char coords)' },
  { key: 'projstagebound', kind: INT, fatal: true, note: 'default 40 (scaled)' },
  { key: 'projheightbound', kind: II_PAIR, fatal: true, note: 'default -240 (scaled), 1 (scaled)' },
  { key: 'velocity', kind: FF_PAIR, fatal: true, note: 'default 0,0' },
  { key: 'remvelocity', kind: FF_PAIR, fatal: true, note: 'absent: zero' },
  { key: 'velmul', kind: FF_PAIR, fatal: true, note: 'default 1,1' },
  { key: 'accel', kind: FF_PAIR, fatal: true, note: 'default 0,0' },
  { key: 'projscale', kind: FF_PAIR, fatal: true, note: 'default 1,1' },
  { key: 'projhits', kind: { k: 'values', fmt: 'i', check: 'pair' }, fatal: true, note: 'single value, nothing after; default 1' },
  { key: 'projpriority', kind: { k: 'values', fmt: 'i', check: 'pair' }, fatal: true, note: 'default 1' },
  { key: 'projremove', kind: { k: 'values', fmt: 'i', check: 'pair' }, fatal: true, note: 'default 1' },
  { key: 'projremovetime', kind: { k: 'values', fmt: 'i', check: 'pair' }, fatal: true, note: 'default -1' },
  { key: 'projmisstime', kind: { k: 'values', fmt: 'i', check: 'pair' }, fatal: true, note: 'absent: zero' },
  { key: 'projshadow', kind: { k: 'values', fmt: 'iii', check: 'none' }, fatal: false, note: 'result not checked at all (comment "not checked at all"); partial parse keeps what was read' },
  { key: 'pausemovetime', kind: INT, fatal: true, note: 'default 0' },
  { key: 'supermovetime', kind: INT, fatal: true, note: 'default 0' },
  // ... every HitDef key (HITDEF_KEYS above) is read here; a failure is fatal ("Error parsing Hitdef of projectile")
  ...HITDEF_KEYS,
  { key: 'ownpal', kind: INT, fatal: true, note: 'default 0 (read after the HitDef keys)' },
  { key: 'remappal', kind: II_CHECKED, fatal: true, note: 'default first value -1' },
  // AfterImage_ParseParams("afterimage.") only runs if `afterimage.time` exists at all.
  ...afterImageSpecs('afterimage.').map((s) => ({
    ...s,
    note: (s.note ? s.note + '. ' : '') + 'only read when the key afterimage.time is present',
  })),
];

/** Helper_ParseParams, in source order. */
const HELPER_KEYS: ParamSpec[] = [
  { key: 'helpertype', kind: WORD, fatal: true, note: 'whole-string case-insensitive: normal (0) | player (1); or ANY text starting with "proj" (2). Other = fatal. Absent: 0 (calloc)' },
  { key: 'name', kind: { k: 'string' }, fatal: false, note: 'Ini_ReadString, at most sizeof(name)-1 chars, quotes removed; cannot fail when the key exists' },
  { key: 'id', kind: INT, fatal: true, note: 'absent: zero' },
  { key: 'pos', kind: FF_CHECKED, fatal: true, note: 'absent: zero' },
  { key: 'postype', kind: POSTYPE, fatal: true, note: 'first letter p1/p2/f/b/l/r/n, other = fatal. Absent: calloc zero = P1 (no explicit default in the parser)' },
  { key: 'facing', kind: INT, fatal: true, note: 'default 1' },
  { key: 'stateno', kind: INT, fatal: true, note: 'default 0' },
  { key: 'keyctrl', kind: INT, fatal: true, note: 'default 0' },
  { key: 'ownpal', kind: INT, fatal: true, note: 'default 0' },
  { key: 'remappal', kind: II_CHECKED, fatal: true, note: 'default first value -1' },
  { key: 'pausemovetime', kind: INT, fatal: true, note: 'default 0' },
  { key: 'supermovetime', kind: INT, fatal: true, note: 'default 0' },
  { key: 'size.xscale', kind: FLT, fatal: true, note: 'default -FLT_MAX (unset)' },
  { key: 'size.yscale', kind: FLT, fatal: true, note: 'default -FLT_MAX (unset)' },
  { key: 'size.ground.back', kind: INT, fatal: true, note: 'default INT_MIN (unset)' },
  { key: 'size.ground.front', kind: INT, fatal: true, note: 'default INT_MIN (unset)' },
  { key: 'size.air.back', kind: INT, fatal: true, note: 'default INT_MIN (unset)' },
  { key: 'size.air.front', kind: INT, fatal: true, note: 'default INT_MIN (unset)' },
  { key: 'size.height', kind: INT, fatal: true, note: 'default INT_MIN (unset)' },
  { key: 'size.proj.doscale', kind: INT, fatal: true, note: 'default INT_MIN (unset)' },
  { key: 'size.head.pos', kind: II_CHECKED, fatal: true, note: 'default INT_MIN,INT_MIN (unset)' },
  { key: 'size.mid.pos', kind: II_CHECKED, fatal: true, note: 'default INT_MIN,INT_MIN (unset)' },
  { key: 'size.shadowoffset', kind: INT, fatal: true, note: 'default INT_MIN (unset)' },
];

/** parse_var_value + parse_var_line, shared by VarSet/VarAdd (sys=1) and ParentVarSet/ParentVarAdd (sys=0). */
function varSpecs(sys: boolean): ParamSpec[] {
  return [
    { key: 'value', kind: CUSTOM, fatal: true,
      note: 'if `value` exists the "value = x, v/fv = n" form is used and the var(n) line form is NOT looked at. With `v` present: value AND v compiled as INT exprs. Else with `fv` present: fv as INT (index), value as FLOAT. With neither v nor fv: value is not even compiled and the controller loads as a no-op' },
    { key: 'v', kind: INT, fatal: true, note: 'only meaningful with `value`; checked first (wins over fv)' },
    { key: 'fv', kind: INT, fatal: true, note: 'index expression; only read when `v` is absent' },
    { key: 'var(n)', kind: { k: 'varLine' }, fatal: true,
      note: 'used only when `value` is ABSENT. The first line of the group starting (case-insensitive prefix) with var / fvar' +
        (sys ? ' / sysvar / sysfvar' : '') +
        ' is used; none found = fatal. The kind is taken from the CASE-SENSITIVE first letters: ' +
        (sys
          ? 'lowercase "v" = var, lowercase "f" = fvar, otherwise sysvar if the 4th char is a lowercase "v" else sysfvar, so "Var(1)" / "Fvar(1)" / "SysVar(1)" read as sysfvar'
          : 'lowercase "v" = var, anything else = fvar, so "Var(1)" reads as fvar; sysvar/sysfvar lines are not recognised (no match = fatal)') +
        '. Then "(" index-expression ")" then everything after the first "=" is the value (INT for var/sysvar, FLOAT for fvar/sysfvar); a missing "(" , ")" or "=" is fatal' },
  ];
}

// ---------------------------------------------------------------------------------------------------------------

/** Keyed by lowercase controller type name as mugen.exe compares it (include every alias it accepts). Source order. */
export const SCTRL_SPECS: Record<string, ParamSpec[]> = {
  changestate: [
    { key: 'value', kind: INT, required: true, fatal: true },
    { key: 'ctrl', kind: INT, fatal: true, note: 'default -1 (leave control unchanged)' },
    { key: 'anim', kind: INT, fatal: true, note: 'default -1 (no anim change). Plain Expr int: no F/S prefix' },
  ],
  selfstate: [
    { key: 'value', kind: INT, required: true, fatal: true },
    { key: 'ctrl', kind: INT, fatal: true, note: 'default -1' },
    { key: 'anim', kind: INT, fatal: true, note: 'default -1' },
  ],
  tag: [
    { key: 'value', kind: INT, fatal: true, note: 'NOT required; default -1' },
    { key: 'partnerstateno', kind: INT, fatal: true, note: 'default -1. At run time a parsed Tag is fatal ("PlayerSCtrlApplyElem not recognised")' },
  ],
  ctrlset: [...VALUE_REQUIRED_INT],
  turn: [],
  changeanim: [
    { key: 'value', kind: INT, required: true, fatal: true, note: 'plain Expr int, no F/S prefix' },
    { key: 'elem', kind: INT, fatal: true, note: 'absent: zero' },
  ],
  changeanim2: [
    { key: 'value', kind: INT, required: true, fatal: true, note: 'plain Expr int, no F/S prefix' },
    { key: 'elem', kind: INT, fatal: true, note: 'absent: zero' },
  ],
  playsnd: [
    { key: 'value', kind: SOUNDREF, required: true, fatal: true,
      note: 'F/S prefix then "group, number". DEFAULT (no prefix) = own sounds (fight flag preset to 0), unlike HitDef sounds. "S5" / "5" alone is accepted (number stays zero)' },
    { key: 'volume', kind: INT, fatal: true, note: 'parsed and evaluated but never used. Absent: zero' },
    { key: 'volumescale', kind: FLT, fatal: true, note: 'default 100' },
    { key: 'channel', kind: INT, fatal: true, note: 'default -1' },
    { key: 'lowpriority', kind: INT, fatal: true, note: 'absent: zero' },
    { key: 'freqmul', kind: FLT, fatal: true, note: 'default 1' },
    { key: 'loop', kind: INT, fatal: true, note: 'absent: zero' },
    { key: 'abspan', kind: INT, fatal: true, note: 'if present, sets absolute pan and `pan` is NOT read' },
    { key: 'pan', kind: INT, fatal: true, note: 'only read when abspan is absent; relative pan' },
  ],
  stopsnd: [
    { key: 'channel', kind: INT, required: true, fatal: true },
  ],
  sndpan: [
    { key: 'channel', kind: INT, required: true, fatal: true },
    { key: 'abspan', kind: INT, fatal: true, note: 'sets absolute flag and stores into the pan slot; only read if channel parsed' },
    { key: 'pan', kind: INT, fatal: true, note: 'read after abspan into the same slot, so when both exist pan wins the value but the absolute flag stays set' },
  ],
  lifeset: [...VALUE_REQUIRED_INT],
  lifeadd: [
    { key: 'value', kind: INT, required: true, fatal: true },
    { key: 'kill', kind: INT, fatal: true, note: 'default 1' },
    { key: 'absolute', kind: INT, fatal: true, note: 'absent: zero' },
  ],
  powerset: [...VALUE_REQUIRED_INT],
  poweradd: [...VALUE_REQUIRED_INT],
  posset: [...XYZ],
  posadd: [...XYZ],
  posfreeze: [
    { key: 'value', kind: INT, fatal: true, note: 'default 1' },
  ],
  velset: [...XYZ],
  veladd: [...XYZ],
  velmul: [...XYZ],
  gravity: [],
  hitdef: [...HITDEF_KEYS],
  reversaldef: [
    { key: 'reversal.attr', kind: { k: 'hitDefAttr' }, required: true, fatal: true, note: 'missing or invalid = fatal. Stored separately from `attr`' },
    ...HITDEF_KEYS,
  ],
  hitby: [
    { key: 'value', kind: { k: 'hitDefAttr' }, fatal: true,
      note: 'value is tried first (slot 1); if absent, value2 is used (slot 2); neither present = fatal. Invalid attr text = fatal (HitDefAttr_Parse -1). Trailing text after the attr list is not checked (end pointer is NULL)' },
    { key: 'value2', kind: { k: 'hitDefAttr' }, fatal: true, note: 'only consulted when `value` is absent' },
    { key: 'time', kind: INT, fatal: true, note: 'default 1' },
  ],
  nothitby: [
    { key: 'value', kind: { k: 'hitDefAttr' }, fatal: true,
      note: 'same as hitby (the attr is stored complemented, ~attr & 0xFFF). value tried first, else value2, neither = fatal' },
    { key: 'value2', kind: { k: 'hitDefAttr' }, fatal: true, note: 'only consulted when `value` is absent' },
    { key: 'time', kind: INT, fatal: true, note: 'default 1' },
  ],
  hitvelset: [
    { key: 'x', kind: INT, fatal: true, note: 'compiled with EXPR_WANT_INT (not float) as in mugen.exe. Absent: zero' },
    { key: 'y', kind: INT, fatal: true, note: 'compiled with EXPR_WANT_INT. Absent: zero' },
  ],
  hitfallset: [
    { key: 'value', kind: INT, fatal: true, note: 'default -1' },
    { key: 'velocity', kind: FF_PAIR, fatal: true, note: 'default -FLT_MAX,-FLT_MAX (unset). At run time the x velocity is stored as the y one too (sctrl.c header quirk)' },
  ],
  hitfalldamage: [],
  hitfallvel: [],
  hitadd: [...VALUE_REQUIRED_INT],
  attackmulset: [...VALUE_REQUIRED_FLOAT],
  defencemulset: [...VALUE_REQUIRED_FLOAT],
  statetypeset: [
    { key: 'statetype', kind: WORD, fatal: true, note: 'first letter only (any case): a, c, l, s; other (including u, empty) = fatal. If absent, `value` is read instead. Default -1 (unchanged)' },
    { key: 'value', kind: WORD, fatal: true, note: 'same parsing; only consulted when `statetype` is absent' },
    { key: 'movetype', kind: WORD, fatal: true, note: 'first letter only: a, h, i; other = fatal. Default -1 (unchanged)' },
    { key: 'physics', kind: WORD, fatal: true, note: 'first letter only: a, c, n, s; other = fatal. Default -1 (unchanged)' },
  ],
  hitoverride: [
    { key: 'attr', kind: { k: 'hitDefAttr' }, fatal: true, note: 'invalid = fatal. Absent: attr 0' },
    { key: 'stateno', kind: INT, fatal: true, note: 'default -1' },
    { key: 'time', kind: INT, fatal: true, note: 'default 1' },
    { key: 'forceair', kind: INT, fatal: true, note: 'default 0' },
    { key: 'slot', kind: INT, fatal: true, note: 'read last by the dispatcher; absent: 0' },
  ],
  movehitreset: [],
  victoryquote: [
    { key: 'value', kind: INT, fatal: true, note: 'default -1. Controller needs mugenversion >= 1.0 or the character fails to load' },
  ],
  assertspecial: [
    { key: 'flag', kind: WORD, required: true, fatal: true,
      note: 'whole-string, case-insensitive. Global: intro roundnotover noko nokosnd nokoslow nomusic globalnoshadow timerfreeze nobardisplay nobg nofg. Player: nostandguard nocrouchguard noairguard noautoturn noshadow nojugglecheck nowalk unguardable invisible. Anything else (including "nobardisplay " with trailing text) = fatal' },
    { key: 'flag2', kind: WORD, fatal: true, note: 'optional, same names; unknown = fatal' },
    { key: 'flag3', kind: WORD, fatal: true, note: 'optional, same names; unknown = fatal' },
  ],
  zoom: [
    { key: 'pos', kind: FF_CHECKED, fatal: true, note: 'default 1.0,1.0 as set by the parser (line ~685)' },
    { key: 'scale', kind: FLT, fatal: true, note: 'default 1' },
    { key: 'lag', kind: FLT, fatal: true, note: 'default 0. Controller needs mugenversion >= 1.1 or the character fails to load. Run-time clamps (not parse) apply to the values' },
  ],
  projectile: [...PROJECTILE_KEYS],
  width: [
    { key: 'edge', kind: { k: 'values', fmt: 'ii', check: 'custom' }, fatal: true, note: 'result count ignored but *end must be 0 (an unparsable text leaves *end non-zero and fails). One value: second stays zero' },
    { key: 'player', kind: { k: 'values', fmt: 'ii', check: 'custom' }, fatal: true, note: 'same check as edge' },
    { key: 'value', kind: { k: 'values', fmt: 'ii', check: 'custom' }, fatal: true,
      note: 'only read when NEITHER edge nor player exists, and then it is effectively REQUIRED: an absent value gives count 0 and the controller FAILS to load. n>=1 and *end == 0 needed; sets both edge and player to the pair' },
  ],
  sprpriority: [
    { key: 'value', kind: INT, fatal: true, note: 'NOT required; absent: zero' },
  ],
  angledraw: [
    { key: 'value', kind: FLT, fatal: true, note: 'Cns_CompileFloat, default -FLT_MAX (unset)' },
    { key: 'scale', kind: FF_PAIR, fatal: true, note: 'default 1,1' },
  ],
  angleset: [{ key: 'value', kind: FLT, fatal: true, note: 'NOT required; absent: zero' }],
  angleadd: [{ key: 'value', kind: FLT, fatal: true, note: 'NOT required; absent: zero' }],
  anglemul: [{ key: 'value', kind: FLT, fatal: true, note: 'NOT required; absent: zero' }],
  trans: [
    { key: 'trans', kind: WORD, fatal: true,
      note: 'whole-string case-insensitive: none | add | addalpha | add1 | sub | default | empty. Invalid = fatal here (unlike Explod/AfterImage). Absent: trans -1 (unchanged), alpha 256,0. add/sub imply 256,256; add1 256,128; addalpha/none/default 256,0' },
    { key: 'alpha', kind: { k: 'values', fmt: 'ii', check: 'custom' }, fatal: true,
      note: 'read even without a valid trans word; result count ignored but *end must be 0. Overrides the alpha implied by trans (src,dst); a lone value leaves dst from trans' },
  ],
  screenbound: [
    { key: 'value', kind: INT, fatal: true, note: 'default 0' },
    { key: 'movecamera', kind: II_PAIR, fatal: true, note: 'default 0,0' },
  ],
  targetbind: [
    { key: 'time', kind: INT, fatal: true, note: 'default 1' },
    { key: 'id', kind: INT, fatal: true, note: 'default -1' },
    { key: 'pos', kind: FF_PAIR, fatal: true, note: 'default 0,0' },
  ],
  bindtotarget: [
    { key: 'time', kind: INT, fatal: true, note: 'default 1' },
    { key: 'id', kind: INT, fatal: true, note: 'default -1' },
    { key: 'pos', kind: { k: 'values', fmt: 'ff:,', check: 'custom' }, fatal: true,
      note: '"x, y[, postype]". Default x,y unset (-FLT_MAX), bind point foot (0). After the floats: if text remains it must start with ","; that needs both x and y parsed (n==2); then the first letter after optional blanks f=foot(0) h=head(2) m=mid(1); other = fatal; nothing left = keep foot. "5, Head" (no y) is fatal' },
  ],
  targetstate: [
    { key: 'value', kind: INT, required: true, fatal: true },
    { key: 'id', kind: INT, fatal: true, note: 'default -1' },
  ],
  targetpoweradd: [
    { key: 'value', kind: INT, required: true, fatal: true },
    { key: 'id', kind: INT, fatal: true, note: 'default -1' },
  ],
  targetlifeadd: [
    { key: 'value', kind: INT, required: true, fatal: true },
    { key: 'kill', kind: INT, fatal: true, note: 'default 1' },
    { key: 'absolute', kind: INT, fatal: true, note: 'absent: zero' },
    { key: 'id', kind: INT, fatal: true, note: 'default -1' },
  ],
  targetvelset: [
    { key: 'x', kind: FLT, fatal: true, note: 'default -FLT_MAX (unset)' },
    { key: 'y', kind: FLT, fatal: true, note: 'default -FLT_MAX (unset)' },
    { key: 'z', kind: FLT, fatal: true, note: 'default -FLT_MAX (unset)' },
    { key: 'id', kind: INT, fatal: true, note: 'default -1' },
  ],
  targetveladd: [
    { key: 'x', kind: FLT, fatal: true, note: 'default -FLT_MAX (unset)' },
    { key: 'y', kind: FLT, fatal: true, note: 'default -FLT_MAX (unset)' },
    { key: 'z', kind: FLT, fatal: true, note: 'default -FLT_MAX (unset)' },
    { key: 'id', kind: INT, fatal: true, note: 'default -1' },
  ],
  targetfacing: [
    { key: 'value', kind: INT, fatal: true, note: 'NOT required; absent: zero' },
    { key: 'id', kind: INT, fatal: true, note: 'default -1' },
  ],
  targetdrop: [
    { key: 'excludeid', kind: INT, fatal: true, note: 'default -1 (key matches case-insensitively)' },
    { key: 'keepone', kind: INT, fatal: true, note: 'default 1' },
  ],
  attackdist: [...VALUE_REQUIRED_INT],
  playerpush: [...VALUE_REQUIRED_INT],
  varset: varSpecs(true),
  varadd: varSpecs(true),
  varrangeset: [
    { key: 'value', kind: INT, fatal: true,
      note: 'int form. If `value` is absent, `fvalue` is used (float form). If NEITHER exists the engine prints "VarRangeSet value not specified." and calls Error_Exit: the whole process terminates, not just the load' },
    { key: 'fvalue', kind: FLT, fatal: true, note: 'only consulted when `value` is absent; selects the fvar range' },
    { key: 'first', kind: INT, fatal: true, note: 'default 0' },
    { key: 'last', kind: INT, fatal: true, note: 'default PLAYER_VAR_COUNT-1 (59 in stock MUGEN) for value, PLAYER_FVAR_COUNT-1 (39) for fvalue; constants not in the sources read' },
  ],
  varrandom: [
    { key: 'v', kind: INT, required: true, fatal: true },
    { key: 'range', kind: { k: 'values', fmt: 'ii', check: 'custom' }, fatal: true,
      note: 'default 0..1000. *end must be 0 and n>=1. ONE value = the UPPER bound (lower becomes 0), "range = 5" means 0..5' },
  ],
  offset: [
    { key: 'x', kind: FLT, fatal: true },
    { key: 'y', kind: FLT, fatal: true },
  ],
  envshake: [...envShakeSpecs('')],
  fallenvshake: [],
  envcolor: [
    { key: 'value', kind: { k: 'values', fmt: 'iii', check: 'custom' }, fatal: true, note: 'default 255,255,255. If present needs EXACTLY 3 values and *end == 0' },
    { key: 'time', kind: INT, fatal: true, note: 'default 1' },
    { key: 'under', kind: INT, fatal: true, note: 'default 0' },
  ],
  gamemakeanim: [
    { key: 'value', kind: INT, fatal: true, note: 'default 0. Plain Expr int: no F/S prefix' },
    { key: 'under', kind: INT, fatal: true, note: 'default 0' },
    { key: 'pos', kind: { k: 'values', fmt: 'ff', check: 'endFirst' }, fatal: true, note: 'default 0,0' },
    { key: 'random', kind: INT, fatal: true, note: 'absent: zero' },
  ],
  afterimage: afterImageSpecs(''),
  afterimagetime: [
    { key: 'time', kind: INT, fatal: true, note: 'absent: zero' },
    { key: 'value', kind: INT, fatal: true, note: 'only read when `time` is absent' },
  ],
  pause: [
    { key: 'time', kind: INT, fatal: true, note: 'default 0' },
    { key: 'movetime', kind: INT, fatal: true, note: 'default 0' },
    { key: 'endcmdbuftime', kind: INT, fatal: true, note: 'default 0' },
    { key: 'pausebg', kind: INT, fatal: true, note: 'default 1' },
  ],
  superpause: [
    { key: 'time', kind: INT, fatal: true, note: 'default 30. Compiled TWICE: first by Pause_ParseParams (failure ignored), then again here (fatal)' },
    { key: 'movetime', kind: INT, fatal: false, note: 'read only by the Pause_ParseParams call whose result is IGNORED: a bad value is swallowed and every later Pause key (endcmdbuftime, pausebg) is then skipped. Default 0' },
    { key: 'endcmdbuftime', kind: INT, fatal: false, note: 'same swallowing as movetime. Default 0' },
    { key: 'pausebg', kind: INT, fatal: false, note: 'same swallowing as movetime. Default 1 (unless an earlier Pause key failed: then zero)' },
    { key: 'anim', kind: { k: 'animRef' }, fatal: true, note: 'F/S prefix + one int. Default 100 from fight.def (fight flag preset to 1). Only SuperPause uses Cns_ParseAnimRef' },
    { key: 'pos', kind: { k: 'values', fmt: 'ff', check: 'endFirst' }, fatal: true, note: 'absent: zero' },
    { key: 'darken', kind: INT, fatal: true, note: 'default 1' },
    { key: 'p2defmul', kind: FLT, fatal: true, note: 'default 0' },
    { key: 'poweradd', kind: INT, fatal: true, note: 'default 0' },
    { key: 'unhittable', kind: INT, fatal: true, note: 'default 1' },
    { key: 'sound', kind: SOUNDREF, fatal: true, note: 'F/S prefix, default fight.def (fight preset 1), group -1' },
  ],
  makedust: [
    { key: 'pos', kind: { k: 'values', fmt: 'ii', check: 'endFirst' }, fatal: true, note: 'absent: zero' },
    { key: 'pos2', kind: { k: 'values', fmt: 'ff', check: 'custom' }, fatal: true, note: '*end must be 0 and n>=1; presence flag set' },
    { key: 'spacing', kind: INT, fatal: true, note: 'default 3' },
  ],
  palfx: palFxSpecs(''),
  bgpalfx: palFxSpecs(''),
  allpalfx: palFxSpecs(''),
  remappal: [
    { key: 'source', kind: II_PAIR, fatal: true, note: 'default -1,0' },
    { key: 'dest', kind: { k: 'values', fmt: 'ii', check: 'custom' }, required: true, fatal: true,
      note: 'missing = fail (silent). Count ignored, *end must be 0. Default -1,0' },
  ],
  explod: [...EXPLOD_KEYS],
  modifyexplod: [...EXPLOD_KEYS],
  removeexplod: [
    { key: 'id', kind: INT, fatal: true, note: 'default -1' },
  ],
  explodbindtime: [
    { key: 'id', kind: INT, fatal: true, note: 'default -1' },
    { key: 'time', kind: INT, fatal: true, note: 'default 1; if absent `value` is read instead' },
    { key: 'value', kind: INT, fatal: true, note: 'only consulted when `time` is absent' },
  ],
  forcefeedback: [],
  helper: [...HELPER_KEYS],
  destroyself: [
    { key: 'recursive', kind: INT, fatal: true, note: 'default 0' },
    { key: 'removeexplods', kind: INT, fatal: true, note: 'default 0' },
  ],
  parentvarset: varSpecs(false),
  parentvaradd: varSpecs(false),
  bindtoparent: [
    { key: 'time', kind: INT, fatal: true, note: 'default 1' },
    { key: 'facing', kind: INT, fatal: true, note: 'absent: zero' },
    { key: 'pos', kind: FF_CHECKED, fatal: true, note: 'absent: zero' },
  ],
  bindtoroot: [
    { key: 'time', kind: INT, fatal: true, note: 'default 1' },
    { key: 'facing', kind: INT, fatal: true, note: 'absent: zero' },
    { key: 'pos', kind: FF_CHECKED, fatal: true, note: 'absent: zero' },
  ],
  displaytoclipboard: [
    { key: 'text', kind: { k: 'string' }, required: true, fatal: true,
      note: 'CnsText_Parse: must start with " and end with " with nothing after; up to 6 %d/%i/%f style specifiers (invalid specifier, more than 6, unterminated quote or trailing text = fatal); escapes \\" \\\\ \\n \\t' },
    { key: 'params', kind: { k: 'values', fmt: 'nnnnnn', check: 'custom' }, fatal: true,
      note: 'if present: n>=1, n must EQUAL the number of specifiers in text, and *end == 0. Absent with specifiers in text is accepted' },
  ],
  appendtoclipboard: [
    { key: 'text', kind: { k: 'string' }, required: true, fatal: true, note: 'same as displaytoclipboard' },
    { key: 'params', kind: { k: 'values', fmt: 'nnnnnn', check: 'custom' }, fatal: true, note: 'same as displaytoclipboard' },
  ],
  clearclipboard: [],
  null: [],
};

/** The [Statedef] header parameters. Read only for statedef numbers >= 0 (negative ones keep no parameters). */
export const STATEDEF_SPEC: ParamSpec[] = [
  { key: 'type', kind: WORD, fatal: true, note: 'first letter (any case): a, c, l, s, u (unchanged); other = fatal. Default s (stand)' },
  { key: 'movetype', kind: WORD, fatal: true, note: 'first letter: a, h, i, u (unchanged); other = fatal. Default i (idle)' },
  { key: 'juggle', kind: INT, fatal: true, note: 'default -1' },
  { key: 'facep2', kind: INT, fatal: true, note: 'default 0' },
  { key: 'hitdefpersist', kind: INT, fatal: true, note: 'default 0' },
  { key: 'hitcountpersist', kind: INT, fatal: true, note: 'default 0' },
  { key: 'movehitpersist', kind: INT, fatal: true, note: 'default 0' },
  { key: 'sprpriority', kind: INT, fatal: true, note: 'optional; its presence is recorded (has_sprpriority)' },
  { key: 'physics', kind: WORD, fatal: true, note: 'first letter: a, c, n, s, u (unchanged); other = fatal. Default n (none)' },
  { key: 'velset', kind: { k: 'values', fmt: 'ff', check: 'custom' }, fatal: true,
    note: 'n==0 fatal. One value leaves y unset. Default -FLT_MAX,-FLT_MAX (unset). Trailing text (a third value) is fatal only when mugenversion >= compat_version[1] (1.0); older characters tolerate it' },
  { key: 'ctrl', kind: INT, fatal: true, note: 'default -1 (unset)' },
  { key: 'anim', kind: INT, fatal: true, note: 'default -1 (unset). Plain Expr int: no F/S prefix' },
  { key: 'poweradd', kind: INT, fatal: true, note: 'default 0' },
];
