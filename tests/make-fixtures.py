#!/usr/bin/env python3
"""
Export what the JavaScript tests need from the Python side: the depth model's output on
the owner's own photos, plus the 4-tap reference plane M0 measured against.

The app's plane path (whole-frame RANSAC, no tapped quad) can then be checked against the
same reference the M0 gate used, on the same images -- without a webcam and without
running ONNX from Node.

Reads photos/ and m0/ only. Writes only into tests/fixtures/, which is gitignored:
the photos are the owner's and a fixture derived from them does not belong in the repo.

    .venv/bin/python tests/make-fixtures.py
"""
import os, sys, glob, json
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "m0"))
import planefit as PF          # noqa: E402
import region as RG            # noqa: E402

OUT = os.path.join(ROOT, "tests", "fixtures")
MODEL = os.environ.get("WHATIF_DEPTH_MODEL", "dav2s_q.onnx")   # the browser's model


def main():
    os.makedirs(OUT, exist_ok=True)
    photos = sorted(glob.glob(os.path.join(ROOT, "photos", "*.JPG")))
    if not photos:
        print("no photos/ -- nothing to export (this is fine on a fresh clone)")
        return
    index = []
    for p in photos:
        img, scale, exif_fov, full = PF.load_image(p, 640)
        W, H = img.size
        spec = RG.load_sidecar(p, os.path.join(ROOT, "photos"))
        if not spec or "quad" not in spec:
            continue
        fov = spec.get("fov") or exif_fov or 65.0
        quad = np.asarray([[x * scale, y * scale] for x, y in spec["quad"]], float)
        K = PF.K_from_fov(fov, W, H)
        n_quad, cond = PF.normal_from_quad(quad, K)
        disp = PF.run_depth(img, 518, False, model=MODEL)
        stem = os.path.splitext(os.path.basename(p))[0]
        disp.astype(np.float32).tofile(os.path.join(OUT, stem + ".disp.f32"))
        index.append(dict(
            image=os.path.basename(p), stem=stem, w=W, h=H,
            fov_deg=float(fov), fov_source="exif" if exif_fov else "default",
            quad=[[float(a), float(b)] for a, b in quad],
            quad_normal=[float(x) for x in n_quad],
            quad_conditioning=float(cond),
            model=MODEL,
        ))
        print(f"  {stem}  {W}x{H}  fov {fov:.1f}  quad normal {np.round(n_quad,4)}")
    json.dump(index, open(os.path.join(OUT, "index.json"), "w"), indent=1)
    print(f"wrote {len(index)} fixtures to tests/fixtures/ using {MODEL}")


if __name__ == "__main__":
    main()
