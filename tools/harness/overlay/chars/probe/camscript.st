; Camera scenario (no input, exact framestep): P2 slides back into the
; tension zone and to the screen edge, then P1 moves in and pushes P2 until
; the camera reaches the stage bound. Players stay in state 0 (a walk state
; without input is ended by the engine) and are moved with VelSet.
; Control arrives at clock 31.

[State -2, p2 move back]
type = VelSet
triggerall = TeamSide = 2 && stateno = 0
trigger1 = var(58) = [50, 130]
x = const(velocity.walk.back.x)

[State -2, p1 move in]
type = VelSet
triggerall = TeamSide = 1 && stateno = 0
trigger1 = var(58) = [150, 300]
x = const(velocity.walk.fwd.x)
