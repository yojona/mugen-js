; Supers scenario (no input, exact framestep): P1 gets power and walks in,
; then Triple Kung Fu Palm (3000) and Smash Kung Fu Upper (3050).
; var(10) = Random every tick to follow the RNG (explods draw from it).

[State -2, rng]
type = VarSet
triggerall = TeamSide = 1
trigger1 = 1
var(10) = random

[State -2, power]
type = PowerSet
triggerall = TeamSide = 1
trigger1 = var(58) = 35
value = 3000

[State -2, walk in]
type = VelSet
triggerall = TeamSide = 1 && stateno = 0
trigger1 = var(58) = [40, 80]
x = const(velocity.walk.fwd.x)

[State -2, triple palm]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = 100
value = 3000

[State -2, power again]
type = PowerSet
triggerall = TeamSide = 1
trigger1 = var(58) = 300
value = 3000

[State -2, walk in again]
type = VelSet
triggerall = TeamSide = 1 && stateno = 0
trigger1 = var(58) = [310, 360]
x = const(velocity.walk.fwd.x)

[State -2, smash upper]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = 380
value = 3050
