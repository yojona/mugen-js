; KO scenario (no input, exact framestep): P2 is left with 1 life, P1 walks
; in and KOs it with the crouching strong kick (440, a Trip), to compare the
; KO knock-down with mugen.exe. Control arrives at clock 31.

[State -2, p2 low life]
type = LifeSet
trigger1 = TeamSide = 2 && var(58) = 40
value = 1

[State -2, p1 walk in]
type = VelSet
triggerall = TeamSide = 1 && stateno = 0
triggerall = var(58) = [50, 300]
trigger1 = p2bodydist x > 10
x = const(velocity.walk.fwd.x)

[State -2, p1 sweep]
type = ChangeState
triggerall = TeamSide = 1 && stateno = 0 && ctrl
trigger1 = var(58) > 50 && p2bodydist x <= 10
value = 440
