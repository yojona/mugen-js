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

**Limit:** everything above is verified with KFM (and kfm720) only.
Controllers and triggers KFM does not use are implemented from the Elecbyte
documentation but not yet compared against the original.

## Roadmap

| # | Stage | Goal | State |
|---|---|---|---|
| 1 | Community characters | CPU vs CPU with 2-3 real characters; fix the controllers and triggers KFM does not use | Needs the characters |
| 2 | AI coverage | Whole matches at levels 1, 3, 5, 6 and 8; time-over round; draw | Ready to start |
| 3 | Exact camera | Reproduce the float math at `0x4167xx` (tiny drifts left in round 1) | Optional hardening |
| 4 | Game modes | Team (simul/turns), Survival, Arcade with AI ramp | Pending |
| 5 | Interface | Options menu, key config, gamepad | Pending |
| 6 | Audio | Stage and menu music (no music files in `ref/`) | Pending |
| 7 | External content | Load user characters and stages from files | Pending |
