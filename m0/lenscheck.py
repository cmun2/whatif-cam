#!/usr/bin/env python3
"""Measure this lens's residual radial distortion from the photos themselves.

The tabletop's four edges are physically straight, so every photo supplies four straight
lines. Under a pinhole camera their images are straight; under barrel distortion they bow.
Fit ONE radial coefficient (optionally two) that makes all of them straightest, and report
the bow before and after. If the fitted k1 is ~0 and the residual bow is sub-pixel, the
pinhole model that m0/planefit.py assumes is already valid for these files -- which is what
you would expect if the phone's ISP corrects the ultra-wide before writing the JPEG -- and
no undistortion step is warranted.

   .venv/bin/python m0/lenscheck.py photos/
"""
import glob, json, math, os, sys
import numpy as np
from PIL import Image, ImageOps
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import autoquad as AQ
import region as RG


def undistort(p, cx, cy, f, k1, k2=0.0):
    x = (p[:, 0] - cx) / f; y = (p[:, 1] - cy) / f
    r2 = x * x + y * y
    s = 1 + k1 * r2 + k2 * r2 * r2
    return np.stack([x * s * f + cx, y * s * f + cy], 1)


def straightness(pts_list, cx, cy, f, k1, k2=0.0):
    """Sum of squared perpendicular residuals of every edge, after undistortion."""
    tot, n = 0.0, 0
    for p in pts_list:
        u = undistort(p, cx, cy, f, k1, k2)
        c = u.mean(0)
        _, s, _ = np.linalg.svd(u - c, compute_uv=True)
        tot += s[1] ** 2                       # smallest singular value^2 = sum sq resid
        n += len(p)
    return tot, n


def main():
    photos = sys.argv[1] if len(sys.argv) > 1 else "photos/"
    files = sorted(f for f in glob.glob(os.path.join(photos, "*")) if f.lower().endswith((".jpg", ".jpeg")))
    edges, meta = [], []
    for f in files:
        im = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
        FW, FH = im.size
        s1 = 1024 / max(FW, FH)
        m = AQ.sam_tabletop(im.resize((round(FW * s1), round(FH * s1)), Image.BICUBIC), RG)
        sq = AQ.seed_quad(m)
        if m is None or sq is None:
            continue
        gray = np.asarray(im.convert("L"), np.float64)
        q, info = AQ.fit_quad(gray, sq / s1)
        if q is None:
            continue
        c = q.mean(0)
        for i in range(4):
            a, b = q[i], q[(i + 1) % 4]
            mid = (a + b) / 2
            inw = c - mid; inw = inw / np.linalg.norm(inw)
            l, p, st = AQ.refine_edge(gray, a, b, inw)
            if p is not None:
                edges.append(p); meta.append((os.path.basename(f), i, st["bow_px"], st["span_px"]))
    W, H = FW, FH
    cx, cy = W / 2, H / 2
    f_px = (W / 2) / math.tan(math.radians(104.2500326978036) / 2)
    print(f"{len(edges)} straight physical edges from {len(files)} photos, "
          f"{sum(len(e) for e in edges)} sub-pixel points, f={f_px:.0f} px\n")

    base, n = straightness(edges, cx, cy, f_px, 0.0)
    print(f"{'k1':>10}{'rms resid (px)':>18}{'vs pinhole':>14}")
    grid = np.linspace(-0.30, 0.30, 1201)
    vals = [straightness(edges, cx, cy, f_px, k)[0] for k in grid]
    best = grid[int(np.argmin(vals))]
    for k in (-0.20, -0.10, -0.05, 0.0, best, 0.05, 0.10, 0.20):
        t, _ = straightness(edges, cx, cy, f_px, k)
        tag = "  <- best fit" if abs(k - best) < 1e-9 else ""
        print(f"{k:>10.4f}{math.sqrt(t / n):>18.3f}{math.sqrt(t / base):>14.2f}x{tag}")

    # radial coverage: how far out do these lines actually probe?
    rr = np.concatenate([np.hypot((e[:, 0] - cx) / f_px, (e[:, 1] - cy) / f_px) for e in edges])
    print(f"\nradial coverage of the fitted lines: r_norm {rr.min():.2f}-{rr.max():.2f} "
          f"(frame corner is {math.hypot(cx, cy) / f_px:.2f})")
    print(f"per-edge bow (sagitta) at k1=0: median {np.median([m[2] for m in meta]):.2f} px, "
          f"max {max(m[2] for m in meta):.2f} px over spans of "
          f"{int(min(m[3] for m in meta))}-{int(max(m[3] for m in meta))} px")
    json.dump(dict(best_k1=float(best), rms_pinhole_px=math.sqrt(base / n),
                   rms_bestk1_px=math.sqrt(min(vals) / n), n_edges=len(edges),
                   bow_px=[m[2] for m in meta]),
              open("m0-work/lenscheck.json", "w"), indent=1)


main()
