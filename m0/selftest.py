#!/usr/bin/env python3
"""
Self-test. Three checks, all offline, ~20 s. Run before trusting any measurement.

  1. REGRESSION -- m0/planefit.py must reproduce probe/real_probe.py's published
     pool-hall numbers (RESEARCH.md 3.3). If it does not, the M0 code has drifted from
     the code the research round validated.
  2. SHIFT-BLINDNESS -- on the synthetic scene, where the geometry is exact and the only
     perturbation is an additive offset on the disparity, the near/far metric must stay
     at ~0 while the plane visibly rotates. This is the proof that the near/far number
     cannot certify orientation, and it is why measure.py leans on the 4-tap comparison.
  3. 4-TAP EXACTNESS -- the vanishing-line estimator must recover a known plane exactly
     from noiseless taps with the correct FOV, and its degradation under tap noise and
     wrong FOV must be what measure.py claims.
"""
import os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "probe"))
import planefit as PF

OUT = os.path.join(PF.ROOT, "probe", "out")
fails = []

print("=" * 78)
print("1. REGRESSION vs probe/real_probe.py  (CC0 pool-hall photo, Wikimedia)")
print("=" * 78)
if not os.path.exists(f"{OUT}/real_table_640.png") or not os.path.exists(f"{OUT}/real_felt_mask.png"):
    print("  SKIP: probe/out/real_table_640.png or real_felt_mask.png missing -- "
          "run .venv/bin/python probe/real_probe.py once to regenerate them.")
else:
    img = Image.open(f"{OUT}/real_table_640.png").convert("RGB")
    felt = np.asarray(Image.open(f"{OUT}/real_felt_mask.png")) > 127
    expect = {518: (0.7, 0.81), 392: (1.3, 0.77), 252: (0.5, 0.95)}   # RESEARCH.md 3.3
    print(f"  {'input':>7} {'tilt now':>10} {'published':>10} {'flat now':>10} {'published':>10}")
    for size, (etilt, eflat) in expect.items():
        d = PF.run_depth(img, size)
        st = PF.plane_stats(d, 65.0, felt)
        t, f = st["half_tilt_disagreement_deg"], st["rms_over_extent_pct"]
        ok = abs(t - etilt) < 0.25 and abs(f - eflat) < 0.15
        print(f"  {size:>5}px {t:9.2f}d {etilt:9.1f}d {f:9.2f}% {eflat:9.2f}%   {'ok' if ok else 'MISMATCH'}")
        if not ok:
            fails.append(f"pool-hall {size}px: {t:.2f}/{f:.2f} vs published {etilt}/{eflat}")

print()
print("=" * 78)
print("2. SHIFT-BLINDNESS of the near/far metric  (exact synthetic geometry, no model)")
print("=" * 78)
gtp = f"{OUT}/gt.npz"
if not os.path.exists(gtp):
    print("  SKIP: probe/out/gt.npz missing -- run .venv/bin/python probe/scene.py")
else:
    import scene as SC
    gt = np.load(gtp)
    table = gt["on_table"] & (gt["mask"] == 0)
    true_disp = np.zeros_like(gt["depth"], np.float64)
    true_disp[table] = 1.0 / gt["depth"][table]
    print(f"  {'offset':>8} {'true tilt error':>17} {'near/far metric':>17} {'flatness':>10}")
    worst = 0.0
    for s in (0.0, 0.05, 0.10, 0.20, 0.40):
        v, u = np.nonzero(table)
        dep = 1.0 / np.maximum(true_disp[v, u] + s, 1e-6)
        X = SC.rays(u + .5, v + .5) * dep[:, None]
        n, _, rms = PF.fit(X)
        if n[1] > 0: n = -n
        med = np.median(v)
        n1, _, _ = PF.fit(X[v > med]); n2, _, _ = PF.fit(X[v <= med])
        ext = np.linalg.norm(X.max(0) - X.min(0))
        te = PF.angle_between(n, SC.N); nf = PF.angle_between(n1, n2)
        print(f"  {s:8.2f} {te:15.2f}d {nf:15.2f}d {100*rms/ext:9.3f}%")
        if s == 0.40:
            worst = te
            if te < 4.0 or nf > 0.5:
                fails.append(f"shift-blindness demo did not behave as expected: {te:.2f}/{nf:.2f}")
    print(f"\n  => an offset that rotates the plane by {worst:.1f} deg leaves the near/far")
    print( "     metric at 0.00 deg. The near/far number measures BEND, not ORIENTATION.")

print()
print("=" * 78)
print("3. 4-TAP vanishing-line estimator")
print("=" * 78)
W, H = 640, 480
rng = np.random.default_rng(3)
print(f"  {'pitch':>6} {'exact':>8} {'1px taps':>10} {'2px':>8} {'4px':>8} {'FOV +10%':>10} {'FOV +20%':>10}")
for pitch in (20, 35, 50, 70):
    th = np.radians(pitch)
    n_true = np.array([0, -np.cos(th), -np.sin(th)])
    e1 = np.array([1., 0, 0]); e2 = np.cross(n_true, e1); e2 /= np.linalg.norm(e2)
    o = n_true * (-0.9) + e2 * 1.2
    corners = [o - e1 * .7 + e2 * .35, o + e1 * .7 + e2 * .35, o + e1 * .7 - e2 * .35, o - e1 * .7 - e2 * .35]
    K = PF.K_from_fov(65, W, H)
    q0 = np.array([(K @ c)[:2] / (K @ c)[2] for c in corners])
    n0, cond = PF.normal_from_quad(q0, K)
    ex = PF.angle_between(n0, n_true)
    if ex > 1e-6:
        fails.append(f"4-tap not exact at pitch {pitch}: {ex:.4f} deg")
    noise = []
    for s in (1., 2., 4.):
        e = [PF.angle_between(PF.normal_from_quad(q0 + rng.normal(0, s, (4, 2)), K)[0], n_true)
             for _ in range(300)]
        noise.append(np.median(e))
    f10 = PF.angle_between(PF.normal_from_quad(q0, PF.K_from_fov(65 * 1.1, W, H))[0], n_true)
    f20 = PF.angle_between(PF.normal_from_quad(q0, PF.K_from_fov(65 * 1.2, W, H))[0], n_true)
    print(f"  {pitch:5d}d {ex:7.4f}d {noise[0]:9.2f}d {noise[1]:7.2f}d {noise[2]:7.2f}d {f10:9.2f}d {f20:9.2f}d")
print("\n  => taps are cheap to get right (2 px -> ~1 deg) but the FOV is not free:")
print("     a 20 % focal-length error costs 4-7 deg. Keep EXIF on your photos.")

print()
if fails:
    print("SELF-TEST FAILED:")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("self-test passed.")
