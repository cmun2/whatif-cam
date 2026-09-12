# WhatIf Cam

*Point a camera at the world. Change something. See what happens next.*

Tap an object on a tabletop, flick a direction, and see a **ghost** of where it would go —
overlaid on the live camera, with an honest uncertainty band.

**Status: the M0 gate passed at 1.9°, and v0.0 is built.**

```bash
./app/run.sh          # the app, in a browser. No build step.
./app/run.sh --test   # the headless suite: geometry, physics, band, refusals, tracker
```

It opens on one of the owner's own M0 photos, fits the table's plane from a single depth
pass, drops a ball on it and flicks it — so there is something to look at before a camera
is involved. Then: camera, tap a ball, drag to flick.

**The v0.0 milestone is not met yet, and cannot be met without a ball.** The bar is
7 of 10 real rolls inside the band; [`app/MILESTONE.md`](app/MILESTONE.md) is the protocol
for measuring it.

- [`app/README.md`](app/README.md) — what v0.0 does, what it refuses, and why
- [`app/MILESTONE.md`](app/MILESTONE.md) — **the 7-of-10 test**, step by step
- [`RESEARCH.md`](RESEARCH.md) — paper verification + the measured feasibility probe
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — problem → requirements → architecture → technology
- [`ROADMAP.md`](ROADMAP.md) — scope verdict and what was cut
- [`docs/research/landscape.md`](docs/research/landscape.md) — competitive/technical survey
- [`probe/`](probe/) — the feasibility experiments; run them, they are the evidence
- [`m0/`](m0/README.md) — **the gate**: eleven photos of a plain table decided whether v0.0
  got built as designed. `./m0/run.sh photos/` — **verdict: BUILD, at 1.9°**

## What the probe established

- Recovering the ground plane beats naive 2D screen extrapolation by **~22×** at a 1 s horizon.
- ~~Plane orientation from a **26 MB open-weight relative-depth model** is accurate to
  **0.5–1.3°** on a real photo.~~ **Corrected in the M0 round:** that figure measures plane
  *bend*, not orientation, and is blind to the error that dominates. Against ground truth the
  true orientation error is a median **4.8°** — at the edge of the budget. See
  [`m0/README.md`](m0/README.md) §5.
- **Metric depth is not required**: a 2× scale error costs only 219 mm at 2 s.
- Tap-to-select runs at **19 ms per tap**; the neural work is a one-shot setup cost, not per-frame.

## What v0.0 added to that

- The browser ships the **int8** depth model, not the fp32 one the gate was decided on, and
  that is not free: re-measuring the same eleven photos with `dav2s_q.onnx` moves the
  plane-vs-4-tap median from **1.9° to 2.9°**. The app quotes 2.9°.
- Run through the app's own code — whole-frame RANSAC, no tapped quad — those eleven photos
  give a median **2.7°**, max 4.3°, all inside the 5° budget, none refused
  (`tests/plane-real.test.js`).
- In the browser, on WASM with no WebGPU adapter: depth **1.1–1.4 s**, SlimSAM encode
  **2.8 s**, plane fit ~100 ms. Once per scene, as designed.
- **The fitted surface has to be segmented by appearance, not only by geometry.** The
  carpet beside the owner's table is genuinely near-coplanar with it: no inlier threshold
  and no connectivity rule separates them, so the app claimed a surface reaching 188 px past
  the table's edge and predicted the ball rolling onto the floor. Growing the region from
  the middle of the surface and stopping at brightness *steps* removes it — points more than
  20 px off the tabletop go from a median 168 to **zero on all eleven photos**, with the
  plane's own error unchanged.
- **Friction, not perception, dominates the error budget.** With it merely guessed at ±40 %,
  a table three times grippier than assumed still lands inside the 90 % band. Perception
  error is an order of magnitude smaller than that. v0.2 is the fix, and it is more urgent
  than v0.1.

## Honesty rule

A prediction is never presented as the real future. It is labelled as simulation, and the
uncertainty band is sampled from measured perception error — not a decorative label.

## Constraints

No paid APIs, no login, no spending. Open-weight local models only.
