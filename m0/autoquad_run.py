#!/usr/bin/env python3
"""Detect the tabletop quad in every photo of a directory and write m0 sidecars.

   .venv/bin/python m0/autoquad_run.py photos/ [--dry]

Writes photos/<stem>.json with "quad" in full-resolution coordinates of the upright
image, plus m0-work/quad_<stem>.png -- a check image to LOOK AT before believing
anything downstream. Photos whose edges cannot be fitted are listed as EXCLUDED.
"""
import argparse, glob, json, os, sys
import numpy as np
from PIL import Image, ImageOps, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import autoquad as AQ
import region as RG

ap = argparse.ArgumentParser()
ap.add_argument("photos")
ap.add_argument("--sam", type=int, default=1024, help="resolution for the coarse SAM mask")
ap.add_argument("--refine", type=int, default=4032, help="resolution for sub-pixel edges")
ap.add_argument("--dry", action="store_true")
a = ap.parse_args()

files = sorted(f for f in glob.glob(os.path.join(a.photos, "*"))
               if f.lower().endswith((".jpg", ".jpeg", ".png")))
outdir = os.path.join(os.path.dirname(os.path.abspath(a.photos.rstrip("/"))), "m0-work")
os.makedirs(outdir, exist_ok=True)

print(f"{'image':<12}{'corners':>9}{'minSupport':>12}{'edgeRMS':>9}{'maxBow':>9}{'outside':>9}   edge bow px (far,right,near,left)")
report = []
for f in files:
    stem = os.path.splitext(os.path.basename(f))[0]
    im = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
    FW, FH = im.size

    s1 = a.sam / max(FW, FH)
    small = im.resize((round(FW * s1), round(FH * s1)), Image.BICUBIC)
    m = AQ.sam_tabletop(small, RG)
    if m is None:
        print(f"{stem:<12}  EXCLUDED: SAM found no tabletop"); report.append(dict(image=stem, ok=False, reason="no SAM mask")); continue
    sq = AQ.seed_quad(m)
    if sq is None:
        print(f"{stem:<12}  EXCLUDED: no seed quad"); report.append(dict(image=stem, ok=False, reason="no seed quad")); continue

    s2 = min(1.0, a.refine / max(FW, FH))
    big = im if s2 >= 1.0 else im.resize((round(FW * s2), round(FH * s2)), Image.BICUBIC)
    gray = np.asarray(big.convert("L"), np.float64)
    q, info = AQ.fit_quad(gray, sq * (s2 / s1))
    if q is None:
        print(f"{stem:<12}  EXCLUDED: {info['reason']}"); report.append(dict(image=stem, ok=False, reason=info["reason"])); continue

    qf = q / s2
    bows = [round(e["bow_px"], 1) for e in info["edges"]]
    print(f"{stem:<12}{4:>9}{info['min_support']:>12}{info['max_rms_px']:>9.2f}"
          f"{info['max_bow_px']:>9.1f}{sum(info['corners_outside_frame']):>9}   {bows}")
    report.append(dict(image=stem, ok=True,
                       quad=[[round(float(x), 1), round(float(y), 1)] for x, y in qf],
                       edge_rms_px=[round(e["rms_px"], 3) for e in info["edges"]],
                       edge_bow_px=[round(e["bow_px"], 2) for e in info["edges"]],
                       edge_span_px=[round(e["span_px"], 0) for e in info["edges"]],
                       edge_support=[e["n"] for e in info["edges"]],
                       edge_tried=[e["n_tried"] for e in info["edges"]],
                       corners_outside_frame=info["corners_outside_frame"],
                       full_size=[FW, FH]))

    # check image
    prev = im.copy(); prev.thumbnail((1100, 1100))
    ps = prev.size[0] / FW
    d = ImageDraw.Draw(prev)
    pts = [tuple(p * ps) for p in qf]
    d.line(pts + [pts[0]], fill=(60, 255, 60), width=3)
    for i, p in enumerate(pts):
        d.ellipse([p[0]-8, p[1]-8, p[0]+8, p[1]+8], outline=(255, 255, 0), width=3)
        d.text((p[0]+11, p[1]+5), "TL TR BR BL".split()[i], fill=(255, 255, 0))
    prev.save(os.path.join(outdir, f"quad_{stem}.png"))

    if not a.dry:
        json.dump({"quad": [[float(x), float(y)] for x, y in qf],
                   "note": "quad AUTO-DETECTED by m0/autoquad.py (SlimSAM mask -> sub-pixel edge "
                           "line fit -> corner intersection). Not a human tap. Ultra-wide 0.5x "
                           "lens: EXIF FocalLengthIn35mmFilm = 14 mm, HFOV 104.3 deg."},
                  open(os.path.join(a.photos, stem + ".json"), "w"), indent=1)

json.dump(report, open(os.path.join(outdir, "autoquad_report.json"), "w"), indent=1)
n = sum(1 for r in report if r["ok"])
print(f"\n{n}/{len(files)} quads fitted.  check images: {outdir}/quad_*.png")
