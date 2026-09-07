# WhatIf Cam — Roadmap

## The scope verdict

**The project is real — the core premise measured out well (22× better than naive 2D, and the
perception bar is met by a 26 MB model). But the proposed plan is over-scoped, and v0.1 itself is
too big.** The cuts below are the deliverable of this round.

The over-scoping is concentrated in two places:

1. **The PhysMind framing imports a research programme we cannot execute.** PhysMind needs a CUDA
   workstation, gated SAM 3 weights, Blender, and a paid frontier VLM, and reaches ~60% on
   Physion++. Chasing it means chasing a target that is both out of budget and *not accurate enough
   to build a confident product on*. Keep the philosophy (explicit executable world between
   perception and reasoning); drop the pipeline.
2. **v0.1 as written contains four independently hard subsystems** — object detection, depth,
   webcam hand-tracking gesture input, and physics — and hand tracking in particular buys zero
   physics accuracy while adding MediaPipe plus a hand-to-table calibration problem.

---

## v0.0 — "Ghost Ball" (the honest smallest version)

**Falsifiable hypothesis:** *from a single still frame of a static tabletop, a monocular relative-depth
model recovers the support plane accurately enough that a predicted roll, overlaid on the image,
lands within a few centimetres of where the object actually goes over a 1–2 s horizon — and
visibly beats screen-space extrapolation.*

Already ~80% de-risked by `probe/`. What remains is the live loop.

Scope — deliberately one screen and one gesture:
- static webcam, static table, **one** ball
- one-shot: depth → back-project → RANSAC plane fit (measured 0.5–1.3° on real imagery)
- tap object → SlimSAM mask → contact point + radius (19 ms/tap)
- **mouse/touch drag** to set initial velocity — *not* hand tracking
- fixed-step 2.5D roll with friction → ghost polyline + uncertainty band + predicted stop point
- everything labelled "Predicted simulation", band widens with real sampled uncertainty

Done when: the ghost path is drawn and the real ball, when actually pushed, ends up inside the band
on ≥ 7 of 10 trials on one real table. That is the whole milestone.

**Explicitly cut from the proposed v0.1:** hand tracking, object *detection* (tap-to-segment replaces
it), multi-object scenes, "simple plane detection" as a separate feature (depth gives it), cups.

## v0.1 — Collision
Add a second object (the cup) and circle–circle collision + restitution; predicted time-to-contact
with an honest error bar. Add `remove(id)` and `scaleVelocity(id, k)` as **two buttons**.
That ships both marquee counterfactuals with zero AI.

## v0.2 — Fit the physics
Estimate friction and restitution from observed motion instead of hard-coding them; report the fit
residual as part of the confidence. This is the first point where the prediction becomes
*scene-specific* rather than generic.

## v0.3 — Robustness, not features
Low-texture tables (the biggest measured unknown), camera-motion detection and re-acquisition,
tracker failure handling, non-spherical objects. No new capabilities — this is what makes the demo
survive contact with other people's kitchens.

## v0.4 — Natural language (only now)
A local or user-supplied model maps English to the closed op set
`{remove, setVelocity, scaleVelocity, move}`. Strictly additive; the core keeps working without it.

## Not on the roadmap yet
3D scene reconstruction / meshes · 6D pose tracking · Gaussian splatting · deformables · moving
camera / SLAM · recorded-video upload · multi-object collision networks · any VLM in the critical
path · CLEVRER or Physion++ evaluation (we cannot run the baselines, so the comparison would be
meaningless).

---

## The one genuinely unsolved step

Compute is not the constraint. PhysGen's rigid-body sim runs in ~3 s *without a GPU*; Video2Game
hits 102 fps in Chrome. Once perception is done, simulation and rendering are nearly free. The step
with no prior art to copy is: **a noisy single-view depth map → collision geometry that behaves
sensibly and stays in register when composited back over the real pixels.** That is where this
project succeeds or fails, and it is why v0.0 is scoped to a single plane and a single sphere — the
smallest version of exactly that step.

