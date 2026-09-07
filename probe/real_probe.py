"""
Real-image probe. No ground-truth depth needed:
a pool table's felt is flat BY CONSTRUCTION, so the scatter of the back-projected
felt points about their own best-fit plane IS the perception error, and the
disagreement between planes fitted to the near and far halves is a direct,
honest estimate of plane-orientation uncertainty on real imagery.
"""
import os, time, json
import numpy as np, onnxruntime as ort
from PIL import Image
from scipy import ndimage

HERE=os.path.dirname(os.path.abspath(__file__)); OUT=f"{HERE}/out"; M=f"{HERE}/../models"
MEAN=np.array([.485,.456,.406],np.float32); STD=np.array([.229,.224,.225],np.float32)

img=Image.open(f"{OUT}/real_table_640.png").convert("RGB"); W,H=img.size
a=np.asarray(img,np.float32)

# --- red felt mask (colour rule + largest connected component) ---
R,G,B=a[...,0],a[...,1],a[...,2]
m=(R>70)&(R>1.5*G)&(R>1.35*B)
m=ndimage.binary_opening(m,np.ones((5,5)))
lab,n=ndimage.label(m)
# The felt is the WIDEST sizeable red region. Plain "largest area" picks the red
# booth seat at the left edge, which is neither flat nor horizontal.
best,bw=None,0
for i in range(1,n+1):
    c=lab==i
    if c.sum()<3000: continue
    cc=np.nonzero(c.any(0))[0]; w=cc.max()-cc.min()
    r=np.nonzero(c.any(1))[0]
    if w>bw and w>(r.max()-r.min()):   # require a wide, table-like region
        best,bw=i,w
felt=ndimage.binary_erosion(lab==best,np.ones((5,5)))   # drop rail/edge pixels
print(f"felt mask: {felt.sum()} px ({100*felt.mean():.1f}% of image), "
      f"bbox rows {np.nonzero(felt.any(1))[0].min()}-{np.nonzero(felt.any(1))[0].max()}, "
      f"cols {np.nonzero(felt.any(0))[0].min()}-{np.nonzero(felt.any(0))[0].max()}")
Image.fromarray((felt*255).astype(np.uint8)).save(f"{OUT}/real_felt_mask.png")

# --- depth ---
def depth_at(size):
    so=ort.SessionOptions(); so.log_severity_level=3
    s=ort.InferenceSession(f"{M}/dav2s_fp32.onnx",so,providers=["CPUExecutionProvider"])
    x=((np.asarray(img.resize((size,size),Image.BICUBIC),np.float32)/255.-MEAN)/STD).transpose(2,0,1)[None]
    s.run(None,{"pixel_values":x})
    ts=[]
    for _ in range(5):
        t0=time.perf_counter(); o=s.run(None,{"pixel_values":x}); ts.append((time.perf_counter()-t0)*1000)
    d=np.squeeze(o[0])
    return np.asarray(Image.fromarray(d.astype(np.float32)).resize((W,H),Image.BILINEAR),np.float32), float(np.median(ts))

def plane_stats(disp, fov_deg, mask):
    """Back-project inverse-depth -> 3D, fit plane, report flatness + near/far tilt split."""
    fx=fy=(W/2)/np.tan(np.radians(fov_deg)/2); cx,cy=W/2,H/2
    dep=1.0/np.maximum(disp,1e-3)                      # relative depth (scale/shift unknown)
    v,u=np.nonzero(mask)
    X=np.stack([(u-cx)/fx,(v-cy)/fy,np.ones_like(u,float)],-1)*dep[v,u][:,None]
    def fit(P):
        c=P.mean(0); Y=P-c; w,V=np.linalg.eigh(Y.T@Y); nn=V[:,0]
        res=Y@nn
        return nn/np.linalg.norm(nn), c, float(np.sqrt((res**2).mean()))
    n,c,rms=fit(X)
    extent=float(np.linalg.norm(X.max(0)-X.min(0)))
    med=np.median(v); near,far=v>med,v<=med            # image rows: lower = nearer
    n1,_,_=fit(X[near]); n2,_,_=fit(X[far])
    tilt=float(np.degrees(np.arccos(np.clip(abs(n1@n2),-1,1))))
    return dict(rms_over_extent_pct=100*rms/extent, half_tilt_disagreement_deg=tilt)

