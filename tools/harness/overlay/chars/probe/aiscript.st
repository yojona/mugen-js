; AI scenario: keyboard/CPU-driven probe whose P1 records Random every tick
; (var(10)) so the RNG sequence can be followed.

[State -2, rng]
type = VarSet
triggerall = TeamSide = 1
trigger1 = 1
var(10) = random
