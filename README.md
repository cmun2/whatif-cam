# WhatIf Cam

*Point a camera at the world. Change something. See what happens next.*

Tap an object on a tabletop, flick a direction, and see a **ghost** of where it would go —
overlaid on the live camera, with an honest uncertainty band.

**Status: research round complete, no implementation yet.** Start with:

- [`RESEARCH.md`](RESEARCH.md) — paper verification + the measured feasibility probe
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — problem → requirements → architecture → technology
- [`ROADMAP.md`](ROADMAP.md) — scope verdict and what was cut
- [`docs/research/landscape.md`](docs/research/landscape.md) — competitive/technical survey
- [`probe/`](probe/) — the feasibility experiments; run them, they are the evidence

## What the probe established

- Recovering the ground plane beats naive 2D screen extrapolation by **~22×** at a 1 s horizon.
- Plane orientation from a **26 MB open-weight relative-depth model** is accurate to **0.5–1.3°**
  on a real photo — inside the ~5° budget the physics needs.
- **Metric depth is not required**: a 2× scale error costs only 219 mm at 2 s.
- Tap-to-select runs at **19 ms per tap**; the neural work is a one-shot setup cost, not per-frame.

## Honesty rule

A prediction is never presented as the real future. It is labelled as simulation, and the
uncertainty band is sampled from measured perception error — not a decorative label.

## Constraints

No paid APIs, no login, no spending. Open-weight local models only.
