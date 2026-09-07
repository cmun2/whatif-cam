#!/usr/bin/env python3
"""
M0 gate: does a monocular relative-depth model recover the support plane of a PLAIN,
UNTEXTURED table accurately enough to build v0.0 on?

Run:  ./m0/run.sh photos/           (or:  .venv/bin/python m0/measure.py photos/)

For each photo it reports two different things, and they are NOT interchangeable:

  A. near/far half-plane disagreement -- the metric in ROADMAP.md, computed by the same
     code as probe/real_probe.py. It measures how much the back-projected surface BENDS.
     It is provably blind to a global additive offset in the model's disparity output,
     and such an offset rotates the plane. Verified: on exact synthetic geometry, an
     offset that tilts the plane by 7.6 deg leaves this number at 0.00 deg.

  B. angle between the depth-derived plane and a 4-tap plane from the tapped corners.
     The 4-tap plane comes from the horizon line of the tapped rectangle, so it does not
     depend on depth or on any offset. This is the only orientation-ACCURACY number
     obtainable from a photo without ground truth, and it is what the verdict uses.

The verdict compares the depth model against the fallback, not against perfection: the
4-tap plane's own error bar under a few pixels of tap error is reported next to it.
"""
import argparse, json, os, sys, glob, math
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import planefit as PF
import region as RG

EXT = (".jpg", ".jpeg", ".png", ".heic", ".HEIC", ".JPG", ".JPEG", ".PNG")
DEFAULT_FOV = 65.0
MIN_REGION_PX = 3000


def measure_one(path, photo_dir, args):
    img, scale, exif_fov, full = PF.load_image(path, args.max_side)
    W, H = img.size
    spec = RG.load_sidecar(path, photo_dir)
    fov = (spec or {}).get("fov") or exif_fov or args.fov or DEFAULT_FOV
    fov_src = "sidecar" if (spec or {}).get("fov") else ("exif" if exif_fov else "default")

    mask, quad, how = RG.region_for(img, spec, scale, args.click)
    r = dict(image=os.path.basename(path), full_size=list(full), work_size=[W, H],
             fov_deg=round(float(fov), 2), fov_source=fov_src, region=how)
    if (spec or {}).get("note"):
        r["note"] = spec["note"]
    if mask is None:
        r["status"] = "SKIPPED: no region. Add a sidecar JSON (see m0/README.md)."
        return r, None
    if mask.sum() < MIN_REGION_PX:
        r["status"] = f"SKIPPED: region only {int(mask.sum())} px (need >= {MIN_REGION_PX})."
        r["region_px"] = int(mask.sum())
        return r, None

    disp = PF.run_depth(img, args.size, args.keep_aspect)
    st = PF.plane_stats(disp, fov, mask)
    n_depth = st["normal"]
    r.update(region_px=int(mask.sum()),
             nearfar_deg=round(st["half_tilt_disagreement_deg"], 2),
             leftright_deg=round(st["lr_tilt_disagreement_deg"], 2),
             flatness_pct=round(st["rms_over_extent_pct"], 3),
             depth_normal=[round(float(x), 4) for x in n_depth])
    ci = PF.nearfar_bootstrap(disp, fov, mask)
    if ci:
        r["nearfar_ci90"] = [round(ci[0], 2), round(ci[1], 2)]
    ss = PF.shift_sensitivity(disp, fov, mask)
    if ss:
        r["shift_sensitivity_deg"] = round(ss["deg_per_disp_range"], 2)

    if quad is not None:
        K = PF.K_from_fov(fov, W, H)
        n_quad, cond = PF.normal_from_quad(quad, K)
        if n_quad is not None:
            r["quad_normal"] = [round(float(x), 4) for x in n_quad]
            r["quad_conditioning"] = round(float(cond), 3)
            r["depth_vs_4tap_deg"] = round(PF.angle_between(n_depth, n_quad), 2)
            tn = PF.quad_tap_noise(quad, K, sigma_px=args.tap_sigma * scale)
            if tn:
                r["fourtap_noise_deg"] = round(tn["median_deg"], 2)
                r["fourtap_noise_p90_deg"] = round(tn["p90_deg"], 2)
            bs = PF.best_shift_to_reference(disp, mask, fov, n_quad)
            r["depth_shiftfit_residual_deg"] = round(bs["residual_deg"], 2)
            r["depth_shiftfit_offset"] = round(bs["shift"], 3)
            r["region_disp_range"] = round(bs["disp_range"], 3)
            if cond < 0.15:
                r["warn"] = ("near-fronto-parallel view: the tapped rectangle's vanishing "
                             "points are close to infinity, so the 4-tap plane is "
                             "ill-conditioned here. Shoot this table from a lower angle.")
    r["status"] = "ok"

    if args.overlays:
        od = os.path.join(args.out, "overlays"); os.makedirs(od, exist_ok=True)
        RG.overlay(img, mask, quad, os.path.join(od, os.path.splitext(r["image"])[0] + ".png"))
    return r, dict(mask=mask, disp=disp)


