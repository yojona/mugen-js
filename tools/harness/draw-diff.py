# Debug helper: per-clock count of RNG draws between P1's var(10) samples.
import sys
M=2147483647;A=16807
def draws(fn):
    rows=[]
    for l in open(fn):
        if not l.startswith('S|'): continue
        p=l.split('|')
        if p[2]!='1': continue
        v=p[3].split(',')
        c=int(v[58])
        if c>=1 and (not rows or rows[-1][0]!=c): rows.append((c,int(v[10])))
    s=int(sys.argv[3]); out=[]
    for c,r in rows:
        for k in range(1,80):
            s2=s
            for _ in range(k): s2=s2*A%M
            if s2%1000==r: break
        out.append((c,k-1)); s=s2
    return out
m=draws(sys.argv[1]); o=draws(sys.argv[2])
for (c,a),(_,b) in zip(m,o):
    if a!=b: print('first draw diff clock',c,'mugen',a,'ours',b); break
