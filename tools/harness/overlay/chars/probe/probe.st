; Scripted actions keyed on a tick counter that starts with RoundState 2.
; var(58) = ticks since the fight began. TeamSide picks the script.

[Statedef -2]

[State -2, clock]
type = VarAdd
trigger1 = RoundState = 2
v = 58
value = 1
ignorehitpause = 1

; ---- Player 1: walk, jump, punches, kicks, special, throw attempt ----
[State -2, p1 walk]
type = ChangeState
triggerall = TeamSide = 1 && ctrl
trigger1 = var(58) = 10
value = 20

[State -2, p1 walk speed]
type = VelSet
triggerall = TeamSide = 1 && stateno = 20
trigger1 = var(58) = [10, 50]
x = const(velocity.walk.fwd.x)

[State -2, p1 stop]
type = ChangeState
triggerall = TeamSide = 1 && stateno = 20
trigger1 = var(58) = 51
value = 0
ctrl = 1

[State -2, p1 jump]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = 70
value = 40

[State -2, p1 light punch]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = [150, 160]
value = 200

[State -2, p1 strong punch]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = [220, 230]
value = 210

[State -2, p1 crouch kick]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = [300, 310]
value = 430

[State -2, p1 palm]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = [380, 390]
value = 1000

[State -2, p1 strong kick]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = [600, 610]
value = 240
