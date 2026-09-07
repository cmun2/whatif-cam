# WhatIf Cam — Research Findings

Round 1 research + feasibility probe. All numbers below were measured on this machine
(Apple M1 Pro, 16 GB, macOS 26.5, onnxruntime 1.19.2, CPU execution provider) unless
explicitly marked *unmeasured*. Reproduce with `probe/` (see bottom).

---

## 1. The cited paper — VERIFIED, IT IS REAL

**PhysMind: From Video to Executable Worlds for Training-Free Physical Reasoning**
- arXiv:[2608.04575v1](https://arxiv.org/abs/2608.04575), submitted 2026-08-05, cs.CV
- Chen Yang\*, Shenxiang Zeng\*, Haoyang Zhao, Zhouyuan Xu, Youquan He, Haoyu Li,
  Mingyi Deng, Jiansheng Fan, Chen Wang — Tsinghua University; The University of Hong Kong
- Project page: https://physmind.github.io/ · Code: https://github.com/ccyydd/PhysMind
  (released 2026-08-25, 4 stars, **no LICENSE file**)
- 27 pages, 18 figures. No venue yet — arXiv preprint only, not peer-reviewed.

The owner's one-line summary of the philosophy is accurate: PhysMind puts an explicit
executable world between perception and reasoning instead of asking a VLM "what happens next?".

### But the brief mis-states what PhysMind *is*, in four load-bearing ways

Read the actual abstract and repo, not the title:

1. **It is offline batch analysis of a recorded video, not a live camera.** It "constructs one
   reusable, question-agnostic executable world per video", then answers questions against it.
   There is no real-time path anywhere in the design.
2. **It deliberately does NOT step a physics engine.** The abstract: it "fits analytic
   continuous-time dynamics and latent physical parameters *without unrolling a time-stepped
   simulator*." The proposed architecture ("simulation world → physics engine") is the opposite
   of the paper's actual contribution.
3. **It is evaluated only on synthetic rendered benchmarks** — CLEVRER (matte primitives on a
   uniform grey plane, known camera) and Physion++. There is no real-world, real-camera,
   cluttered-table result in the paper. Its perception stack is never tested on the input
   WhatIf Cam proposes to feed it.
4. **It is a heavyweight GPU pipeline that also requires a paid frontier VLM.** From
   `docs/tool_env.md` and `requirements.txt`: Linux x86-64, NVIDIA GPU with CUDA 12, `nvcc`,
   flash-attention, pytorch3d, gsplat, nvdiffrast, kaolin, spconv, custom-built FoundationPose
   CUDA extensions, Blender, plus **gated** SAM 3 / SAM 3D weights, plus `.env` keys for
   OpenAI / OpenRouter / Gemini. It cannot run on this laptop, in a browser, or without spending money.

### And its own headline numbers do not support a confident product

| Benchmark | Direct CoT (Gemini-3-Flash) | PhysMind |
|---|---:|---:|
| CLEVRER, per-question | 34.32 | **72.55** |
| Physion++ (rigid-body contact prediction) | 51.56 | **59.64** |

Physion++ is near-binary; 59.64% is a real gain over 51.56% but it is **not** an accuracy that
justifies drawing a confident future onto a user's camera feed. The state of the art, on
*synthetic* video, with a CUDA pipeline and a frontier VLM, is ~60% on physical prediction.

**Conclusion: cite PhysMind as philosophical motivation. Do not cite it as evidence that the
proposed product works, and do not describe WhatIf Cam as "PhysMind in the browser".**

---

## 2. What genuinely exists in this space (all arXiv IDs verified)

**Intuitive-physics / physical-reasoning benchmarks**
- CLEVRER — arXiv:[1910.01442](https://arxiv.org/abs/1910.01442), Yi et al. 2019
- Physion — arXiv:[2106.08261](https://arxiv.org/abs/2106.08261), Bear et al. 2021
- IntPhys — arXiv:[1803.07616](https://arxiv.org/abs/1803.07616), Riochet et al. 2018;
  IntPhys 2 — arXiv:[2506.09849](https://arxiv.org/abs/2506.09849), Bordes et al. 2025
- ESPRIT — arXiv:[2005.00730](https://arxiv.org/abs/2005.00730), Rajani et al. 2020
- PhysBench — arXiv:[2501.16411](https://arxiv.org/abs/2501.16411), Chow et al. 2025

**Simulator-augmented LLM reasoning**
- Mind's Eye — arXiv:[2210.05359](https://arxiv.org/abs/2210.05359), Liu et al. 2022. The
  original "run a physics engine and feed the result to the LM" result. Direct ancestor of PhysMind.

**Video → simulation / system identification**
- PhysGen — arXiv:[2409.18964](https://arxiv.org/abs/2409.18964), Liu et al. 2024. Single image
  → rigid-body physics → generated video. Closest published analogue of our *pipeline*, but offline.
- PhysDreamer — arXiv:[2404.13026](https://arxiv.org/abs/2404.13026), Zhang et al. 2024
- PhysGaussian — arXiv:[2311.12198](https://arxiv.org/abs/2311.12198), Xie et al. 2023
- PhysTwin — arXiv:[2503.17973](https://arxiv.org/abs/2503.17973), Jiang et al. 2025 (deformables)
- **Video2Game** — arXiv:[2404.09833](https://arxiv.org/abs/2404.09833), Xia et al. 2024.
  "Real-time, Interactive, Realistic and **Browser-Compatible** Environment from a Single Video."
  The nearest neighbour to this project. Note where it stops: hours of *offline* NeRF→mesh
  reconstruction produce an asset that is then interactive in a browser. It is not live camera.

**World models**
- Genie — arXiv:[2402.15391](https://arxiv.org/abs/2402.15391), Bruce et al. 2024
- DreamerV3 ("Mastering Diverse Domains through World Models") —
  arXiv:[2301.04104](https://arxiv.org/abs/2301.04104), Hafner et al. 2023
- (Genie 3 has no arXiv paper — blog/announcement only. Do not cite it as a paper.)

**Perception components we can actually use**
- Depth Anything V2 — arXiv:[2406.09414](https://arxiv.org/abs/2406.09414), Yang et al. 2024
- Video Depth Anything — arXiv:[2501.12375](https://arxiv.org/abs/2501.12375), Chen et al. 2025
- Depth Pro — arXiv:[2410.02073](https://arxiv.org/abs/2410.02073) (metric, ~0.3 s/image, GPU)
- MoGe-2 — arXiv:[2507.02546](https://arxiv.org/abs/2507.02546) (metric geometry; used by PhysMind)
- GeoCalib — arXiv:[2409.06704](https://arxiv.org/abs/2409.06704) (single-image calibration)
- Segment Anything — arXiv:[2304.02643](https://arxiv.org/abs/2304.02643);
  EfficientSAM — arXiv:[2312.00863](https://arxiv.org/abs/2312.00863);
  FastSAM — arXiv:[2306.12156](https://arxiv.org/abs/2306.12156).
  (MobileSAM has no matching arXiv title hit; treat as a repo, not a paper.)

---

## 3. Feasibility probe — measured

### 3.1 What was downloaded

| Artifact | Size | Use |
|---|---:|---|
| `onnx-community/depth-anything-v2-small` `model.onnx` (fp32) | 94 MB | measurement |
| same, `model_quantized.onnx` (int8) | 26 MB | **the shippable one** |
| same, `model_fp16.onnx` | 47 MB | alternative |
| `Xenova/slimsam-77-uniform` encoder (int8) | 8.5 MB | tap-to-select |
| `Xenova/slimsam-77-uniform` decoder (int8) | 4.7 MB | tap-to-select |
| NYU Depth V2 15-image subset (`xcll/...`) | 19 MB | real-image sanity check |

Browser-shippable total: **~39 MB** (int8 depth + int8 SlimSAM). Nothing gated, nothing paid.

### 3.2 Inference speed (M1 Pro, ONNX Runtime CPU EP)

Depth Anything V2 **Small**, dynamic input resolution:

| input | p50 latency | fps |
|---:|---:|---:|
| 518×518 (native) | 455–491 ms | 2.0–2.2 |
| 392×392 | 246–269 ms | 3.7–4.1 |
| 322×322 | 200 ms | 5.0 |
| 252×252 | 94–111 ms | 9.0–10.6 |
| 154×154 | 44 ms | 22.6 |

Two counter-intuitive measured results worth knowing:
- **int8 quantisation is *slower* than fp32 on ARM CPU** here: 612 ms vs 453 ms at 518². Quantise
  to cut *download size*, not latency.
- **CoreML EP is slower than the CPU EP**: 759 ms vs 453 ms (fp32, 518²). Do not assume ANE helps.

SlimSAM-77 (int8), the tap-to-select interaction:

| stage | p50 | note |
|---|---:|---|
| vision encoder, 1024² | **841 ms** | once per scene/frame |
| prompt encoder + mask decoder | **19 ms** | **per tap — 53 taps/sec** |

That split is exactly the right shape: pay ~0.85 s once, then object selection is interactive.

### 3.3 Depth accuracy → plane accuracy

*Synthetic scene* (`probe/scene.py` renders a checkered table + ball + cup with analytic
ground-truth depth, so every error is measured against exact truth). After the standard
scale+shift alignment to GT (which is *generous* — it uses ground truth):

| input | AbsRel | RMSE | plane tilt err | plane height err |
|---:|---:|---:|---:|---:|
| 518px | 0.0029 | 5.1 mm | 0.03° | 0.1 mm |
| 392px | 0.0070 | 12.2 mm | 0.50° | 3.0 mm |
| 252px | 0.0117 | 26.3 mm | 0.91° | 4.1 mm |

**These synthetic numbers are unrealistically good and must not be quoted as the product's
accuracy.** A clean textured plane is the easiest possible input for a DINOv2-based model.

> **CORRECTION (M0 round).** They are worse than "unrealistically good" — the plane-tilt
> column is only reachable *because of* the scale+shift alignment against ground truth
> noted above, which no product has. Repeat the 518px row with `depth = 1/disp` and the
> tilt error is **13.47°**, not 0.03°. A 4-tap plane from the same image recovers the true
> normal to **0.012°**.

*Real photo* — a CC0 pool-hall photograph (Wikimedia `Billiards table.jpg`), oblique view.
No ground-truth depth is needed: pool felt is flat by construction, so the scatter of the
back-projected felt about its own best-fit plane *is* the error, and the tilt disagreement
between planes fitted to the near half and far half is a direct estimate of orientation uncertainty.

| input | infer | felt flatness (RMS / extent) | near-vs-far plane tilt |
|---:|---:|---:|---:|
| 518px | 455 ms | 0.81 % | **0.7°** |
| 392px | 246 ms | 0.77 % | **1.3°** |
| 252px | 94 ms | 0.95 % | **0.5°** |

Sensitivity to the assumed camera FOV (real intrinsics unknown for a web photo):
FOV 45°→0.5°, 55°→0.6°, 65°→0.7°, 75°→0.8°, 90°→0.9° tilt.
~~**Plane orientation is robust to getting the focal length badly wrong — no calibration
step needed.**~~

> **CORRECTION (M0 round).** The three paragraphs above measure the wrong quantity, and
> the FOV conclusion does not survive. Every number here is a *near/far half-split*
> disagreement, which detects whether the back-projected surface is **bent** — and is
> provably blind to a global additive offset on the model's disparity output, which
> **rotates** the plane. DAv2 emits affine-invariant inverse depth (`1/depth = a·disp + b`
> with both unknown); this code assumes `b = 0`.
>
> With the offset wrong by Δ, a plane back-projects to another exact plane with normal
> `n + κΔ·e_z`: both halves still agree, so the metric reads zero while the orientation is
> wrong. On the synthetic scene of §3.4, `depth = 1/disp` puts the plane **13.5° off**
> while this metric reads **0.31°**. With ground truth (`./m0/run.sh --validate`, 8 NYU
> frames), the model's **true** plane-orientation error on plain horizontal surfaces is a
> median **4.8°**, the near/far proxy reads 4.9° but correlates with it at only **0.47**,
> and the true error swings by a median 6.5° (max 13.1°) across an assumed FOV of 40–100°.
>
> The 0.5–1.3° figures below are therefore a *lower bound on bend*, not orientation
> accuracy. See `m0/README.md` §5; reproduce with `./m0/run.sh --selftest`.

### 3.4 The decisive experiment: does the 3D estimate beat naive 2D?

Ball rolls *away* from the camera (maximising perspective foreshortening — the case where
screen-space extrapolation should fail). Observation window 0.30 s (9 frames @30 fps) with 1 px
detection noise; 150 trials; median error of the predicted position, measured on the true table plane.

| method | err @0.5s | @1.0s | @1.5s | @2.0s |
|---|---:|---:|---:|---:|
| **oracle plane** (perfect geometry) | 19 mm | 41 mm | 61 mm | 82 mm |
| **naive 2D screen extrapolation** | 100 mm | **907 mm** | 1665 mm | 2129 mm |
| mono-depth plane (measured, synthetic) | 21 mm | 52 mm | 85 mm | 119 mm |

**The 3D/plane approach beats naive 2D screen-space extrapolation by ~22× at a 1 s horizon.**
This is the single most important result in the probe: the project's core premise is validated.
A "what happens next" overlay genuinely requires recovering the ground plane; it is not a
dressed-up 2D effect.

How accurate must the plane be? Sweep (same setup):

| plane tilt error | @0.5s | @1.0s | @1.5s | @2.0s |
|---:|---:|---:|---:|---:|
| 0.5° | 18 mm | 33 mm | 45 mm | 59 mm |
| 1° | 16 mm | 25 mm | 30 mm | 37 mm |
| 2° | 15 mm | 12 mm | 12 mm | 18 mm |
| 5° | 8 mm | 32 mm | 89 mm | 129 mm |
| 10° | 4 mm | 97 mm | 226 mm | 301 mm |

(Differences under ~50 mm are inside trial noise. Read this as: **≤2° is free, 5° is tolerable,
10° is visibly wrong.**) Measured real-world tilt error is 0.5–1.3° — comfortably inside budget.

| plane height / scale error | @0.5s | @1.0s | @1.5s | @2.0s |
|---:|---:|---:|---:|---:|
| +5 % | 18 mm | 34 mm | 46 mm | 55 mm |
| +20 % | 13 mm | 16 mm | 11 mm | 21 mm |
| +50 % | 6 mm | 12 mm | 54 mm | 121 mm |
| +100 % (2×) | 3 mm | 35 mm | 108 mm | 219 mm |

**Metric scale barely matters.** Getting the camera height wrong by 2× costs 219 mm at a 2 s
horizon. The reason is structural: for an object rolling in a plane, scaling the world scales
positions *and* observed velocities together, so the predicted path is scale-invariant. Scale
enters only through the dynamics constants (friction, gravity) — and those are fitted from
observation anyway, absorbing most of the error.

**Consequence: we do not need metric depth.** Relative-depth models — which is what is small,
open, and browser-runnable — are sufficient. This removes the hardest perception dependency
(MoGe-2 / Depth Pro / metric Video-Depth-Anything, all of which PhysMind needed) from the critical path.

### 3.5 What could NOT be measured

- **No live webcam.** This session is headless; `getUserMedia` cannot be granted. All numbers are
  from a synthetic render and a still photograph. End-to-end live latency, camera jitter, rolling
  shutter, motion blur, and auto-exposure hunting are **unmeasured**.
- **No in-browser numbers.** Everything above is native ONNX Runtime on CPU. Browser WASM is
  typically slower and WebGPU may be faster, but the ratio here is **unmeasured**. Treat the
  browser figures as unknown until run on the owner's machine.
- **Low-texture planes are unmeasured.** The real test surface was a textured pool table. A plain
  white desk is depth models' known weak case and is the actual v0.1 target. **This is the
  biggest open perception risk.** — the harness that settles it is now in `m0/`; it needs
  ten phone photos and one afternoon.
- **Plane ORIENTATION was never measured at all**, only plane *bend*. See the correction in
  §3.3. With ground truth the true error is ~5×larger than the reported proxy, and a manual
  4-tap plane is ~5× more accurate than the depth model on the same real images (1.0° vs
  4.8° median).
- **Only one real scene** was tested (n=1). The 0.5–1.3° figure is an existence proof, not a distribution.
- Object tracking accuracy over time was modelled as 1 px Gaussian noise, not measured from a real tracker.

### 3.6 Reproducing

```bash
cd whatif-cam
python3 -m venv .venv && ./.venv/bin/pip install numpy pillow onnxruntime scipy h5py
./.venv/bin/python probe/scene.py        # render synthetic scene + ground truth
./.venv/bin/python probe/run_depth.py    # depth latency benchmark
./.venv/bin/python probe/analyze.py      # depth accuracy + short-horizon comparison
./.venv/bin/python probe/analyze2.py     # long-horizon + plane-error sweep  <-- the decisive one
./.venv/bin/python probe/real_probe.py   # real photo: planarity + SlimSAM timing
./m0/run.sh --selftest                   # M0 harness vs the numbers above + the shift proof
./m0/run.sh --validate                   # ground-truth plane accuracy on NYU frames
```
Models are expected in `models/` (see 3.1 for URLs).

---

## 4. Landscape summary and the metric-scale question

Full survey in [`docs/research/landscape.md`](docs/research/landscape.md). The four findings that
change decisions:

1. **The intersection we are targeting is genuinely empty.** Targeted GitHub searches for the union
   of monocular depth and browser physics (`depth anything rapier physics`, `webcam depth physics`,
   `real time physics from video browser`, and six more) returned **literal zero results**, against a
   control query returning 1,163. Every layer exists; nobody has composed them.
2. **Every research system in this line is offline.** PhysGaussian, PhysDreamer, PhysTwin, PhysGen,
   Video2Game, PhysSplat — all require per-scene optimization (minutes to hours, on a GPU), and none
   run in a browser. The closest conceptual match, [`tungcorn/latentlaw`](https://github.com/tungcorn/latentlaw)
   (video → fitted hidden parameters → counterfactual), is offline, client/server, limited to three
   hardcoded scene families, and **requires the caller to supply metric scale**.
3. **Browser WebGPU is ~10× faster than our native CPU measurement.**
   [`en970/depth-realtime`](https://github.com/en970/depth-realtime) measures Depth Anything V2 Small
   at **20 fps / 47 ms** (transformers.js, WebGPU, fp16, 350×196) on Apple Silicon. Their README also
   records that q4 weights band visibly *and* run slower than fp16, and that DAv2 emits inverse depth
   where **larger = nearer** (a convention DAv3 reverses). Use fp16 in the browser, not int8/q4.
4. **License traps are real.** Depth Anything V2 **Small is Apache-2.0**, but **Base and Large are
   CC-BY-NC-4.0** — "use a bigger model" is not an available fallback. FastSAM and Ultralytics YOLO
   are AGPL-3.0; UniDepth is CC-BY-NC; Depth Pro is non-OSI `apple-amlr`. The stack we measured
   (DAv2-Small Apache-2.0 + SlimSAM) is clean, partly by luck.

### The metric-scale question, resolved

The survey concludes metric scale is "the one hard problem we must not hand-wave", and catalogues
three browser-runnable metric models (Metric3D-ViT-S 75.8 MB CC0; a community metric DAv2 export;
MoGe-2 ViT-S 140.9 MB MIT) — every one of which still needs a focal-length estimate supplied from
somewhere, and two of which need post-processing reimplemented in JS.

**Our measurement (§3.4) says we can largely decline that problem.** For an object rolling in a
plane, scaling the world scales positions *and* observed velocities together, so the predicted path
is scale-invariant; getting camera height wrong by **2× costs 219 mm at a 2 s horizon**, while a
**10° orientation error costs 301 mm**. Orientation is the quantity that matters, and relative depth
recovers it to 0.5–1.3° on real imagery with no calibration.

So the ranking of difficulty inverts for our scope:

| Quantity | Landscape's assessment | Our measurement | Consequence |
|---|---|---|---|
| Metric scale | the hard blocker | costs little (§3.4) | **avoid — do not adopt a metric model for v0.0/v0.1** |
| Plane orientation | barely discussed | dominates error | **this is the real requirement** |
| Focal length | must be decided early | tilt varies 0.5°→0.9° over FOV 45–90° (§3.3) | **can be defaulted** |

This is the strongest argument for the narrow scope: **the tabletop-rolling case is precisely the
case where the field's hardest open problem does not bind.** Scale re-enters as soon as we add
gravity (an object leaving the table edge) or claim absolute time-to-collision from an unfitted
friction constant — which is why those belong to later versions, behind an uncertainty band.

Worth revisiting later: `onnx-community/metric3d-vit-small` (CC0) additionally emits
`predicted_normal` + `normal_confidence`, i.e. **surface normals for free** — a more direct route to
plane orientation than RANSAC over a back-projected depth map. Attractive for v0.3, not for v0.0.
