# Status and roadmap

## What matches MUGEN 1.1 exactly

Every row is a test in `tests/harness.test.ts` that replays a capture of the
original `mugen.exe` (see `tools/harness`) and requires 0 differences, tick by
tick, in every logged field (state, animation, position, velocity, life,
power, camera, RNG).

| Area | Covered | Reference test |
|---|---|---|
| Base states and physics | Walk, jump, crouch, landing, gravity, friction | `kfm-probe`, `basic` |
| KFM moveset | Normals, specials, throw, knee, upper, palm | `moves` |
| Combat | HitDef, damage, hit pause, shake, juggle, hits from behind | `moves`, `kfm-aivsai` |
| Guarding | Stand/crouch/air guard, guarded hits, guard flag | `guard` |
| Knock-down and get-up | Fall, bounce, lying down, get-up count | `liedown` |
| Trips | No bounce; a KO throws higher | `kfm-ko-trip` |
| Push | Player push, corner push, Clsn2 contact | `push` |
| Input | Command buffer, quick taps, held keys | `taps`, `slide`, `slide2` |
| Camera | Tension, centring, stage bound | `kfm-camera` |
| RNG | Park-Miller generator, Random, per-Explod draws | `kfm-fx` |
| Projectiles and helpers | Projectile, Helper | `kfm-fx` |
| Supers | SuperPause, AfterImage, corner push, mindist | `kfm-supers` |
| 720p characters | Unit scaling (kfm720) | `kfm-vs-kfm720` |
| CPU AI | State machine, AI.Cheat, learning, guard, counter | `kfm-ai4`, `kfm-aivs` |
| CPU vs CPU per level | Levels 2, 4 and 7, whole first round | `kfm-ai-level2/7`, `kfm-aivsai` |
| Whole match | 3 rounds: KO, slowdown, round end, rounds 2 and 3 | `kfm-match` |

### Whole game flow (lockstep captures, `tools/harness/run-flow.sh LOCKSTEP=1`)

Compared screen by screen and frame by frame with the same key script
(`tools/harness/flow-ours.ts` drives mugen-web in headless Chrome):

| Flow | Matches |
|---|---|
| Arcade, P1 wins (rival life held at 1) | Title, select, intro storyboard, VS, match 1 (2 rounds), victory screen, VS, match 2 (2 rounds, including kfm720's own stuck-in-5101 KO), ending storyboard, back to title. Session RNG (opponent order, match seeds) and every round's RNG state identical. |
| Arcade, P1 loses (P1 life held at 1) | Same up to the lost match, continue screen ("No"), back to title. |

Screen boundaries agree within one frame (mugen.exe switches its gameflow
variable on the leaving screen's last frame). Comparisons use `?pristine=1` on the harness page
(no content fixes).

### Community characters

| Check | Result |
|---|---|
| Load (`tools/corpus-check.ts`, 285 KOF characters from a public pack) | 283 compile with no error; the other 2 lost an apostrophe in a file name when the pack was extracted |
| Iori (ikaruga) vs EX-Kyo, CPU vs CPU, level 4 (`tests/community.test.ts`) | The whole match identical frame by frame (states, positions, velocities, life, RNG): two rounds with intros, throws, custom states, supers and SuperPauses, helpers, projectiles, explods, corner pushes, KO slowdowns and win poses, to the frame mugen.exe starts the next match (4721 frames) |
| Kim vs Benimaru (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | The whole match identical frame by frame (8286 frames): an AI-detector keyctrl helper, throws with TargetBind and Turn, trades, guard ends, pre-1.0 and 1.0 characters, default constants, camera target edges |
| Clark vs Kula (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | 9000 frames identical into round 3: helper projectiles with HitOverride/HitBy, juggle points, a time over, round resets, corner pushes from the air, draw offsets |
| Athena vs Leona (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | 9000 frames identical into round 2: helper projectiles owned by the root, several projectiles hitting in one tick, throws with snap and TargetBind, repeated Pause, trades, corner pushes |
| Andy vs Chris (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | 9000 frames identical into round 3: projectile end animations, landing turns, p2stateno into idle states (damage dropped), round resets of the get-hit variables |
| Billy vs Daimon (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | 9000 frames identical: ReversalDef (p2getp1state movetype, pause timing, hit count), NumTarget, AI learning ticks across pauses |
| King vs Joe (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | 9000 frames identical: projectiles move when their owner ran (Pause started mid-tick), world-space GetHitVar(xvel) driving a character's own corner push |
| Chang vs Choi (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | 9000 frames identical: TargetBind placed by the binder, custom states use the owner's command list, command labels across characters, hits disabled in RoundState 4 |
| Chin vs Kensou (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | 9000 frames identical: HitDef and ReversalDef share one slot (the AI learns a counter move without its reversal attr) |
| Heidern vs Geese (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | 9000 frames identical: actions with a -1 element in the middle, hit facings applied next update, BindToTarget binding the target back, projscale not in collisions |
| D-Yashiro vs Evil Robert (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | 9000 frames identical: learned AI from the .def's ai file, built-in transitions into missing states, full guardflag bits in AI records, -0.001 y velocity on falling ground hits, kill = 0 against pending damage, chainID/nochainID, KO seen the tick after the player's update, nokoslow |
| Cool Choi vs Bebum Ryo (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | Whole match (8006 frames) identical: floor dust on the round state clock |
| Kensou EX vs Geese NW (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | 9000 frames identical after the systematic port of the decompiled core (camera, hits, projectiles, controllers, triggers, round rules) |
| Asura Rugal vs Geo Kensou (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | Whole match (4726 frames) identical at full precision: pause movetime lost in a custom hit state, velocities kept in world space across a statedef turn |
| Chizuru&Maki vs Akuma (KOF pack), CPU vs CPU, level 4 (`tests/community.test.ts`) | All 9000 frames identical at full precision (helper binds move the camera, float helper origins and bind anchors, AnimExist in custom states, the element shown through an attacker's hit pause) |

The parser, the parameter readers and several rules now come from the
decompilation of the same mugen.exe (`ref/mugen-unleashed`, used only as a
reference): expressions and triggers (Expr_Parse, Trigger_Parse), every
controller's parameters (`src/engine/sctrl-spec.ts`), INI key matching,
statedef sections, command labels, missing states, helper updates, hit
direction and damage rounding, bottom handling in Expr_Eval, world-space
velocities, TargetBind vs BindTo*, special states in custom states, deferred
statedefs, HitBy masks, AnimElemTime at the loop point, hits during pauses.
`tools/harness/drive.py RNGLOG=1` patches mugen.exe to log who draws every
random number.

**Limit:** controllers and triggers that neither KFM nor these two
characters use are implemented from the decompilation or the Elecbyte
documentation but not yet compared against the original.

## Roadmap

See the [README](../README.md#roadmap).