## Risks, worst first

1. **Low-texture tables.** Everything measured used a *textured* surface (checkerboard, pool felt).
   A plain white desk is the known weak case for monocular depth and is the actual v0.1 target.
   **Still unmeasured on plain tables — the harness is `m0/`, it needs ten phone photos.**
   Ground-truth evidence gathered while building it (8 NYU frames, mostly plain indoor
   surfaces) puts the true orientation error at a median 4.8°, so treat "depth carries the
   plane" as unproven rather than likely.
2. **Browser inference is unmeasured.** All timings are native ONNX Runtime. WASM is typically
   slower. If the one-shot depth pass costs 3 s in-browser it is still acceptable (it is one-shot),
   but this must be checked, not assumed.
3. **Contact point vs centroid.** Unprojecting an object's mask *centroid* onto the plane is biased
   by roughly the object's radius. The mask's lower edge is the right anchor; getting this wrong is
   a systematic error that no amount of good depth fixes.
4. **Velocity estimation dominates the error budget.** Even with a *perfect* plane, 1 px of tracking
   noise over a 0.3 s window produced 41 mm error at 1 s and 82 mm at 2 s. Longer observation
   windows and sub-pixel tracking matter more than a better depth model.
5. **Camera motion silently invalidates the plane.** Needs active detection, not a disclaimer.
6. **Physics parameters are genuinely unknown** until v0.2, so time-to-collision is the weakest
   claim in the UI. It should be the most heavily hedged number on screen.
7. **In-app browsers silently deny the camera.** Instagram / Facebook / LINE webviews are
   `WKWebView`; if the host app has not implemented the media-capture permission delegate,
   `getUserMedia` fails with no useful error. Since the distribution plan is social sharing, ship an
   "open in Safari" escape hatch from day one.
8. **The commercial precedent is discouraging.** 8th Wall — better SLAM, real customers, Niantic's
   capital — could not sustain a paid WebAR business and wound down in Feb 2026. Evidence that
   technical novelty in browser AR does not convert to revenue. Argues for treating the *experience*
   and its shareability as the product, not positioning as AR infrastructure.
9. **Over-claiming.** The honest description is "a tabletop what-if sandbox", not "executable world
   models from video". The README must not imply the PhysMind result.

## First implementation milestone

**Before any application code:** run the existing depth model on ~10 photos of *real, plain,
untextured* tables and see whether the recovered plane is good enough. If it is under ~5°,
build v0.0. If it blows past 10° on plain surfaces, the fix is a manual 4-tap plane (the
scale-invariance result means a tapped rectangle is enough) and depth becomes optional — a
smaller, still-honest product.

This is one afternoon and it decides the shape of everything after it.

**Built: [`m0/`](m0/). One command — `./m0/run.sh photos/` — plus a shooting protocol in
[`m0/README.md`](m0/README.md).**

One change of substance from the plan above. The milestone as written gates on the near/far
half-split disagreement, and that number turns out not to be able to answer the question: it
detects whether the back-projected surface is *bent*, and is provably blind to a global
additive offset on the model's disparity output, which *rotates* the plane. On the synthetic
scene of `RESEARCH.md` §3.4 the near/far metric reads 0.31° while the plane is 13.5° wrong.
So the harness still reports near/far — bend is worth knowing — but gates on the angle between
the depth-derived plane and the plane implied by the owner's four taps, which is the only
orientation-*accuracy* number a photograph yields without ground truth. Full argument and proof:
`m0/README.md` §5, reproducible with `./m0/run.sh --selftest`.

The same round produced a ground-truth result that belongs in risk #1 below: on 8 NYU frames
with Kinect depth, DAv2-Small's true plane-orientation error on plain horizontal surfaces is a
median **4.8°** — at the edge of the budget, not inside it — while a 4-tap plane with 2 px of
tap error is **1.0°** on the same images. The fallback is currently the more accurate method.
That does not settle the verdict (NYU is not a phone camera pointed at the owner's table), but
it moves the prior.