VERDICT_TEXT = {
    "BUILD": """VERDICT: BUILD v0.0 as planned.
  The depth-derived plane agrees with a hand-tapped plane to better than 5 deg on the
  median plain table. ROADMAP.md's error budget calls 2 deg free and 5 deg tolerable, so
  depth can carry the plane and the tap-the-object flow stays as designed.""",
    "AMBIGUOUS": """VERDICT: AMBIGUOUS -- do not commit the architecture yet.
  The median lands between 5 and 10 deg: worse than the budget wants, not bad enough to
  abandon depth. What would settle it, cheapest first:
    1. Shoot 10 more photos and check whether the spread is scene-dependent or uniform.
       If a few bad scenes drag the median, fix those scenes (angle, lighting) and the
       method is fine; if every scene sits at 6-8 deg the method is the problem.
    2. Check how much of the disagreement is the FALLBACK's error, not the model's: if
       fourtap_noise_deg is a large fraction of depth_vs_4tap_deg, tap more carefully
       (zoom in when picking corners) and re-run -- the comparison has a noise floor.
    3. Check shift_sensitivity_deg. If it is large, the error is dominated by the
       unknown global disparity offset, not by depth-map quality. That has a cheap fix
       that is NOT the 4-tap fallback: solve for the one scalar offset using a second
       constraint (e.g. assume the table is horizontal w.r.t. the phone's gravity vector,
       which the browser gives you free via DeviceOrientation). Measure that before
       concluding depth is unusable.
    4. Run the same photos through m0/measure.py --size 392 and --keep-aspect. If the
       answer moves a lot, the number is not stable enough to gate on at all.""",
    "NO_VERDICT": """VERDICT: WITHHELD -- the photos do not contain the evidence needed.
  Only the near/far number could be computed, and that number cannot see a global offset
  on the model's disparity output, which is a first-order source of plane-orientation
  error. A near/far reading of 1 deg is compatible with a plane that is 13 deg wrong (run
  m0/selftest.py to see that demonstrated on exact geometry). Add "quad": four tapped
  corners of the tabletop, to each sidecar and run again -- that is a two-minute job with
  m0/pick.html and it is what turns this from a diagnostic into a decision.""",
    "FALLBACK": """VERDICT: FALL BACK to a manual 4-tap plane. Depth becomes optional.
  Past 10 deg the depth plane is not usable for a 1-2 s prediction: ROADMAP.md's sweep
  puts a 10 deg tilt error at 301 mm of trajectory error at 2 s, which is visibly wrong
  on screen. The product still works: RESEARCH.md 3.4 showed planar rolling is
  scale-invariant, so a tapped quadrilateral (four corners of the table) fully determines
  the plane up to a scale that does not matter. That is a smaller product -- one extra
  interaction, no automatic surface detection -- but it is honest and it removes the
  single largest technical risk. Keep the depth model only for the object's contact point
  and radius, or drop it entirely and use the mask's lower edge.""",
}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("photos", help="directory of photos (or a single image)")
    ap.add_argument("--out", default=None, help="output directory (default <photos>/../m0-out)")
    ap.add_argument("--size", type=int, default=518, help="depth model input size (default 518)")
    ap.add_argument("--max-side", type=int, default=640, help="working resolution (default 640)")
    ap.add_argument("--keep-aspect", action="store_true",
                    help="use the model's own aspect-preserving preprocessing")
    ap.add_argument("--fov", type=float, default=None, help="assumed horizontal FOV if no EXIF")
    ap.add_argument("--click", type=lambda s: [float(x) for x in s.split(",")], default=None,
                    help="X,Y click point applied to every image (single-image use)")
    ap.add_argument("--tap-sigma", type=float, default=2.0,
                    help="assumed tap error in full-res pixels for the 4-tap baseline (default 2)")
    ap.add_argument("--no-overlays", dest="overlays", action="store_false", default=True)
    args = ap.parse_args()

    if os.path.isdir(args.photos):
        photo_dir = args.photos
        files = sorted(f for f in glob.glob(os.path.join(photo_dir, "*")) if f.endswith(EXT))
    else:
        photo_dir = os.path.dirname(os.path.abspath(args.photos)) or "."
        files = [args.photos]
    if args.out is None:
        args.out = os.path.join(os.path.dirname(os.path.abspath(photo_dir.rstrip("/"))), "m0-out")
    os.makedirs(args.out, exist_ok=True)

    if not files:
        raise SystemExit(f"no images in {photo_dir} (looked for {' '.join(EXT[:3])} ...)")

    print(f"\nM0 plane-fit gate  --  {len(files)} image(s) from {photo_dir}")
    print(f"depth: Depth Anything V2 Small fp32, {args.size}px input, CPU\n")
    hdr = (f"{'image':<20}{'region':>8}{'fov':>6}{'near/far':>10}{'ci90':>13}"
           f"{'flat%':>7}{'4tap-vs-depth':>15}{'4tap noise':>12}{'after shift-fit':>17}")
    print(hdr); print("-" * len(hdr))

    rows = []
    for f in files:
        try:
            r, _ = measure_one(f, photo_dir, args)
        except Exception as e:
            r = dict(image=os.path.basename(f), status=f"ERROR {type(e).__name__}: {e}")
        rows.append(r)
        if r.get("status") != "ok":
            print(f"{r['image'][:21]:<22}  {r['status']}")
            continue
        ci = r.get("nearfar_ci90")
        cis = f"[{ci[0]:.1f},{ci[1]:.1f}]" if ci else "-"
        dv = f"{r['depth_vs_4tap_deg']:.1f}d" if "depth_vs_4tap_deg" in r else "no quad"
        tn = f"+-{r['fourtap_noise_deg']:.1f}d" if "fourtap_noise_deg" in r else "-"
        sf = f"{r['depth_shiftfit_residual_deg']:.1f}d" if "depth_shiftfit_residual_deg" in r else "-"
        print(f"{r['image'][:19]:<20}{r['region_px']:>8}{r['fov_deg']:>5.0f}{'*' if r['fov_source']=='exif' else ' '}"
              f"{r['nearfar_deg']:>9.1f}d{cis:>13}{r['flatness_pct']:>6.2f}%{dv:>15}{tn:>12}{sf:>17}")
        if r.get("warn"):
            print(f"{'':<20}  ! {r['warn']}")

    ok = [r for r in rows if r.get("status") == "ok"]
    agg = dict(n_images=len(files), n_measured=len(ok))
    print()
    if not ok:
        print("Nothing measured. Every image needs a region -- see m0/README.md.")
        json.dump(dict(images=rows, aggregate=agg), open(os.path.join(args.out, "m0.json"), "w"), indent=2)
        return

    def med(key):
        v = [r[key] for r in ok if key in r]
        return (float(np.median(v)), len(v), v) if v else (None, 0, [])

    nf, nnf, _ = med("nearfar_deg")
    dv, ndv, dvv = med("depth_vs_4tap_deg")
    tn, _, _ = med("fourtap_noise_deg")
    ss, _, _ = med("shift_sensitivity_deg")
    fl, _, _ = med("flatness_pct")
    sf, _, _ = med("depth_shiftfit_residual_deg")
    agg.update(median_nearfar_deg=nf, n_with_quad=ndv, median_depth_vs_4tap_deg=dv,
               median_fourtap_noise_deg=tn, median_shift_sensitivity_deg=ss,
               median_flatness_pct=fl, median_depth_shiftfit_residual_deg=sf)

    print("AGGREGATE")
    print(f"  images measured                         {len(ok)} / {len(files)}")
    print(f"  median near/far disagreement            {nf:.1f} deg   (bend only -- see below)")
    print(f"  median surface flatness                 {fl:.2f} %")
    if ss is not None:
        print(f"  median shift sensitivity                {ss:.1f} deg per unit of disparity range")
    if ndv:
        print(f"  median depth-plane vs 4-tap plane       {dv:.1f} deg   <-- the verdict metric  (n={ndv})")
        print(f"  median 4-tap noise floor ({args.tap_sigma:.0f} px taps)     {tn:.1f} deg   (the fallback's own error bar)")
        if sf is not None:
            print(f"  median residual after solving the offset {sf:.1f} deg   (best case if the one unknown")
            print(f"                                                    disparity offset were pinned)")
        if dv > 10: v = "FALLBACK"
        elif dv >= 5: v = "AMBIGUOUS"
        else: v = "BUILD"
        agg["verdict_metric"] = "depth_vs_4tap_deg"
        if tn is not None and dv is not None and tn > 0.6 * dv:
            print("\n  NOTE: the fallback's own tap noise is a large share of the disagreement, so the\n"
                  "        depth model may be better than this number. Re-tap corners more precisely\n"
                  "        (or pass --tap-sigma 1) before treating a marginal verdict as final.")
        if v != "BUILD" and sf is not None and sf < 3.0:
            agg["third_path"] = True
            print("\n  THIRD PATH: after solving for one scalar -- the additive offset on the model's\n"
                  "        disparity -- the depth plane lands within %.1f deg of the tapped plane. So the\n"
                  "        depth map's SHAPE is fine over these surfaces and the whole error is that one\n"
                  "        unknown number. Before accepting the 4-tap fallback, price the alternatives\n"
                  "        for pinning it: (a) the phone's gravity vector via DeviceOrientation, which\n"
                  "        for a horizontal table gives the plane normal outright; (b) a metric-depth\n"
                  "        model, which emits true depth and has no offset ambiguity (RESEARCH.md 4\n"
                  "        lists CC0/MIT browser-runnable ones); (c) a second visible plane at a known\n"
                  "        angle. Option (a) is free and is already in the browser." % sf)
    else:
        print(f"  no photo had a tapped quad, so only the near/far number is available.")
        print(f"  THIS NUMBER CANNOT SEE A GLOBAL DISPARITY OFFSET and therefore cannot")
        print(f"  certify orientation accuracy. Add \"quad\" to the sidecars and re-run.")
        v = "FALLBACK" if nf > 10 else "NO_VERDICT"
        agg["verdict_metric"] = "nearfar_deg (insufficient -- shift-blind)"
    agg["verdict"] = v
    print("\n" + "=" * 78)
    print(VERDICT_TEXT[v])
    print("=" * 78)

    print(f"\nwrote {os.path.join(args.out, 'm0.json')}")
    if args.overlays:
        print(f"wrote {os.path.join(args.out, 'overlays')}/  -- LOOK AT THESE. A wrong region")
        print(f"      produces a confident wrong number. Red = measured pixels, green = tapped quad.")
    json.dump(dict(images=rows, aggregate=agg,
                   settings=dict(size=args.size, max_side=args.max_side,
                                 keep_aspect=args.keep_aspect, tap_sigma=args.tap_sigma)),
              open(os.path.join(args.out, "m0.json"), "w"), indent=2)


if __name__ == "__main__":
    main()
