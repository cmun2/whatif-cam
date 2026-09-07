# WhatIf Cam — Architecture

Derived in the required order: **Problem → Technical Requirements → Architecture → Technology.**
Every requirement below is traceable to a measured number in `RESEARCH.md`.

---

## 1. Problem

A camera shows you only the present. A person looking at a tabletop can ask "if I nudge that
ball, does it hit the cup?" and get an intuitive answer; a camera cannot answer, and a VLM shown
the frame answers unreliably (PhysMind's own baseline: 34% on CLEVRER, 51.6% on Physion++).

We want: point a camera at a table, tap an object, flick a direction, and see a *ghost* of where
it would go and when it would hit — clearly marked as simulation, not prophecy.

**Non-problem:** we are not trying to beat PhysMind on CLEVRER, and not trying to answer arbitrary
physical questions. That target requires a CUDA workstation and a paid VLM and still lands at ~60%.

---

## 2. Technical requirements

Requirements, with the measurement that sets each threshold:

| # | Requirement | Threshold | Why (measured) |
|---|---|---|---|
| R1 | Recover the support plane's **orientation** | ≤ 5° tilt error, target ≤ 2° | 10° → 301 mm error @2 s; 2° is inside noise (§3.4) |
| R2 | Recover metric **scale** | *not required* | 2× scale error costs only 219 mm @2 s (§3.4) |
| R3 | Plane must not need camera calibration | works for FOV 45–90° | tilt varies only 0.5°→0.9° across that range (§3.3) |
| R4 | Object selection must feel instant | ≤ 50 ms per tap | SlimSAM decoder = 19 ms (§3.2) |
| R5 | Plane/scene acquisition may be slow | ≤ ~1 s, once | depth 94–455 ms, SlimSAM encoder 841 ms (§3.2) |
| R6 | Per-frame loop must hit camera rate | ≥ 30 fps | tracking + physics only; no NN in the loop |
| R7 | Prediction must beat naive 2D | ≥ 5× better | measured 22× @1 s (§3.4) |
| R8 | Never present prediction as fact | always labelled + uncertainty band | SOTA is ~60% on this task (§1) |
| R9 | Zero paid services, zero login | hard constraint | owner constraint |
| R10 | Deterministic core testable with no AI calls | headless unit-testable | required by brief |

**The decisive architectural consequence of R5 + R6:** the neural networks run **once, at scene
setup**, not per frame. Depth is a *calibration* step, not a video stream. This is what makes the
whole project tractable — the 2.2 fps depth number that looks fatal is irrelevant, because we
need depth once.

---

## 3. Architecture

Two strictly separated layers. The boundary is a plain data structure (`WorldState`), not a call.

```
                        ┌──────────── ACQUIRE (once per scene, slow, neural) ────────────┐
  camera frame ──────►  │  monocular depth ──► back-project ──► RANSAC plane fit         │
       │                │  tap ──► SlimSAM mask ──► contact point + object radius        │
       │                └──────────────────────────┬────────────────────────────────────┘
       │                                           ▼
       │                                   ┌───────────────┐
       │                                   │  WorldState   │   plane (n,d) · camera K ·
       │                                   │  (plain data) │   objects[{id,pos2d,radius,v}] ·
       │                                   └───────┬───────┘   params{friction,restitution}
       ▼                                           │
  ┌─────────── PER FRAME (fast, no neural nets) ───┼──────────────────────────────────┐
  │  2D tracker (template/optical flow)  ──► unproject onto plane ──► update pos/vel  │
  │                                                ▼                                  │
  │            ┌─────────────── DETERMINISTIC CORE ─────────────────┐                 │
  │            │  geometry.ts   plane, unproject, homography        │                 │
  │            │  sim.ts        fixed-step 2.5D rigid body          │  ← zero AI      │
  │            │  state.ts      WorldState, counterfactual ops      │    zero I/O     │
  │            │  uncertainty.ts  Monte-Carlo over plane+vel noise  │    pure funcs   │
  │            └───────────────────────┬───────────────────────────┘                 │
  │                                    ▼                                              │
  │            ghost path + collision marker + confidence band ──► canvas overlay      │
  └───────────────────────────────────────────────────────────────────────────────────┘

  ┌──────────── AGENT LAYER (optional, LAST, strictly additive) ─────────────────────┐
  │  natural language ──► a *typed counterfactual op* ──► core.apply(op) ──► rerun    │
  │  ops: remove(id) · setVelocity(id,v) · scaleVelocity(id,k) · move(id,p)           │
  │  The agent may ONLY emit ops from this closed set. It never touches geometry.     │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

### Why the core/AI split is drawn exactly here

The agent's entire job is translating English into one of ~4 enum-typed operations on
`WorldState`. That means:
- the core runs, and is fully testable, with **zero** AI-service calls (brief requirement);
- `probe/analyze2.py` is already a test of that core — it exercises geometry + sim + error
  propagation headlessly;
- the counterfactuals in the pitch ("what if the cup wasn't there?", "what if I push harder?")
  are `remove(id)` and `scaleVelocity(id,k)` — **they need no AI at all**. They are two buttons.
  The NL layer is a convenience skin over buttons that already work.

### Uncertainty is a first-class output, not a label

R8 is not satisfied by printing "Confidence: medium". The core runs the rollout ~32× while
sampling plane tilt (±1.5°, our measured real-world error) and initial velocity (from tracker
residuals), and renders the *spread* as a widening band around the ghost path. When the band is
wide, the UI is honestly wide. Cost is negligible — the sim is a few hundred float ops per step.

---

## 4. Technology, and the runtime/infra decision

### Browser-only. No container, no backend, no GPU requirement.

**The choice was between:** (a) browser-only, (b) browser frontend + containerised CV backend,
(c) native desktop app.

**(b) is rejected on two grounds, one fatal:**
1. *Fatal:* containers break webcam access. On macOS, Docker has no path to the camera device at
   all (no `/dev/video*` passthrough to the Linux VM). The hybrid would force the frontend to
   capture frames and ship them to the backend — adding a round-trip to a step we measured at
   94 ms, for no accuracy gain.
2. It destroys distribution. An OSS demo whose adoption story is "clone, build a CUDA image, run
   compose" gets ~0 users. A URL gets users.

**(a) is affordable because of the once-per-scene insight (R5/R6).** The neural cost is paid at
setup: ~94–455 ms depth + ~841 ms SlimSAM encode. The per-frame loop is 2D tracking plus a
fixed-step rigid-body sim — microseconds. We never need 30 fps neural inference, which is the
requirement that would have killed browser-only.

**GPU:** not required. WebGPU is an *optional accelerator* for the one-shot depth pass; the CPU/WASM
path must remain the supported default. Our own browser numbers are unmeasured, but a third party has
measured this exact model in this exact setting: [`en970/depth-realtime`](https://github.com/en970/depth-realtime)
reports **20 fps / 47 ms** for Depth Anything V2 Small via transformers.js + WebGPU (fp16, 350×196
input) on Apple Silicon — i.e. **~10× faster than the 455 ms we measured natively on the CPU EP.**
The browser is not the bottleneck we feared; if anything WebGPU is the fastest path available to us.

**Webcam constraints:** `getUserMedia` needs a secure context (HTTPS or `localhost`) and, by
convention, a user gesture. v0.1 assumes a **static camera** — any camera motion invalidates the
plane, so the UI must detect large global flow and prompt re-acquisition rather than silently drifting.

**WebXR is not an option, and that is settled, not a judgement call.** WebKit compiles WebXR in only
for `PLATFORM(VISION)` (`Source/WTF/wtf/PlatformEnableCocoa.h`) — on iPhone, iPad and macOS the code
is *absent from the binary*, and even on Vision Pro `WebXRAugmentedRealityModuleEnabled` defaults to
false. caniuse reports `usage_perc_y = 0`. So `immersive-ar`, WebXR plane detection, hit-test, the
Depth Sensing module and raw camera access are all Android-Chrome-only. **`getUserMedia` + our own
canvas overlay is the only design that runs on an iPhone at all.** (8th Wall reached the same
conclusion and built its own CV stack.)

**Distribution risk to design around now:** third-party iOS browsers and in-app webviews
(Instagram, Facebook, LINE) are all `WKWebView`; if the host app does not implement
`WKUIDelegate.requestMediaCapturePermissionFor`, camera access is **silently denied**. Since the
product's distribution story is social sharing, the app needs an explicit "open in Safari" escape
hatch — this is a primary funnel concern, not a footnote.

### Stack

| Layer | Choice | Why |
|---|---|---|
| Depth (once) | **Depth Anything V2 Small, ONNX — fp16 ~50 MB in browser, int8 26 MB** | measured 0.5–1.3° real plane tilt; relative depth suffices (R2). **Apache-2.0** — note V2 *Base/Large are CC-BY-NC-4.0 and disqualified*, so "just use a bigger model" is not available. Prefer fp16 over int8/q4 in-browser: q4 is reported to band and to run *slower* than fp16 |
| Segmentation (once + per tap) | **SlimSAM-77 int8, 13.2 MB** for v0.0 → **EdgeTAM (~20 MB fp16, Apache-2.0)** from v0.1 | SlimSAM is what we measured: 841 ms encode, 19 ms/tap (R4). EdgeTAM is transformers.js-native and **tracks across frames**, which SlimSAM does not — and per-frame tracking is requirement R6. Switch as soon as we need motion, not before. Note `pipeline('mask-generation')` is unsupported in transformers.js; go through the `SamModel`/`EdgeTamModel` classes |
| Runtime | **ONNX Runtime Web** (WebGPU preferred, WASM fallback) | same ONNX artifacts measured here. `@huggingface/transformers` is now **v4.x** (WebGPU EP rewritten in C++), not v3 |
| Physics | **fixed-step 2.5D solver, written in-repo** | see below |
| Overlay | Canvas2D | ghost path is a polyline + band; WebGL is unjustified |
| Language | TypeScript, no framework in the core | core must be portable and dependency-light |

**On Rapier:** it is the right eventual answer — Apache-2.0, ★5.7k, 5.6M weekly downloads for
`@dimforge/rapier3d-compat`, and *fully cross-platform deterministic* with `world.createSnapshot()`
hashing identically across machines. Determinism, my main worry, is solved there.

**Why still write the v0.0 physics ourselves:** v0.1 is circles rolling on a
plane with friction and restitution. That is ~150 lines and it must be *deterministic and
differentiable-ish* so we can (i) run it 32× for uncertainty, (ii) fit friction from observation,
(iii) unit-test it against closed-form answers. A general 3D engine is a large dependency that makes
those three things harder. Adopt Rapier at v0.3 if and when we need real 3D contact — not before.

### Hosting is an architectural decision, not a deployment detail

Multi-threaded WASM needs `SharedArrayBuffer`, which needs `COOP`/`COEP` headers, which
**GitHub Pages cannot set**. On GitHub Pages every non-WebGPU visitor falls back to
*single-threaded* WASM — reported as "a few frames per second". Since WebGPU is our fast path and
WASM is the compatibility path, hosting somewhere that can set those headers (Cloudflare Pages,
Netlify, Vercel) is worth deciding now rather than after the first bad demo.

### Optional Python "lab" (not on the live path)

`probe/` already is this: a headless harness for recorded video and accuracy evaluation, sharing the
core's *equations* (not its code). Useful for regression-testing predictions against ground truth.
It never serves the browser app.
