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
variable on the leaving screen's last frame). Comparisons use `?pristine=1`
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

| # | Stage | Goal | State |
|---|---|---|---|
| 1 | Community characters | CPU vs CPU with real characters until whole matches match | Five KOF pairs match (Iori/Kyo, Kim/Benimaru, Clark/Kula, Athena/Leona, Andy/Chris); King/Joe open at frame 2070; next: more characters |
| 2 | AI coverage | Whole matches at levels 1, 3, 5, 6 and 8; time-over round; draw | Ready to start |
| 3 | Exact camera | Reproduce the float math at `0x4167xx` (tiny drifts left in round 1) | Optional hardening |
| 4 | Game modes | Team (simul/turns), Survival, Arcade with AI ramp; demo mode (title idle 600 frames); continue "Yes" path verified | Pending |
| 5 | Interface | Options menu, key config, gamepad | Pending |
| 6 | Audio | Stage and menu music (no music files in `ref/`) | Pending |
| 7 | External content | Load user characters and stages from files | Pending |
