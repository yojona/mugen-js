; Scripted actions keyed on a tick counter that starts with RoundState 2.
; var(58) = ticks since the fight began. TeamSide picks the script.



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

; ---- Contact section: walk up to P2 and hit it --------------------------
[State -2, p1 walk in]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = 660
value = 20

[State -2, p1 walk in speed]
type = VelSet
triggerall = TeamSide = 1 && stateno = 20
trigger1 = var(58) = [660, 715]
x = const(velocity.walk.fwd.x)

[State -2, p1 walk in stop]
type = ChangeState
triggerall = TeamSide = 1 && stateno = 20
trigger1 = var(58) = 716
value = 0
ctrl = 1

[State -2, p1 jab on P2]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = [730, 740]
value = 200

[State -2, p1 strong punch on P2]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = [800, 810]
value = 210

[State -2, p1 crouch kick on P2]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = [870, 880]
value = 430

[State -2, p1 palm on P2]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = [960, 970]
value = 1000

[State -2, p1 sweep on P2]
type = ChangeState
triggerall = TeamSide = 1 && ctrl && statetype = S
trigger1 = var(58) = [1200, 1210]
value = 440

