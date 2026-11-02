; Projectile, helper and Random scenario (no input, exact framestep).
; P1's var(10) holds a Random every tick, var(11) the RNG right after the
; projectile and helper exist (their creation may draw numbers).

[State -2, rng]
type = VarSet
triggerall = TeamSide = 1
trigger1 = 1
var(10) = random

[State -2, projectile]
type = Projectile
triggerall = TeamSide = 1 && ctrl
trigger1 = var(58) = 50
projid = 1
projanim = 200
offset = 40, 0
velocity = 3, 0
attr = S, SP
damage = 40
animtype = Light
guardflag = MA
hitflag = MAF
pausetime = 6, 8
ground.type = High
ground.slidetime = 5
ground.hittime = 10
ground.velocity = -3
sparkno = 2

[State -2, helper]
type = Helper
triggerall = TeamSide = 1
trigger1 = var(58) = 150
helpertype = normal
name = "fx"
id = 5
stateno = 7000
pos = 30, 0
postype = p1
ownpal = 1

[State -2, rng after]
type = VarSet
triggerall = TeamSide = 1
trigger1 = var(58) = 151
var(11) = random