print("\n--- Depth Anything V2 Small on a REAL pool-hall photo (640x480) ---")
print(f"{'input':>8} {'infer':>10} {'felt flatness':>16} {'near/far plane tilt':>22}")
rows={}
for size in [518,392,252]:
    disp,ms=depth_at(size)
    if size==518: np.save(f"{OUT}/real_disp.npy",disp)
    st=plane_stats(disp,65.0,felt)
    print(f"{size:>5}px {ms:8.0f}ms {st['rms_over_extent_pct']:13.2f}% {st['half_tilt_disagreement_deg']:19.1f} deg")
    rows[size]=dict(infer_ms=ms,**st)

print("\n--- sensitivity to the assumed camera FOV (intrinsics are unknown for a web photo) ---")
disp=np.load(f"{OUT}/real_disp.npy")
for fov in [45,55,65,75,90]:
    st=plane_stats(disp,fov,felt)
    print(f"  FOV {fov:>2}deg -> flatness {st['rms_over_extent_pct']:5.2f}%   near/far tilt {st['half_tilt_disagreement_deg']:5.1f} deg")

# --- SlimSAM timing (promptable segmentation = the 'tap the object' interaction) ---
print("\n--- SlimSAM-77 (int8 ONNX) promptable segmentation ---")
try:
    so=ort.SessionOptions(); so.log_severity_level=3
    enc=ort.InferenceSession(f"{M}/slimsam_enc_q.onnx",so,providers=["CPUExecutionProvider"])
    dec=ort.InferenceSession(f"{M}/slimsam_dec_q.onnx",so,providers=["CPUExecutionProvider"])
    print("  encoder in :",[(i.name,i.shape) for i in enc.get_inputs()])
    print("  decoder in :",[(i.name,i.shape) for i in dec.get_inputs()])
    px=((np.asarray(img.resize((1024,1024),Image.BICUBIC),np.float32)/255.-MEAN)/STD).transpose(2,0,1)[None]
    eo=enc.run(None,{enc.get_inputs()[0].name:px}); emb=eo[0]
    ts=[]
    for _ in range(3):
        t0=time.perf_counter(); enc.run(None,{enc.get_inputs()[0].name:px}); ts.append((time.perf_counter()-t0)*1000)
    print(f"  encoder (once per frame) p50 = {np.median(ts):.0f} ms   emb {emb.shape}")
    feed={}
    for i in dec.get_inputs():
        if 'embed' in i.name and 'point' not in i.name: feed[i.name]=emb
        elif i.name=='input_points': feed[i.name]=np.array([[[[512.,512.]]]],np.float32)
        elif i.name=='input_labels': feed[i.name]=np.array([[[1]]],np.int64)
    if 'image_positional_embeddings' in [i.name for i in dec.get_inputs()] and \
       'image_positional_embeddings' not in feed:
        feed['image_positional_embeddings']=eo[1] if len(eo)>1 else np.zeros_like(emb)
    ts=[]
    for _ in range(20):
        t0=time.perf_counter(); dec.run(None,feed); ts.append((time.perf_counter()-t0)*1000)
    print(f"  decoder (per tap)        p50 = {np.median(ts):.1f} ms")
    rows['slimsam']=dict(enc_ms=float(np.median(ts)))
except Exception as e:
    print(f"  SlimSAM run failed: {type(e).__name__}: {str(e)[:200]}")
json.dump(rows,open(f"{OUT}/real_probe.json","w"),indent=2,default=str)
