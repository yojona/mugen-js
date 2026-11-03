; Projectile origins by postype: one short-lived projectile every 20 ticks,
; P1 standing still (removetime 4, so the list keeps a single one).

[State -2, proj p1]
type = Projectile
triggerall = TeamSide = 1
trigger1 = var(58) = 20
projid = 10
projanim = 200
offset = 30, -40
velocity = 0, 0
postype = p1
projremovetime = 4
projremanim = -1
attr = S, SP
damage = 0
hitflag = MAF
guardflag = MA
pausetime = 0, 0
ground.hittime = 1
sparkno = -1

[State -2, proj p2]
type = Projectile
triggerall = TeamSide = 1
trigger1 = var(58) = 40
projid = 11
projanim = 200
offset = 30, -40
velocity = 0, 0
postype = p2
projremovetime = 4
projremanim = -1
attr = S, SP
damage = 0
hitflag = MAF
guardflag = MA
pausetime = 0, 0
ground.hittime = 1
sparkno = -1

[State -2, proj front]
type = Projectile
triggerall = TeamSide = 1
trigger1 = var(58) = 60
projid = 12
projanim = 200
offset = 30, -40
velocity = 0, 0
postype = front
projremovetime = 4
projremanim = -1
attr = S, SP
damage = 0
hitflag = MAF
guardflag = MA
pausetime = 0, 0
ground.hittime = 1
sparkno = -1

[State -2, proj back]
type = Projectile
triggerall = TeamSide = 1
trigger1 = var(58) = 80
projid = 13
projanim = 200
offset = 30, -40
velocity = 0, 0
postype = back
projremovetime = 4
projremanim = -1
attr = S, SP
damage = 0
hitflag = MAF
guardflag = MA
pausetime = 0, 0
ground.hittime = 1
sparkno = -1

[State -2, proj left]
type = Projectile
triggerall = TeamSide = 1
trigger1 = var(58) = 100
projid = 14
projanim = 200
offset = 30, -40
velocity = 0, 0
postype = left
projremovetime = 4
projremanim = -1
attr = S, SP
damage = 0
hitflag = MAF
guardflag = MA
pausetime = 0, 0
ground.hittime = 1
sparkno = -1

[State -2, proj right]
type = Projectile
triggerall = TeamSide = 1
trigger1 = var(58) = 120
projid = 15
projanim = 200
offset = 30, -40
velocity = 0, 0
postype = right
projremovetime = 4
projremanim = -1
attr = S, SP
damage = 0
hitflag = MAF
guardflag = MA
pausetime = 0, 0
ground.hittime = 1
sparkno = -1
