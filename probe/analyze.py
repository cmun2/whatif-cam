"""
The load-bearing experiment.

Q: does a monocular depth model give a plane estimate good enough that the predicted
   trajectory beats (a) a plain plane homography and (b) naive 2D screen extrapolation?

We know the scene analytically, so every error below is measured against exact ground truth.
"""
import os, sys, json
import numpy as np, onnxruntime as ort
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene as S

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out")
rng = np.random.default_rng(7)

gt = np.load(f"{OUT}/gt.npz")
gt_depth, gt_mask, on_table = gt["depth"], gt["mask"], gt["on_table"]
table_only = on_table & (gt_mask == 0)

MEAN = np.array([.485,.456,.406],np.float32); STD = np.array([.229,.224,.225],np.float32)
def run_depth(img, size):
    so=ort.SessionOptions(); so.log_severity_level=3
    s=ort.InferenceSession(os.path.join(HERE,"..","models","dav2s_fp32.onnx"),so,providers=["CPUExecutionProvider"])
    a=(np.asarray(img.convert("RGB").resize((size,size),Image.BICUBIC),np.float32)/255.-MEAN)/STD
    d=np.squeeze(s.run(None,{"pixel_values":a.transpose(2,0,1)[None]})[0])
    return np.asarray(Image.fromarray(d.astype(np.float32)).resize(img.size,Image.BILINEAR),np.float32)

def align_disp(pred, gtd, m):
    """Best-case scale+shift alignment of predicted disparity to GT (uses GT -> generous)."""
    p, q = pred[m].ravel(), 1.0/gtd[m].ravel()
    A = np.stack([p, np.ones_like(p)],1)
    a,b = np.linalg.lstsq(A,q,rcond=None)[0]
    dep = 1.0/np.maximum(a*pred+b, 1e-6)
    return dep, a, b

def fit_plane(depth, m):
    """Least-squares plane through the back-projected table points -> (n, d) with n.X=d."""
    v,u = np.nonzero(m)
    dirs = S.rays(u+.5, v+.5)
    X = dirs*depth[v,u][:,None]
    c = X.mean(0); Y = X-c
    # 3x3 covariance eigen-decomposition (a full SVD on ~250k points would OOM)
    w, V = np.linalg.eigh(Y.T @ Y)
    n = V[:, 0]
    if n@S.N < 0: n = -n
    return n, float(n@c)

def unproject(px, n, d):
    dirs = S.rays(px[:,0], px[:,1])
    t = d/(dirs@n)
    return dirs*t[:,None]

def to_plane_coords(X, n, d):
    """Express 3D points in the ESTIMATED plane's own 2D frame, aligned to the GT frame origin."""
    e1 = np.array([1.,0.,0.]); e1 = e1-(e1@n)*n; e1/=np.linalg.norm(e1)
    e2 = np.cross(n,e1); e2/=np.linalg.norm(e2)
    o = n*d
    return np.stack([(X-o)@e1,(X-o)@e2],-1), (o,e1,e2)

# ---------------------------------------------------------------- depth accuracy
print("="*78); print("1. DEPTH ACCURACY  (Depth Anything V2 Small, synthetic tabletop)"); print("="*78)
img = Image.open(f"{OUT}/scene.png")
depth_at = {}
print(f"{'input':>9} {'AbsRel':>8} {'RMSE(m)':>9} {'d<1.25':>8} | {'plane tilt':>11} {'height err':>11}")
for size in [518, 392, 252, 154]:
    disp = run_depth(img, size)
    dep,_,_ = align_disp(disp, gt_depth, table_only)
    e = np.abs(dep[table_only]-gt_depth[table_only])
    absrel = float((e/gt_depth[table_only]).mean()); rmse=float(np.sqrt((e**2).mean()))
    r = np.maximum(dep[table_only]/gt_depth[table_only], gt_depth[table_only]/dep[table_only])
    d125 = float((r<1.25).mean())
    n,d = fit_plane(dep, table_only)
    tilt = float(np.degrees(np.arccos(np.clip(n@S.N,-1,1)))); herr=abs(abs(d)-S.CAM_H)
    depth_at[size]=(dep,n,d)
    print(f"{size:>6}px {absrel:8.4f} {rmse:9.4f} {d125:8.3f} | {tilt:8.2f}deg {herr*1000:8.1f}mm")

# ---------------------------------------------------------------- trajectory propagation
print(); print("="*78); print("2. TRAJECTORY PREDICTION ERROR"); print("="*78)
traj = S.trajectory(); t_gt, p_gt = S.time_to_cup(traj)
T_OBS, PIX_NOISE, N_TRIAL = 0.25, 1.0, 120

def contact_px(p):     # where the ball touches the table, projected
    return S.project(S.plane_to_cam(p)[0])[0]

obs_t = np.arange(0, T_OBS, 1/30.)
obs_p = np.array([traj[min(int(t*120), len(traj)-1)][1] for t in obs_t])
obs_px_clean = np.array([contact_px(p) for p in obs_p])
cup_px = contact_px(S.CUP_P)
HIT_R = S.CUP_R + S.BALL_R

