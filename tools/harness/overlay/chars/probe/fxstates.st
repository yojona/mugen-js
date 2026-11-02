; Helper used by probefx.

[Statedef 7000]
type = S
movetype = A
physics = N
anim = 200
velset = 2, 0
ctrl = 0

[State 7000, hit]
type = HitDef
trigger1 = Time = 0
attr = S, NA
damage = 30
animtype = Medium
guardflag = MA
hitflag = MAF
pausetime = 0, 10
ground.type = High
ground.slidetime = 6
ground.hittime = 12
ground.velocity = -2
sparkno = 1

[State 7000, end]
type = DestroySelf
trigger1 = Time = 80
