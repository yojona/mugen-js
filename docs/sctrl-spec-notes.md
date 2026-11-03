# State controller parsing: notable quirks of mugen.exe 1.1

Source: ref/mugen-unleashed/src/sctrl.c, cnsparse.c, statedef.c. Data table: src/engine/sctrl-spec.ts.

## Failure scope
- No controller is ever dropped on its own. Any parse failure (bad key, unknown type, failed version check, bad
  trigger) makes StateCtrl_Parse return 0, then StateDef_Parse and StateDefs_Load fail, and the character does not load.
- Unknown `type` name: fatal ("Not a valid elem type"). Missing `type`: fatal.
- Version gate, checked AFTER the parameters parse: VictoryQuote needs mugenversion >= 1.0, Zoom needs >= 1.1. Failing = fatal.
- VarRangeSet without `value` or `fvalue` calls Error_Exit: the whole process exits, not just the load.

## Surprising fatal cases
- Width with none of `edge`, `player`, `value` fails (value is effectively required in that case).
- SndPan / StopSnd: `channel` required. ReversalDef: `reversal.attr` required. RemapPal: `dest` required.
- Trans controller: an invalid `trans` word is fatal, while Explod and AfterImage silently ignore an invalid word
  (and then skip `alpha`).
- HitDef `priority`: a trailing comma with nothing after it, or any word not starting with h/m/d, is fatal.
- HitDef `guard.velocity` is ONE float parsed with the whole-text compiler: "-5, 2" is fatal.
- BindToTarget `pos = 5, Head` (no y) is fatal; it must be "x, y, Head".
- StateTypeSet: a statetype of `u` is fatal (only a/c/l/s), unlike [Statedef].
- Statedef `velset` with a third value is fatal only for mugenversion >= 1.0.
- HitDef `snap` / `mindist` / `maxdist` take an extra ignored z value only for mugenversion < 1.0.

## Swallowed failures (fatal: false)
- Projectile `projshadow` (result unchecked).
- Explod `space` (unknown word ignored), Explod and AfterImage `trans` (invalid word ignored).
- SuperPause `movetime`, `endcmdbuftime`, `pausebg`: parsed through Pause_ParseParams whose result is ignored; the first
  failure also skips the keys after it. SuperPause `time` is compiled twice and the second is fatal.

## Defaults and aliases that differ from the documentation
- PlaySnd `value` without prefix = own sounds. HitDef `hitsound` / `guardsound` and SuperPause `sound` without prefix = fight.def.
- HitDef `sparkno` / `guard.sparkno`: only an `S` prefix is parsed (own sprites); no `F` handling.
- Explod `anim`: only an `f`/`F` prefix; no `S`. Projectile `projanim` / `projhitanim` / ... and ChangeState `anim`
  have no prefix at all. Cns_ParseAnimRef (F/S) is used only by SuperPause `anim`.
- Explod `vel` falls back to `velocity`. HitDef `p1sprpriority` falls back to `sprpriority`.
  ExplodBindTime `time` falls back to `value`. StateTypeSet `statetype` falls back to `value`. AfterImageTime `time`
  falls back to `value`. HitBy / NotHitBy `value` falls back to `value2`.
- ModifyExplod `facing` and `vfacing` default to 1 (no "unchanged" sentinel), and `anim` has no sentinel either.
- Explod `ignorehitpause` default 1 (reuses the bindtime default); `bindid` default -2 (reuses removetime).
- AfterImage `palbright`: first and second values both land in palbright[1]; palbright[0] stays 30.
- AssertSpecial flags are whole-word and fatal when unknown; flag2/flag3 are optional.
- HitVelSet `x` / `y` are compiled as INT expressions.
- VarSet / VarAdd line form `var(n) = x`: kind is chosen from the case-sensitive first letters, so "Var(1)" reads as
  sysfvar (VarSet/VarAdd) or fvar (ParentVarSet/ParentVarAdd). ParentVar* do not recognise sysvar lines.
- Tag parses (value, partnerstateno) but running a parsed Tag is fatal at run time.

## Unverified in the sources read
- Whether Expr_Compile of an empty value fails (assumed).
- compat_version[0..2] numeric values (assumed 1.1 / 1.0 / ?). Explod postype default depends on compat_version[2].
- PLAYER_VAR_COUNT / PLAYER_FVAR_COUNT (assumed 60 / 40).
- Whether "F2" given to HitDef sparkno fails inside Expr_Compile (expected).