def predict_on_plane(px, n, d):
    """Unproject observations to the estimated plane, fit p0+v0 with friction, roll out."""
    X = unproject(px, n, d); ab,_ = to_plane_coords(X, n, d)
    A = np.stack([np.ones_like(obs_t), obs_t],1)
    coef = np.linalg.lstsq(A, ab, rcond=None)[0]
    p0, v0 = coef[0], coef[1]
    tj = S.trajectory(p0=p0, v0=v0)
    tc, pc = S.time_to_cup(tj, cup=S.CUP_P)
    pT = tj[min(int(t_gt*120), len(tj)-1)][1]
    return pT, tc

def homography_plane(noise=2.0):
    """H from 4 table fiducials with pixel noise -> equivalent plane, no depth model at all."""
    corners = np.array([[-.42,.40],[.42,.40],[-.50,1.15],[.50,1.15]])
    src = np.array([S.project(S.plane_to_cam(c)[0])[0] for c in corners]) + rng.normal(0,noise,(4,2))
    A=[]
    for (u,v),(X,Y) in zip(src,corners):
        A.append([X,Y,1,0,0,0,-u*X,-u*Y,-u]); A.append([0,0,0,X,Y,1,-v*X,-v*Y,-v])
    H = np.linalg.svd(np.array(A))[2][-1].reshape(3,3); return np.linalg.inv(H)

def predict_homography(px, Hinv):
    q = (Hinv@np.c_[px,np.ones(len(px))].T).T; ab = q[:,:2]/q[:,2:3]
    A = np.stack([np.ones_like(obs_t), obs_t],1)
    coef = np.linalg.lstsq(A, ab, rcond=None)[0]
    tj = S.trajectory(p0=coef[0], v0=coef[1]); tc,_ = S.time_to_cup(tj, cup=S.CUP_P)
    return tj[min(int(t_gt*120),len(tj)-1)][1], tc

def predict_naive2d(px):
    """Constant-velocity + constant-decel fit directly in PIXELS (ignores perspective)."""
    A = np.stack([np.ones_like(obs_t), obs_t, .5*obs_t**2],1)
    c = np.linalg.lstsq(A, px, rcond=None)[0]
    f = lambda t: c[0]+c[1]*t+.5*c[2]*t*t
    pxT = f(t_gt)
    hit_px = np.linalg.norm(S.project(S.plane_to_cam(S.CUP_P+np.array([HIT_R,0]))[0])[0]-cup_px)
    tc=None
    for t in np.arange(0,2.5,1/120.):
        if np.linalg.norm(f(t)-cup_px) <= hit_px: tc=float(t); break
    Xw = unproject(pxT[None], S.N, S.D); ab,_ = to_plane_coords(Xw, S.N, S.D)
    return ab[0], tc

methods = {k: dict(pos=[], t=[], miss=0) for k in
           ["oracle plane (upper bound)","mono-depth plane 518px","mono-depth plane 252px",
            "homography (4 pts, 2px noise)","naive 2D screen extrapolation"]}
_,n518,d518 = depth_at[518]; _,n252,d252 = depth_at[252]

for _ in range(N_TRIAL):
    px = obs_px_clean + rng.normal(0, PIX_NOISE, obs_px_clean.shape)
    for name, fn in [("oracle plane (upper bound)", lambda: predict_on_plane(px,S.N,S.D)),
                     ("mono-depth plane 518px",     lambda: predict_on_plane(px,n518,d518)),
                     ("mono-depth plane 252px",     lambda: predict_on_plane(px,n252,d252)),
                     ("homography (4 pts, 2px noise)", lambda: predict_homography(px, homography_plane())),
                     ("naive 2D screen extrapolation", lambda: predict_naive2d(px))]:
        pT, tc = fn()
        methods[name]["pos"].append(np.linalg.norm(pT-p_gt))
        if tc is None: methods[name]["miss"] += 1
        else: methods[name]["t"].append(abs(tc-t_gt))

print(f"GT: collision at t={t_gt:.3f}s, table pos {p_gt.round(3)}  (ball travels "
      f"{np.linalg.norm(p_gt-S.BALL_P0)*100:.0f}cm; observation window {T_OBS}s, {len(obs_t)} frames @30fps, {PIX_NOISE}px detect noise)")
print(f"\n{'method':<32} {'pos err @collision':>19} {'time-to-coll err':>18} {'missed':>7}")
print("-"*80)
res={}
for k,v in methods.items():
    pe=np.array(v["pos"])*1000; te=np.array(v["t"])*1000
    tstr = f"{np.median(te):6.1f} ms" if len(te) else "   n/a  "
    print(f"{k:<32} {np.median(pe):8.1f} mm (p90 {np.percentile(pe,90):6.1f}) {tstr:>15}   {v['miss']*100//N_TRIAL:3d}%")
    res[k]=dict(pos_med_mm=float(np.median(pe)),pos_p90_mm=float(np.percentile(pe,90)),
                t_med_ms=float(np.median(te)) if len(te) else None, miss_pct=v["miss"]*100/N_TRIAL)
json.dump(dict(trajectory=res, gt_t=float(t_gt)), open(f"{OUT}/analysis.json","w"), indent=2)
print(f"\nplane estimates:  GT n={S.N.round(4)} h={S.CAM_H}")
print(f"  depth 518px  n={n518.round(4)} h={abs(d518):.4f}   tilt={np.degrees(np.arccos(np.clip(n518@S.N,-1,1))):.2f}deg")
print(f"  depth 252px  n={n252.round(4)} h={abs(d252):.4f}   tilt={np.degrees(np.arccos(np.clip(n252@S.N,-1,1))):.2f}deg")
