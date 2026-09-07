"""
Discriminative version: long horizon + sweep of REALISTIC plane error.
Question answered: how accurate must the table-plane estimate be before the
predicted trajectory stops being useful, and does mono-depth clear that bar?
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene as S
HERE=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(HERE,"out")
rng=np.random.default_rng(11)

# Ball rolls mostly AWAY from camera -> maximises perspective foreshortening,
# which is exactly where naive 2D screen extrapolation should break.
P0 = np.array([-0.22, 0.42]); V0 = np.array([0.30, 1.05]); MU = 0.30
GT = S.trajectory(p0=P0, v0=V0, mu=MU, tmax=3.0)
def at(tj,t): return tj[min(int(t*120),len(tj)-1)][1]

T_OBS, FPS, PIX_NOISE, NT = 0.30, 30.0, 1.0, 150
obs_t = np.arange(0,T_OBS,1/FPS)
obs_p = np.array([at(GT,t) for t in obs_t])
obs_px0 = np.array([S.project(S.plane_to_cam(p)[0])[0] for p in obs_p])

def plane_with_error(tilt_deg, h_scale, azim=0.0):
    ax=np.array([np.cos(azim),0,np.sin(azim)]); ax=ax-(ax@S.N)*S.N; ax/=np.linalg.norm(ax)
    a=np.radians(tilt_deg); K=np.array([[0,-ax[2],ax[1]],[ax[2],0,-ax[0]],[-ax[1],ax[0],0]])
    R=np.eye(3)+np.sin(a)*K+(1-np.cos(a))*K@K
    return R@S.N, S.D*h_scale

def frame(n,d):
    e1=np.array([1.,0,0]); e1=e1-(e1@n)*n; e1/=np.linalg.norm(e1)
    e2=np.cross(n,e1); e2/=np.linalg.norm(e2); return n*d,e1,e2

def predict_plane(px,n,d,horizons):
    o,e1,e2=frame(n,d)
    dirs=S.rays(px[:,0],px[:,1]); X=dirs*(d/(dirs@n))[:,None]
    ab=np.stack([(X-o)@e1,(X-o)@e2],-1)
    A=np.stack([np.ones_like(obs_t),obs_t],1); c=np.linalg.lstsq(A,ab,rcond=None)[0]
    tj=S.trajectory(p0=c[0],v0=c[1],mu=MU,tmax=3.0)
    # map estimated-plane coords back through the SAME frame to camera 3D, then to the GT plane,
    # so all methods are compared in one common metric frame
    out=[]
    for T in horizons:
        q=at(tj,T); X3=o+q[0]*e1+q[1]*e2
        p=S.project(X3)[0]
        dd=S.rays(p[None,0],p[None,1]); Xg=dd*(S.D/(dd@S.N))[:,None]
        og,g1,g2=frame(S.N,S.D); out.append(np.array([(Xg[0]-og)@g1,(Xg[0]-og)@g2]))
    return out

def predict_naive2d(px,horizons):
    A=np.stack([np.ones_like(obs_t),obs_t,.5*obs_t**2],1)
    c=np.linalg.lstsq(A,px,rcond=None)[0]
    og,g1,g2=frame(S.N,S.D); out=[]
    for T in horizons:
        p=c[0]+c[1]*T+.5*c[2]*T*T
        dd=S.rays(p[None,0],p[None,1]); Xg=dd*(S.D/(dd@S.N))[:,None]
        out.append(np.array([(Xg[0]-og)@g1,(Xg[0]-og)@g2]))
    return out

HOR=[0.5,1.0,1.5,2.0]
truth=[at(GT,T) for T in HOR]
print("="*92)
print(f"Ball rolls away from camera. obs window {T_OBS}s ({len(obs_t)} frames @{FPS:.0f}fps, {PIX_NOISE}px noise).")
print(f"GT positions: " + "  ".join(f"t={T}s->{np.linalg.norm(truth[i]-P0)*100:.0f}cm" for i,T in enumerate(HOR)))
print("="*92)
print(f"\n{'method':<40}" + "".join(f"{'err@'+str(T)+'s':>13}" for T in HOR))
print("-"*92)

def run(fn,label,store):
    errs=np.zeros((NT,len(HOR)))
    for i in range(NT):
        px=obs_px0+rng.normal(0,PIX_NOISE,obs_px0.shape)
        pr=fn(px)
        for j in range(len(HOR)): errs[i,j]=np.linalg.norm(pr[j]-truth[j])
    med=np.median(errs,0)*1000
    print(f"{label:<40}" + "".join(f"{m:10.0f} mm" for m in med))
    store[label]=[float(x) for x in med]; return med

res={}
run(lambda px: predict_plane(px,S.N,S.D,HOR), "oracle plane (perfect geometry)", res)
run(lambda px: predict_naive2d(px,HOR),        "naive 2D screen extrapolation", res)
print()
mdep=np.array([0.0145,-0.8229,-0.568]); mdep/=np.linalg.norm(mdep)
run(lambda px: predict_plane(px,mdep,-0.4459,HOR), "mono-depth plane (measured, synthetic)", res)
print("\n--- sweep: plane TILT error (height exact) ---")
for tilt in [0.5,1,2,5,10]:
    n,d=plane_with_error(tilt,1.0)
    run(lambda px,n=n,d=d: predict_plane(px,n,d,HOR), f"  tilt {tilt}deg", res)
print("\n--- sweep: plane HEIGHT/SCALE error (orientation exact) ---")
for hs in [1.05,1.20,1.50,2.00]:
    n,d=plane_with_error(0.0,hs)
    run(lambda px,n=n,d=d: predict_plane(px,n,d,HOR), f"  height x{hs:.2f} ({int((hs-1)*100)}% off)", res)
json.dump(dict(horizons=HOR,results=res),open(f"{OUT}/analysis2.json","w"),indent=2)
