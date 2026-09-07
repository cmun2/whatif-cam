#!/usr/bin/env python3
"""
Ground-truth validation of the M0 pipeline on real indoor photographs.

NYU Depth V2 frames (already in probe/out/nyu/, 15-image subset) carry a per-pixel
ground-truth depth map from a Kinect. That lets us measure the one thing the owner's
own photos cannot give us: the TRUE plane-orientation error of the depth model, rather
than a self-consistency proxy for it.

What this establishes, and what it does not:
  DOES   -- the true error of Depth Anything V2 Small on real, mostly plain, horizontal
            indoor surfaces; whether the near/far proxy predicts that error; and whether
            the 4-tap estimator (which measure.py uses as its reference) is trustworthy
            on real images with a real camera.
  DOES NOT -- settle the plain-table verdict. These are 2011 Kinect-era 640x480 RGB
            frames of offices and classrooms, not modern phone photos of the owner's
            table, and the regions are found by RANSAC on GT depth, so they include
            floors and desktops mixed together.

Regions are chosen automatically: the largest near-horizontal plane in the lower part of
the frame, from GROUND-TRUTH depth. No hand masks, nothing tuned per image.

Run:  ./m0/run.sh --validate
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import planefit as PF
from PIL import Image

NY = os.path.join(PF.ROOT, "probe", "out", "nyu", "nyu_depth_train_float32")
# NYU Depth V2 official colour-camera intrinsics (Silberman et al. 2012 toolbox).
FX, FY, CX, CY = 518.8579, 519.4696, 325.5824, 253.7362
H, W = 480, 640
_u, _v = np.meshgrid(np.arange(W) + .5, np.arange(H) + .5)
RAY_GT = np.stack([(_u - CX) / FX, (_v - CY) / FY, np.ones_like(_u)], -1)
TRUE_FOV = float(np.degrees(2 * np.arctan((W / 2) / FX)))


def upify(n):
    return -n if n[1] > 0 else n


def find_horizontal_plane(gt, seed, thr=0.0008):
    """Largest near-horizontal plane in the lower 60 % of the frame, from GT depth."""
    from scipy import ndimage
    X = (RAY_GT * gt[..., None]).reshape(-1, 3)
    m = np.zeros((H, W), bool); m[int(H * .40):, :] = True; m &= gt > 0.005
    idx = np.nonzero(m.ravel())[0][::5]
    if len(idx) < 100:
        return None
    rng = np.random.default_rng(seed); best = None
    for _ in range(2500):
        P = X[idx[rng.choice(len(idx), 3, replace=False)]]
        n = np.cross(P[1] - P[0], P[2] - P[0]); nn = np.linalg.norm(n)
        if nn < 1e-9:
            continue
        n = upify(n / nn)
        if np.degrees(np.arccos(np.clip(-n[1], -1, 1))) > 40:      # must be roughly horizontal
            continue
        d = n @ P[0]
        c = int((np.abs(X[idx] @ n - d) < thr).sum())
        if best is None or c > best[0]:
            best = (c, n, d)
    if best is None:
        return None
    _, n, d = best
    mk = (np.abs(X @ n - d) < thr).reshape(H, W) & m
    mk = ndimage.binary_opening(mk, np.ones((7, 7)))
    lab, k = ndimage.label(mk)
    if k == 0:
        return None
    sz = ndimage.sum(mk, lab, range(1, k + 1))
    return ndimage.binary_erosion(lab == (1 + int(np.argmax(sz))), np.ones((5, 5)))


def fit_masked(dep, mask, ray=RAY_GT):
    v, u = np.nonzero(mask)
    X = ray[v, u] * dep[v, u][:, None]
    n, d, rms = PF.fit(X)
    return upify(n), X, u, v


def fov_sweep():
    """How much does the assumed focal length move the TRUE orientation error?
    RESEARCH.md 3.3 concluded orientation is robust to the focal length, but that was
    measured with the near/far proxy, which is blind to exactly this. With ground truth
    the picture is different."""
    import h5py
    fovs = [40, 50, 63, 80, 100]
    print(f"\nDepth-plane TRUE tilt error vs assumed FOV (true FOV = {TRUE_FOV:.1f} deg)\n")
    print(f"{'#':>3}" + "".join(f"{'FOV ' + str(f):>10}" for f in fovs) + f"{'swing':>9}")
    swings = []
    for i in range(15):
        hp = os.path.join(NY, "images", f"{i}.h5"); cp = os.path.join(NY, "conditions", f"{i}.png")
        if not (os.path.exists(hp) and os.path.exists(cp)):
            continue
        gt = h5py.File(hp, "r")["depth"][:].astype(np.float64)
        mask = find_horizontal_plane(gt, 100 + i)
        if mask is None or mask.sum() < 3000:
            continue
        n_gt, _, _, _ = fit_masked(gt, mask)
        disp = PF.run_depth(Image.open(cp).convert("RGB"), 518)
        row = [PF.angle_between(PF.plane_stats(disp, f, mask)["normal"], n_gt) for f in fovs]
        swings.append(max(row) - min(row))
        print(f"{i:3d}" + "".join(f"{x:9.2f}d" for x in row) + f"{max(row)-min(row):8.1f}d")
    if swings:
        print(f"\nmedian swing across FOV 40-100 deg: {np.median(swings):.1f} deg, max {max(swings):.1f} deg")
        print("=> the focal length is NOT free for the depth path either. Keep EXIF.")


def main():
    if "--fov-sweep" in sys.argv:
        if not os.path.isdir(NY):
            raise SystemExit(f"NYU subset not found at {NY}")
        return fov_sweep()
    if not os.path.isdir(NY):
        raise SystemExit(f"NYU subset not found at {NY}\n"
                         "It is gitignored. Re-fetch with m0/run.sh --fetch, or skip this check.")
    import h5py
    print(f"\nGT validation on NYU Depth V2 (n<=15). True horizontal FOV = {TRUE_FOV:.1f} deg.")
    print("The harness assumes fx=fy from FOV and the principal point at the image centre;")
    print("this run uses those same assumptions for the model, and exact NYU intrinsics for GT.\n")
    hdr = (f"{'#':>3}{'px':>7}{'GT n/f':>9}{'GT flat':>9} | {'TRUE err':>9}{'near/far':>10}"
           f"{'4tap 2px':>10}{'shift-fixed':>12}")
    print(hdr); print("-" * len(hdr))
    rows = []
    ray_fov = None
    f = (W / 2) / np.tan(np.radians(TRUE_FOV) / 2)
    ray_fov = np.stack([(_u - W / 2) / f, (_v - H / 2) / f, np.ones_like(_u)], -1)
    K = PF.K_from_fov(TRUE_FOV, W, H)
    rng = np.random.default_rng(0)
    for i in range(15):
        hp = os.path.join(NY, "images", f"{i}.h5")
        cp = os.path.join(NY, "conditions", f"{i}.png")
        if not (os.path.exists(hp) and os.path.exists(cp)):
            continue
        gt = h5py.File(hp, "r")["depth"][:].astype(np.float64)
        mask = find_horizontal_plane(gt, 100 + i)
        if mask is None or mask.sum() < 3000:
            print(f"{i:3d}  -- no horizontal plane >= 3000 px")
            continue
        n_gt, Xg, ug, vg = fit_masked(gt, mask)
        med = np.median(vg)
        n1, _, _ = PF.fit(Xg[vg > med]); n2, _, _ = PF.fit(Xg[vg <= med])
        gt_nf = PF.angle_between(n1, n2)
        c = Xg.mean(0); rms = float(np.sqrt((((Xg - c) @ n_gt) ** 2).mean()))
        gt_flat = 100 * rms / float(np.linalg.norm(Xg.max(0) - Xg.min(0)))

        img = Image.open(cp).convert("RGB")
        disp = PF.run_depth(img, 518)
        st = PF.plane_stats(disp, TRUE_FOV, mask)
        n_p = st["normal"]
        true_err = PF.angle_between(n_p, n_gt)

        # oracle disparity offset, solved against GT on this region: the ceiling for any
        # method that pins down the single unknown offset without touching the depth map.
        dm = disp[mask]; A = np.stack([dm, np.ones(len(dm))], 1)
        a_, b_ = np.linalg.lstsq(A, 1.0 / gt[mask], rcond=None)[0]
        if a_ > 0 and (a_ * dm.min() + b_) > 1e-3:
            st2 = PF.plane_stats(disp * a_ + b_, TRUE_FOV, mask)
            shift_err = PF.angle_between(st2["normal"], n_gt)
        else:
            shift_err = float("nan")

        # 4-tap reference, exercised on this real image: four corners of a 3D rectangle
        # lying on the GT plane, projected with the harness's assumed intrinsics, then
        # perturbed by 2 px of tap error.
        e1 = np.array([1., 0, 0]); e1 = e1 - (e1 @ n_gt) * n_gt; e1 /= np.linalg.norm(e1)
        e2 = np.cross(n_gt, e1)
        ctr = Xg.mean(0)
        ex = np.abs((Xg - ctr) @ e1).max() * 0.8
        ey = np.abs((Xg - ctr) @ e2).max() * 0.8
        cor = [ctr - e1 * ex + e2 * ey, ctr + e1 * ex + e2 * ey,
               ctr + e1 * ex - e2 * ey, ctr - e1 * ex - e2 * ey]
        q0 = np.array([(K @ c3)[:2] / (K @ c3)[2] for c3 in cor])
        errs = []
        for _ in range(200):
            nq, _ = PF.normal_from_quad(q0 + rng.normal(0, 2.0, (4, 2)), K)
            if nq is not None:
                errs.append(PF.angle_between(nq, n_gt))
        tap_err = float(np.median(errs)) if errs else float("nan")

        print(f"{i:3d}{int(mask.sum()):7d}{gt_nf:8.1f}d{gt_flat:8.2f}% | {true_err:8.1f}d"
              f"{st['half_tilt_disagreement_deg']:9.1f}d{tap_err:9.1f}d{shift_err:11.1f}d")
        rows.append(dict(i=i, px=int(mask.sum()), gt_nearfar=gt_nf, gt_flat=gt_flat,
                         true_err=true_err, nearfar=st["half_tilt_disagreement_deg"],
                         fourtap_2px=tap_err, shift_fixed=shift_err))

    if not rows:
        print("\nnothing measured.")
        return
    a = lambda k: np.array([r[k] for r in rows], float)
    print()
    print(f"n = {len(rows)} scenes")
    print(f"  median TRUE plane-orientation error of DAv2-small   {np.median(a('true_err')):5.1f} deg")
    print(f"  median near/far proxy                               {np.median(a('nearfar')):5.1f} deg")
    print(f"  median error after fixing the disparity offset (GT) {np.nanmedian(a('shift_fixed')):5.1f} deg")
    print(f"  median 4-tap error, 2 px taps, same images          {np.nanmedian(a('fourtap_2px')):5.1f} deg")
    print(f"  correlation(near/far proxy, TRUE error)             {np.corrcoef(a('nearfar'), a('true_err'))[0,1]:5.2f}")
    print(f"  GT self-check: median near/far ON GT DEPTH          {np.median(a('gt_nearfar')):5.1f} deg")
    print("     (that last line is the metric's noise floor on these regions: Kinect depth")
    print("      noise plus imperfect masks. It is not zero, so small near/far readings on")
    print("      small regions should not be over-read.)")
    out = os.path.join(PF.ROOT, "m0-out"); os.makedirs(out, exist_ok=True)
    json.dump(rows, open(os.path.join(out, "nyu_validation.json"), "w"), indent=2)
    print(f"\nwrote {os.path.join(out, 'nyu_validation.json')}")


if __name__ == "__main__":
    main()
