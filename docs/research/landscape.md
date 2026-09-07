# WhatIf Cam — Competitive & Technical Landscape

**Compiled:** 2026-09-07
**Scope:** Does anything already do *"point a webcam at a tabletop, tap an object, see its simulated physical future overlaid live"*? And what is the best browser-runnable stack for each layer?

**Method note:** every number below was pulled from a primary source — GitHub API (`gh api`), the npm registry/downloads API, the Hugging Face model + file-tree API, Google's MediaPipe model CDN (`content-length`), and the caniuse feature JSON. Where a number could not be verified from a primary source it is marked **unverified** rather than estimated.

---

## Existing

*Things that fully and unambiguously do one piece of this problem, production-ready today.*

### Real-time monocular depth in the browser — SOLVED

**[`en970/depth-realtime`](https://github.com/en970/depth-realtime)** (MIT, ★2, pushed 2026-08-23, [live demo](https://en970.github.io/depth-realtime/)) is a complete, honest, measured implementation of exactly the depth layer we need: Depth Anything V2 Small ONNX, transformers.js, WebGPU with WASM fallback, camera → depth field at interactive rates, no server.

Its README is the single most useful engineering document found in this entire survey. Verified numbers it reports on Apple Silicon, WebGPU, fp16 weights, 350×196 network input:

| Metric | Before their optimization | After |
|---|---|---|
| Throughput | 10 fps | **20 fps** |
| Time per inference | 74 ms | **47 ms** |
| Preprocessing within that | 5.4 ms | 0.33 ms |

Hard-won details worth stealing rather than rediscovering:
- **Depth Anything V2 emits affine-invariant *inverse* depth** — larger values are already *nearer*. Do not apply `1 - t`. (Depth Anything **3 reverses this convention again**, and the V2 *metric* checkpoints return metres — so switching checkpoints requires revisiting this.)
- Hand-rolled preprocessing (RGBA→NCHW with rescale + ImageNet normalisation folded into one multiply-add) costs **0.33 ms** vs **5.4 ms** for the transformers.js built-in image processor, which redundantly re-runs a bicubic resize.
- Drive capture from `requestVideoFrameCallback` and **re-arm the moment a result arrives**; waiting for the next camera callback cost ~16 ms of dead time per cycle, roughly a third of achievable frame rate.
- Normalise on **p2/p98 percentiles**, not min/max — a single specular highlight otherwise compresses the scene and flickers frame-to-frame. Cost ~0.4 ms/frame.
- **4-bit weights are a trap.** On a Galaxy S22, q4 produced diagonal banding unrelated to the scene (arithmetic failing silently), and even where q4 works it is *slower* than fp16 because dequantising costs more than the narrower weights save.
- transformers.js serialises web inference through a module-scoped promise chain **with no rejection handler**: one genuine `session.run()` rejection permanently poisons the chain for every later call, including on a fresh session. The only recovery is discarding the worker.
- Sustained GPU load throttles phones hard — they cite ~40% throughput loss within a minute of continuous inference, and ship an adaptive resolution ladder (182…518 px, multiples of 14) with hysteresis.

**Where it stops:** it renders a depth *picture*. There is no segmentation, no object selection, no physics, no simulation, no prediction. It is the first 30% of our pipeline, done well.

### Browser physics — SOLVED, and deterministic

**Rapier** ([`dimforge/rapier`](https://github.com/dimforge/rapier), Apache-2.0, ★5,719, pushed 2026-08-28) is the clear pick. Per the [official JS determinism guide](https://rapier.rs/docs/user_guides/javascript/determinism):

> "The WASM/Typescript/JavaScript version of Rapier is **fully cross-platform deterministic**. […] creating a snapshot of the World with `world.createSnapshot()` and taking an MD5 hash of the resulting byte array will return the exact same hash on different machines."

Caveat stated in the same doc: transcendental functions (`Math.sin`, `Math.cos`) are *not* cross-platform deterministic, so any value used to *initialise* the sim must itself come from deterministic operations. For us that means the depth→geometry conversion must be reproducible if we want shareable/replayable predictions.

`@dimforge/rapier3d-compat` does **5,636,524 weekly npm downloads** (week of 2026-08-31) — the compat build (inlined base64 WASM) is the one the ecosystem actually uses; plain `@dimforge/rapier3d` does only 30,372.

### Browser hand/object tracking — SOLVED

MediaPipe Tasks Vision (`@mediapipe/tasks-vision`, Apache-2.0, **4,204,195 weekly downloads**, latest 1.0.1 published 2026-09-07 — actively maintained). Model sizes read directly from Google's CDN `content-length`:

| Model | Size | Published latency (Pixel 6) |
|---|---|---|
| `hand_landmarker.task` (float16) | **7.82 MB** | CPU 17.12 ms · GPU 12.27 ms |
| `efficientdet_lite0.tflite` float32 | **13.84 MB** | CPU 61.30 ms · GPU 27.83 ms |
| `efficientdet_lite0.tflite` **int8** | **4.60 MB** | CPU 29.31 ms |
| `efficientdet_lite2.tflite` float32 | **23.10 MB** | GPU 41.15 ms |
| `ssd_mobilenet_v2.tflite` float32 | **11.32 MB** | CPU 36.30 ms · GPU 24.01 ms |
| `gesture_recognizer.task` (float16) | 8.37 MB | — |
| `pose_landmarker_lite.task` | 5.78 MB | — |
| `selfie_segmenter.tflite` (float16) | **0.25 MB** | — |

Hand Landmarker takes 192×192 or 224×224 input and returns **21 landmarks per hand**; it is a two-model bundle (palm detector + landmark model) whose per-sub-model sizes are **not published**. **All latency figures above are Pixel 6, CPU/GPU native — Google publishes no web/JS runtime latency or fps for any of these. Unverified for our target.**

### Interactive segmentation — and object *tracking* — in the browser, SOLVED at ~20 MB

Two Apache-2.0 options, both tiny:
- **SlimSAM** ([`Xenova/slimsam-77-uniform`](https://huggingface.co/Xenova/slimsam-77-uniform), 51,299 dl/30d) — quantized encoder **8.9 MB** + decoder **4.9 MB** = **13.8 MB** for click-to-segment. The most proven web segmentation model by far; powers HF's official `segment-anything-webgpu` example.
- **EdgeTAM** ([`onnx-community/EdgeTAM-ONNX`](https://huggingface.co/onnx-community/EdgeTAM-ONNX)) — **~20 MB at fp16** (encoder 9.7 + decoder 10.5), natively supported in transformers.js, and it **tracks the selected object across frames**. For a tool where the user selects an object and then watches a prediction play out, tracking is not a nice-to-have.

Both load via `SamModel`-family classes, not a pipeline (see the integration note in the stack table).

---

## Partially overlapping

*Close in spirit, but each stops somewhere specific.*

### `tungcorn/latentlaw` — the closest conceptual match found

[MIT, ★0, created + last pushed 2026-08-12](https://github.com/tungcorn/latentlaw). Self-described as: *"Turn a short video into an editable physics world with CPU inverse dynamics, SINDy, and WebGL counterfactuals."* Its stated pipeline is literally `video -> trajectory -> hidden parameters -> simulation -> what-if future`. It fits gravity/friction/restitution/damping to observed motion via SINDy/STLSQ + system identification, then lets you change one parameter and watch the fitted and counterfactual futures diverge in a Three.js scene.

**Where it stops — and it is explicit and honest about all of these:**
- **Offline, not live.** It takes an uploaded 5-second *clip*, not a live camera feed. There is a Python API service (`services/api`) doing the optimization — it is a client/server app, not a browser-only one.
- **Three hardcoded scene families only:** bounce, incline, pendulum. Not general tabletop scenes.
- **Single object, and it must be visually separable.** Tracker is "a temporal-gated centroid with a static-camera foreground fallback."
- **Requires caller-supplied metric scale, origin, scene calibration, and floor height.** It cannot recover metric scale itself — the exact problem we have to solve.
- **It reconstructs trajectories, not the scene.** Their words: *"LatentLaw reconstructs motion and the selected physical model, not the original video's pixels or object appearance. The right-hand view is intentionally a trajectory-only simulation."* There is no AR overlay on the real image.
- Explicitly disclaims generality: *"This is not a claim of arbitrary real-world reconstruction."*
- Zero stars, single-day commit history — a one-shot project, not a maintained tool.

### `Soniqmango/vision_physics_sim` — real-time, but 2D and no depth

[No license, ★1, pushed 2026-04-19](https://github.com/Soniqmango/vision_physics_sim). *"Real-time AR physics sandbox — webcam background subtraction drives live 2D collision bodies that balls bounce off of."* Pipeline: `absdiff(frame, background) → threshold mask → contours → convex hulls → Pymunk static segment bodies → 2D physics step → draw balls`.

**Where it stops:** Python + OpenCV desktop app (`cv2.imshow`), **not a browser**. **2D only** (Pymunk). Detection is naive **background subtraction** requiring the user to first sample an empty background and re-sample whenever lighting changes. No depth estimation, no object identity, no per-object selection, no prediction — balls just fall onto whatever silhouette is in frame. It's a fun toy that reacts to the present; it does not predict a future.

### `VARSHITH707/AirBench` — the right browser stack, wrong scene source

[MIT, ★1, pushed 2026-07-08](https://github.com/VARSHITH707/AirBench). Browser-based 3D machine teardown: **MediaPipe hand tracking + Three.js + Rapier physics (WASM via CDN)**, fully client-side, no install. It has a genuinely sophisticated physics layer — material catalog with real densities, weld/revolute/prismatic/ball joints, a simulation pre-flight validator, a ~30 s ring-buffer timeline with scrub/frame-step, failure detection, and vector overlays.

**Where it stops:** the 3D content is **pre-authored or imported CAD** (`.glb/.gltf/.3mf/.stl/.obj/.fbx`) plus a procedural gearbox. The camera is used **only as a hand-tracking input device** — it never reconstructs the scene in front of it. Nothing the camera sees becomes a physics body. This is the proof that our *output* stack (MediaPipe + Three.js + Rapier in-browser) works; it does nothing about the *input* problem.

### `lyonsno/moge-webgpu` — metric depth in-browser, but not at interactive rates

[MIT, ★0, pushed 2026-09-03](https://github.com/lyonsno/moge-webgpu). A full hand-written port of MoGe-2 (ViT-Large + ConvStack) to raw WebGPU compute shaders — 15 compute shaders, no ONNX runtime, no WASM. Notably it includes a **scale head (MLP, CLS token → metric scale)**, i.e. genuine metric output, and verifies **0.25% mean relative error and metric scale within 0.24%** vs the PyTorch fp32 reference.

**Where it stops:** **~660 MB of fp16 weights** on first load and **~2.5 s per image on an Apple M4 Max**. That is single-image, drop-a-file, not live camera. Requires Chrome/Edge 113+, Firefox 141+ behind a flag. Off by ~50× from interactive rates, and the download alone disqualifies it for a webcam tool.

### `collidingScopes/keep-ups`, `addispupi/facs-apfs-3d-simulator`, `VoxDroid/VoxSpace`

Webcam + MediaPipe + Three.js + physics browser toys ([keep-ups](https://github.com/collidingScopes/keep-ups) ★3; [facs-apfs](https://github.com/addispupi/facs-apfs-3d-simulator) ★4 MIT; [VoxSpace](https://github.com/VoxDroid/VoxSpace) ★7 MIT). All use the camera as a **body/face/hand controller** driving a synthetic scene. None reconstruct or simulate the *physical scene* the camera is pointed at.

### Research: physics-from-video

Every published system trades away one of the three things we need. The three most instructive are below; the rest of the family follows the same shape.

**[RealWonder](https://liuwei283.github.io/RealWonder/) (arXiv [2603.05449](https://arxiv.org/abs/2603.05449), Mar 2026, Stanford + USC) — the closest thing that exists.**
★223, ⛔ **CC BY-NC-SA 4.0** (verified from LICENSE.md — non-commercial). Self-described as *"the first real-time system for action-conditioned video generation from a single image."* Pipeline: Meta SAM 3D Objects + SAM 2 reconstruction → **Genesis** physics engine → optical-flow + RGB conditioning → 4-step distilled Wan2.1-1.3B video generator. You drag a force and see the consequence. **13.2 FPS at 480×832.**
**Where it stops — three hard walls.** (a) **On a single NVIDIA H200** (141 GB HBM3e, ~$30k+); the `demo_web/app.py` "Real-Time UI" is a browser page talking to a locally-hosted H200, so the browser is a viewport onto a datacenter. No public hosted demo. (b) **A single pre-processed image**, bundled into `demo_data/<scene>/` — the entire reconstruction happens before you interact; there is no live feed. (c) It **generates** frames rather than **overlaying** a prediction on real pixels, so registration to a live camera is not something it does. Plus the licence blocks commercial use.

**[Video2Game](https://video2game.github.io/) (CVPR 2024) — the only one that genuinely runs in a browser.**
★335, MIT, last push 2024-04. Video → NeRF → baked textured mesh + convex-decomposition collision models → exported to a **Three.js / Cannon.js** scene you can walk around. Paper Table 4 runtime, all in-browser: **Mac M1 Pro / Chrome 102 FPS**, Intel i9 + RTX 4060 / Edge **240 FPS**, RTX 3090 / Linux Chrome **144 FPS**. [Live demo](https://video2game.github.io/src/garden/index.html).
**Where it stops:** *"For base NeRF training, it takes **8 hours** for training 150k iterations on an **A6000**"* — an 8-hour datacenter bake stands between the camera and the browser. And it produces a walk-around game on a static reconstruction, not a prediction registered to live pixels. Useful warning from the authors: *"Because of the limitation of Cannon.js, the physical simulation with the exported assets requires lots of laborious tasks. We thus recommend that use Unreal Engine."* — corroborating our choice of Rapier over cannon-es.

**[PhysTwin](https://jianghanxiao.github.io/phystwin-web/) (ICCV 2025) — the strongest "real physics from real video" result.**
★455, MIT, actively maintained (pushed 2026-08-24). Inverse-optimizes a spring-mass model + shape prior + Gaussian-splat appearance from video of someone manipulating an object; the resulting twin runs at **37 FPS on an RTX 4090**.
**Where it stops:** **three calibrated RealSense D455 RGB-D cameras**, not one webcam; **~5 min** (differentiable spring-mass) **+ ~12 min** (zero-order CMA-ES) of per-object optimization before you can touch anything, on top of Grounded-SAM-2 + TRELLIS + 3DGS training; **deformables only** (ropes, plush, cloth) — not the rigid "push this ball" case; and its 2026 Gradio "web visualization" is **server-side rendering streamed to a browser tab**, same as RealWonder.

| Other work | Stars / License | What it does | Where it stops |
|---|---|---|---|
| [PhysGaussian](https://github.com/XPandora/PhysGaussian) (CVPR'24 Highlight) | ★1,420, ⚠️ **no LICENSE file** | The foundational "what you see is what you simulate" — continuum mechanics on Gaussian kernels via custom MPM | A *simulator*, not perception. Assumes a trained 3DGS scene **and** hand-authored physical params. Everything below exists to guess those params. |
| [PhysDreamer](https://github.com/a1600012888/PhysDreamer) (ECCV'24) | ★631, ⚠️ **no LICENSE file** | Distills a material field from a video-diffusion motion prior | Multi-view capture required. Paper's own limitation: *"approximately **one minute on a NVIDIA V100 GPU to produce a single second of video**"* — ~1800× slower than real time. |
| [PhysGen](https://github.com/stevenlsw/physgen) (ECCV'24) | ★353, ⚠️ **no LICENSE file** | Image + user force → plausible video. **2D image-space** rigid-body sim | Side/top-down views only; forces typed into a `sim.yaml`; output is an MP4. **But: *"image space dynamics simulation in just 3 seconds without GPU"*** — evidence a useful sim is cheap once perception is done. |
| [PhysGen3D](https://github.com/by-luckk/PhysGen3D) (CVPR'25) | ★251, **MIT** | Single image → amodal camera-centric interactive 3D scene, MPM-simulated | Conceptually the closest *published idea* to WhatIf Cam — and it is a 3-stage batch CLI ending in **Mitsuba3 path tracing** over 100 frames. Params from GPT-4o or hand-written YAML. |
| [Physics3D](https://github.com/THU-SI/Physics3D) | ★240, **MIT** | Viscoelastic params distilled from a text-to-video model, then MPM | Per-object SDS optimization driven by a *text prompt*. No camera perception at all. |
| [DreamPhysics](https://github.com/tyhuang0428/DreamPhysics) (AAAI'25) | ★233, ⚠️ **no LICENSE file** | KAN material field via motion-distillation sampling | Same gap as Physics3D — 4D asset authoring. |
| [PhysSplat](https://github.com/Maxwell-Zhao/PhysSplat) (ICCV'25) | ★17, ⚠️ **no LICENSE file** | MLLM-guided Gaussian-splat physics | Offline; needs an MLLM in the loop. |
| [PhysMind](https://arxiv.org/abs/2608.04575) (Aug 2026) | — | Video → segmentation + 6D pose → fits analytic dynamics → answers **counterfactual questions**. +19.25 over GPT-5.5 on counterfactuals | Answers **text questions**; renders no overlay. Agentic VLM loop = seconds-to-minutes per query, on benchmark videos (CLEVRER), not a live feed. |
| [CWMDT](https://arxiv.org/abs/2511.17481) | — | Formalizes *counterfactual world models* via digital-twin-conditioned video diffusion | LLM + video diffusion in the loop. Nowhere near real time. |

**Note for an open-source project:** PhysGaussian, PhysDreamer, PhysGen, DreamPhysics and PhysSplat all ship **with no LICENSE file at all** — meaning no grant of rights. Only PhysGen3D, Physics3D, PhysTwin and Video2Game (all MIT) are safe to draw code from.

### Real-time world models (2025–2026) — crowded, and none of them look at your scene

| Work | Claim | Where it stops for us |
|---|---|---|
| **Genie 3** (DeepMind — [blog only](https://deepmind.google/discover/blog/genie-3-a-new-frontier-for-world-models/); an arXiv search for it returns **zero papers**) | 720p, **24 FPS**, minutes of continuous interaction, ~1 min visual memory | Input is a **text prompt**, not a camera. *"Limited research preview."* The blog explicitly lists **inability to accurately represent real-world locations** as a limitation. It hallucinates a world; it does not predict yours. |
| **Matrix-Game 2.0** [2508.13009](https://arxiv.org/abs/2508.13009) / **3.0** [2604.08995](https://arxiv.org/abs/2604.08995) | **25 FPS** / **40 FPS at 720p** (5B model), open weights | Trained on ~1200 h of **Unreal Engine + GTA5**. Keyboard/mouse navigation actions. Not physics-accurate, not your table, datacenter-class. |
| WorldPlay, RELIC, ReWorld, minWM, MineWorld, Matrix-Game 3.5 | Real-time streaming interactive video generation with long-horizon memory | All generative-video models. **Plausible, not physical.** No object-level force input, no accuracy guarantee, no registration to a real camera. |

The [2026 survey](https://arxiv.org/abs/2606.01164) *Towards Interactive Video World Modeling* confirms the field's frame is **generation**, not **counterfactual prediction of an observed scene**. These are not competitors; they are a different product.

### The uniform pattern

**Every research system trades away one of the three things we need at once.** Browser-native + real-time but offline-built (Video2Game: 102 FPS in Chrome, behind 8 h on an A6000). Real-time + physics-grounded but datacenter + pre-processed single image (RealWonder: 13.2 FPS on an H200). Real physics from real video + real-time playback but heavy capture + offline fit (PhysTwin: 37 FPS on a 4090, behind 3 depth cameras and 17 min of optimization). **No system holds all three.**

### Open WebAR frameworks — none of them solve scene reconstruction

| Framework | License | Stars | Last real commit | npm/week | What it tracks |
|---|---|---|---|---|---|
| [AR-js-org/AR.js](https://github.com/AR-js-org/AR.js) | MIT | ★5,987 (1,003 forks) | 2026-03-16 (v3.4.8) | 1,016 (`@ar-js-org/ar.js`) + 3,059 (legacy `ar.js`) | Marker tracking (Hiro/barcode/pattern), NFT image tracking, location/GPS AR |
| [hiukim/mind-ar-js](https://github.com/hiukim/mind-ar-js) | MIT | ★2,725 (512 forks) | **2024-01-16** | 3,802 | Image target tracking, face tracking |

Both track **known planar targets** — a printed fiducial or a reference image. **Neither does markerless plane detection, SLAM, depth, or scene reconstruction.** AR.js's core CV is `jsartoolkit5`; it is fundamentally a fiducial/NFT tracker. Neither gives us anything toward "understand the tabletop"; that whole layer must be built.

Maintenance status differs sharply and matters for dependency risk:
- **AR.js is alive** — v3.4.8 published 2026-03-16, repo pushed 2026-06-21. Known limitations from its [docs](https://ar-js-org.github.io/AR.js-Docs/): NFT image tracking is *"more CPU consuming"*, and location AR *"will not work correctly on Firefox"* (no absolute device orientation).
- **MindAR is effectively dead.** Last actual commit **2024-01-16** (v1.2.5), npm registry `modified` the same date — roughly 2 years 8 months stale. It still draws 3,802 weekly downloads, but building on it means expecting to fork it.

### 8th Wall — the paid incumbent evaporated in Feb 2026, and its SLAM is still closed

**This is the single biggest competitive change in the space, and it cuts both ways.**

`www.8thwall.com` now 307-redirects to [`8thwall.org`](https://8thwall.org). From the announcement post ["Goodbye 8thwall.com. Hello 8thwall.org."](https://8thwall.org/blog/8th-wall-open-source), dated **2026-03-02**, verbatim:

> "Over the past few months, we shared that 8th Wall would transition from a hosted, paid platform to an open source project. As of **February 28, 2026**, that transition is complete."

And from the site FAQ, verbatim: *"Is there a paid tier? **No.** All paid subscriptions ended on February 28, 2026 when the hosted platform was retired."* Historical price points are **unverified** — the archived pricing page was JS-rendered and no dollar figures survive in the Wayback HTML. Do not quote a number.

**What was open-sourced vs. what was not — this distinction is load-bearing:**
- **MIT-licensed:** engine framework core, **Image Targets, Face Effects, Sky Effects**, the Image Target Processor CLI, sample projects ([archive repo](https://github.com/8thwall/archive)). Main repo [`8thwall/8thwall`](https://github.com/8thwall/8thwall) ★467, MIT, pushed 2026-09-06 — actively maintained, funded by a grant from Agog: The Immersive Media Institute ([announced 2026-08-14](https://8thwall.org/blog)).
- **NOT open source: SLAM / world tracking.** Verbatim from the March post: *"SLAM has not been open sourced and will only be available in the Distributed Engine Binary."* Also excluded: *"VPS, Maps, and Hand Tracking are not included."*

**The binary's license forbids our business model.** [`8thwall/engine`](https://github.com/8thwall/engine) (★162, GitHub reports `NOASSERTION`) ships an "XR ENGINE LICENSE AGREEMENT," © 2026 Niantic Spatial. §1.2 verbatim:

> "Licensee may not utilize the Software or exercise the rights granted in this Section 1 in connection with any product or service: (1) which is offered for a fee or other consideration, and (2) whose value derives, entirely or substantially, from the functionality of the Software."

Plus mandatory Niantic Spatial attribution (§1.3), no reverse-engineering, no derivative works, no competing product — and the license is **revocable**. Branded campaigns using it as one component are explicitly fine per the FAQ. A paid product whose core value *is* world tracking is prohibited.

**Read this carefully as a market signal, not just an opening.** The objection "why would anyone use you when 8th Wall exists" is gone. But the reason it is gone is that **Niantic could not sustain the business** and is now running it on grant money. That is a demand signal about paid WebAR tooling that deserves weight in any monetisation plan.

### Niantic Lightship / Spatial SDK — not web at all

`lightship.dev` now redirects to [nianticspatial.com](https://www.nianticspatial.com/docs/nsdk/). Platforms: **Unity, Swift, Kotlin — no web/JavaScript target.** [Pricing](https://www.nianticspatial.com/pricing) is credit-based: Free $0 (20,000 credits/mo), Plus **$20/mo or $200/yr**, Pro **$50/mo or $500/yr** (includes commercial rights), Enterprise custom. Irrelevant as a stack candidate; relevant only as competitor context.

### WebXR — unusable as a baseline, because iOS does not compile it in

The compat tables understate this. From the **WebKit source tree itself** (`Source/WTF/wtf/PlatformEnableCocoa.h`):

```c
#if !defined(ENABLE_WEBXR) && PLATFORM(VISION)
#define ENABLE_WEBXR 1
#endif
```

with the default `#define ENABLE_WEBXR 0` in `PlatformEnable.h`. **WebXR is compiled in only for `PLATFORM(VISION)` — visionOS / Apple Vision Pro. On iPhone, iPad and macOS the code is not in the binary at all.** This is not a flag that could flip next release; it is an absent feature.

And even on Vision Pro, the AR half is off. From `UnifiedWebPreferences.yaml`:

| Preference | Condition | Default | Status |
|---|---|---|---|
| `WebXREnabled` | `ENABLE(WEBXR)` | true | stable |
| `WebXRAugmentedRealityModuleEnabled` | `ENABLE(WEBXR_AR)` | **false** | testable |
| `WebXRHitTestModuleEnabled` | `ENABLE(WEBXR_HIT_TEST)` | **false** | testable |

**`immersive-ar` is not enabled by default in Safari on any platform, including Vision Pro** — which ships `immersive-vr` only ([WebKit, WWDC24](https://webkit.org/blog/15443/news-from-wwdc24-webkit-in-safari-18-beta/)). The [WWDC25 post](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall/) does not mention WebXR at all.

Corroborated by [caniuse](https://github.com/Fyrd/caniuse/blob/main/features-json/webxr.json): **iOS Safari `n` through 26.6, with no flag note**; desktop Safari `n d` (experimental-feature toggle); Firefox `n d` (`dom.vr.webxr.enabled`); Chrome/Edge/Samsung `a` (partial). Aggregate **`usage_perc_y = 0`** — zero percent of tracked traffic has full support.

Per-API support from MDN BCD (`safari_ios` mirrors `safari`, which is `false` for every row):

| API | Chrome | Safari / iOS Safari | Firefox |
|---|---|---|---|
| `XRSystem.requestSession` | 79 | ✗ | ✗ |
| `XRHitTestSource` | 81 | ✗ | ✗ |
| `XRAnchor` | 85 | ✗ | ✗ |
| `XRDepthInformation` / `XRSession.depthUsage` | 90 | ✗ | ✗ |
| **`XRView.camera`** (raw camera access) | **107** | ✗ | ✗ |
| **`XRWebGLBinding.getCameraImage`** | **107** | ✗ | ✗ |

- **Raw Camera Access** (`camera-access`): Chrome/Edge/Samsung **107+, Android only**. Still an incubation draft ([immersive-web/raw-camera-access](https://github.com/immersive-web/raw-camera-access), ★45, last pushed 2025-12-11). **`webview_android: false`** — Android in-app WebViews do not get it.
- **Depth Sensing Module**: [spec](https://immersive-web.github.io/depth-sensing/) is an **Editor's Draft dated 2026-08-25** — still not a Recommendation. Chrome 90+ on Android only (ARCore Depth API devices in practice), `webview_android: false`.

### `getUserMedia` — works everywhere, with constraints worth designing around

[caniuse `stream`](https://github.com/Fyrd/caniuse/blob/main/features-json/stream.json): **`y` on iOS Safari 26.3–26.6**, desktop Safari 26.5–27, Chrome 151–154, Chrome Android 151. MDN BCD: `MediaDevices.getUserMedia` Safari 11+, iOS Safari 11+. The old iOS caveats are resolved — video devices work in `WKWebView` since iOS 14.3, and the "no getUserMedia in installed PWAs" note applies only to iOS 11.0–13.2.

Constraints that should shape the design:
- **HTTPS is mandatory.** Per [MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia): *"If a document isn't loaded in a secure context, the `navigator.mediaDevices` property is `undefined`."* (`localhost` and `file:///` also count as secure.)
- **Top-level context only.** An `<iframe>` needs explicit `allow="camera"` Permissions-Policy delegation — relevant if anyone embeds the tool.
- **Rear camera:** `{ facingMode: { exact: "environment" } }`. MDN warns you may need to `stop()` the existing track before switching facing mode.
- **`playsinline` is required** on the `<video>` element or iOS Safari takes over fullscreen.
- **In-app browsers are a real risk.** All third-party iOS browsers are `WKWebView` over the same WebKit engine. A host app must implement `WKUIDelegate.webView(_:requestMediaCapturePermissionFor:…)` (iOS 15.0+) or camera access is **silently denied**. Traffic arriving via Instagram / Facebook / LINE in-app browsers may fail — **plan an "open in Safari" escape hatch.** Given that our distribution strategy is social sharing, this is not a footnote; it is a primary funnel risk.
- A user-gesture requirement for the `getUserMedia` call itself is **unverified** at spec level — treat "requires a tap" as an implementation convention.
- iOS-specific resolution caps: **unverified**, no primary source found.
- `getDisplayMedia` (screen capture) is `safari_ios: false` — unavailable, unlike camera.

**This is a load-bearing architectural fact.** Any design that depends on WebXR — `immersive-ar`, plane detection, hit-test, the Depth Sensing module, or raw camera access — is **Android-Chrome-only and excludes every iPhone**. A design built on `getUserMedia` + our own canvas/WebGL overlay runs everywhere. 8th Wall reached the same conclusion and built its own CV stack.

---

## Missing

*What nobody does. These are the gaps, stated as claims we believe are currently true.*

1. **Nobody does live, in-browser, physics-plausible future prediction overlaid on a camera feed.** This is a doubly-confirmed negative — the cell is empty in both industry and literature.

   *GitHub* searches returned **literal zero results** (verified against a control query returning 1,163) for: `depth anything rapier physics`, `tabletop AR simulation webcam browser`, `webcam depth physics`, `physics engine real world camera segmentation depth`, `interactive physics from single image browser`, `real time physics from video browser`, `predict trajectory overlay camera realtime`, `AR overlay simulation prediction browser webgpu`.

   *arXiv* full-text searches returned **zero papers** for: `abs:"webcam" AND abs:"physics simulation"`; `abs:"live video" AND abs:"physics" AND abs:"real-time" AND abs:"3D reconstruction"`; `cat:cs.CV AND abs:"physics-based" AND abs:"augmented reality" AND abs:"overlay"`; `abs:"interactive" AND abs:"physical scene reconstruction"`; `abs:"digital twin" AND abs:"real-time" AND abs:"single camera" AND abs:"simulation"`.

   Note also that **"video2sim" is not an established research line** — the term returns one 2022 robotics paper ([2203.10488](https://arxiv.org/abs/2203.10488), articulated rigid-body dynamics from RGB-D, ★10) and a handful of sub-20-star repos. The real 2026 line is robotics-targeted asset generation ([SimuScene](https://arxiv.org/abs/2606.03994), [REST3D](https://arxiv.org/abs/2605.30338)), not live prediction.

2. **Nobody bridges depth to a physics scene at interactive rates — even though the parts now exist.** The research systems get metric geometry by paying for offline optimization. The browser depth demos stop at rendering a pretty picture and explicitly disclaim metric meaning (`en970/depth-realtime` says so in its UI, deliberately). Browser-runnable metric depth *does* now exist (Metric3D-small, 75.8 MB), but **nobody has connected any depth model to any physics engine in a browser.** The searches for that intersection return zero. This is the specific unoccupied ground, and it is narrower and more tractable than "solve monocular metric depth."

3. **Nobody treats "what if?" as the interaction.** Everything found is either descriptive (here is a depth map / here is a segmentation) or authoring-oriented (here is a simulatable asset you can now build a game from). Nothing lets a user point, tap, and ask a counterfactual question about the real scene in front of them and get an answer in under a second.

4. **Nobody makes the prediction the shareable artifact.** LatentLaw comes closest with URL-fragment state, but the research systems produce videos for papers and the browser toys produce ephemeral fun. The overlaid predicted trajectory as a thing you send someone is unoccupied.

5. **Nobody has taken the cheap case.** All the serious published work goes to deformables (PhysTwin, DeformMaster, NeuSpring), multi-material MPM (the PhysGaussian family), or full-scene generation (the world models). **Monocular, single-object, rigid-body, tap-to-push is the un-attacked slice** — precisely because it is the least publishable, not because it is solved.

6. **No *open* WebAR framework offers markerless scene understanding.** AR.js and MindAR both require a planar target. The one browser SLAM implementation that works — 8th Wall's — was deliberately withheld from the open-source release and ships only as a binary whose license forbids using it in a paid product. That layer has to be built, not adopted. **This is the hardest unclaimed technical ground in the space, and it is unclaimed for a reason.**

7. **Nobody has combined monocular depth with browser physics at all.** Not partially, not badly — the intersection is empty (see the zero-result searches above). The nearest existing artifact is [`mishalshanavas/mappix`](https://github.com/mishalshanavas/mappix) (★0, unlicensed): browser projector-mapping where a webcam detects physical objects and *virtual* physics balls bounce off them in real time. That is **the inverse of our concept** — virtual objects against real obstacles, rather than predicting the *real* object's own future.

---

## Our differentiation

The honest framing: **every individual layer we need exists and works in a browser today. Nobody has composed them.** That is simultaneously the opportunity and the risk — the risk being that composition is the easy part and the hard part (metric scale, and depth→collision-geometry) is hard for a reason.

A second honest signal: the two nearest existing artifacts to this concept are a **zero-star unlicensed weekend project** (`mishalshanavas/mappix`) and a **two-star MIT hobby demo** (`en970/depth-realtime`). That is what an empty-but-reachable cell looks like — as opposed to a cell that is empty because it is impossible, which would instead be littered with failed well-funded attempts.

Where we can be genuinely, defensibly different:

1. **Live, not offline — and the numbers say this is the whole ballgame.** The fastest published path from *a real object* to *a simulatable model of it* is PhysTwin's ~17 minutes, from three calibrated depth cameras. Video2Game needs 8 hours on an A6000. RealWonder skips the wait only by pre-processing a single image and renting an H200. **We target sub-second, monocular, on the user's own device.**

   This is only possible because we accept *plausible* physics rather than *accurate* physics — a tradeoff nobody in the research line can make, because papers are judged on accuracy and our product is judged on whether the answer feels right. Two published data points say the bet is sound: **PhysGen's image-space rigid-body sim runs "in just 3 seconds without GPU"**, and **Video2Game hits 102 FPS in Chrome on an M1 Pro**. Once perception is done, the simulation and rendering are nearly free in a browser. **The entire difficulty is compressed into the perception step — which is exactly the step `en970/depth-realtime` already demonstrates at 20 fps.**

2. **Zero-install, cross-platform via `getUserMedia`, not WebXR.** Deliberately declining WebXR is a differentiator, not a limitation: it is the only way to run on iPhone at all. See the caniuse data above.

3. **Counterfactual as the primitive, and *overlaid*, not generated.** "What if I push this right?" is a different product from "here is a depth map." Note what every prior system produces: either a **synthesized video** (PhysGen, PhysGen3D, RealWonder, all the world models) or a **fully reconstructed virtual scene you look at instead of reality** (Video2Game, PhysTwin). **Nobody composites a predicted trajectory back onto live camera pixels with correct registration.** The interaction and the compositing are the invention — the models are commodity.

4. **Built-in distribution.** Per project policy, a dopamine-axis product must embed its own distribution. The predicted-trajectory overlay composited over the user's own real footage is inherently shareable — the output *is* the ad. This is a product-design condition, not a channel dependency.

5. **Permissive licensing throughout** (see the license traps below) — a genuinely MIT/Apache-clean stack is not automatic in this space, and it is a real moat. The alternatives are littered with blockers: Ultralytics YOLO and FastSAM are **AGPL-3.0**; Depth Anything V2 Base/Large/Giant are **CC-BY-NC-4.0**; Depth Pro is **apple-amlr**; and 8th Wall's SLAM binary explicitly **forbids paid products** built on it. A fully Apache/MIT/CC0 stack is a differentiator we can state plainly.

### One honest counter-argument to record

**8th Wall's paid platform died.** Niantic — with far more capital, a better SLAM implementation, and a real customer base — could not sustain a paid WebAR business, and the project now survives on a media-institute grant. Our differentiation is genuine at the technical level, but this is direct evidence that *technical novelty in browser AR has historically not converted into revenue*. That argues for making the counterfactual-prediction *experience* (and its shareability) the product, rather than positioning as AR infrastructure — infrastructure is exactly the position that just failed.

### The one hard problem we must not hand-wave

Depth Anything V2 outputs **affine-invariant inverse relative depth**. Physics needs **metres**. Everything in the product depends on how we close that gap. The realistic options, in order of preference:

**Good news: browser-runnable metric depth under 150 MB exists — three independent options.** Ranked:

**1. `onnx-community/metric3d-vit-small` — 75.8 MB fp16, CC0-1.0. The best fit.**
Natively supported by transformers.js (`metric3d` is a first-class architecture with a dedicated `Metric3DForDepthEstimation` class), so it drops into the `depth-estimation` pipeline. Its ONNX graph outputs **`predicted_depth`, `predicted_normal`, and `normal_confidence`** — meaning **we get per-pixel surface normals for free**. That is unusually valuable here: normals give us collision-plane orientation directly, which is exactly what a physics scene needs and what a bare depth map does not provide.
- ⚠️ **The catch, and it is important:** Metric3D emits depth in a *canonical camera space* (`focal_length = 1000.0` at 512×960), not true metres. transformers.js's `DepthEstimationPipeline` does **no** metric post-processing — it only interpolates and min/max-normalizes to a `RawImage`. We must read the raw `predicted_depth` tensor and apply the focal rescale ourselves in JS. So *"metric"* only becomes true after we supply a focal length estimate.

**2. `77ukhtar/depth-anything-v2-metric-onnx` — 98.9 MB, Apache-2.0.**
A community self-export of `Depth-Anything-V2-Metric-Hypersim-Small` — **indoor (Hypersim), `max_depth = 20 m`, which is exactly our tabletop case**, and the same 24.8 M-param encoder we are already running, so the same expected fps. The card claims output `predicted_depth` is "metric depth in metres", range (0, 20), opset 17, *"verified against the PyTorch model: max-abs output diff < 1e-3."*
- ⚠️ Single-author repo with **0 downloads** — verify independently before trusting. fp32 only; we would quantize to fp16 (~50 MB) ourselves. No transformers.js config, so drive it through onnxruntime-web directly.
- **Why no official `onnx-community` build exists:** Optimum simply cannot export this architecture yet. transformers.js issue [#1476](https://github.com/huggingface/transformers.js/issues/1476) (open since Dec 2025) is exactly this request, failing with `ValueError: Trying to export a depth_anything model, that is a custom or unsupported architecture`. Xenova's own reply: *"it looks like `depth_anything` hasn't been added to Optimum, even though it should literally just be a few lines of code."* The fix, [optimum-onnx#103](https://github.com/huggingface/optimum-onnx/pull/103), is **still open**. A reporter who exported manually then hit `ERROR_CODE: 2 … Actual: (tensor(float)), expected: (tensor(float16))` on WebGPU. **Budget real time here if we take this path** — and note that landing that PR upstream would be a clean, high-visibility OSS contribution directly on our critical path.

**3. `Ruicheng/moge-2-vits-normal-onnx` — 140.9 MB, MIT, official Microsoft export.**
MoGe-2 ViT-S (35 M params), metric, with normals and a pointmap. But per its [`docs/onnx.md`](https://github.com/microsoft/MoGe): *"The `.infer()` method in our PyTorch code includes some post-processing logic (e.g. recovering focal and shift and reprojection) that cannot be exported to ONNX. The ONNX model only includes the raw `forward()` pass."* Outputs are `points, normal, mask, metric_scale` — **we reimplement focal/shift recovery in JS.** Real work, but MIT and feature-rich.

**Every metric option needs a focal length.** Metric3D needs it for the canonical rescale; DA3's metric model needs it (`metric_depth = focal * net_output / 300`); MoGe-2's ONNX export makes us recover it. Only Apple Depth Pro estimates focal itself — and it is 600 MB–3.8 GB with a non-OSI licence. **So "where does the focal length come from?" is a design decision to make early, not a detail to defer.** Options: `MediaStreamTrack.getSettings()`, a one-time user calibration, or a sane default for laptop webcams.

**Also keep the cheap path.** Ask the user for one reference object (a credit card, a coin, a phone) or assume a typical tabletop distance. Physics is forgiving of uniform scale error — if the whole scene is off by 20%, trajectories still look right and only timing degrades. Worth building regardless as the fallback and as a sanity check on the metric models.

Do **not** reach for Depth Pro (952 M params, 1.9 GB fp16, `apple-amlr`) or MoGe-2-ViT-L (660 MB, 2.5 s/frame). Do not reach for UniDepth — it is **CC BY-NC 4.0**, disqualifying.

---

## Candidate stack components

### Depth

| Model / build | Size | Metric or relative? | License | Notes |
|---|---|---|---|---|
| [`onnx-community/depth-anything-v2-small`](https://huggingface.co/onnx-community/depth-anything-v2-small) | fp32 **99.1 MB** · fp16 **49.6 MB** · int8/q8 **27.3 MB** · q4f16 19.1 MB | **Relative** (affine-invariant *inverse* depth) | **Apache-2.0** | 24.8 M params. 60,760 dl/30d — most-used web depth model by a wide margin. **20 fps / 47 ms** measured (M-series, WebGPU, fp16, 350×196). Already downloaded in `models/`. |
| [`onnx-community/metric3d-vit-small`](https://huggingface.co/onnx-community/metric3d-vit-small) ⭐ | fp32 **150.7 MB** · fp16 **75.8 MB** | **METRIC** (canonical camera space — needs focal rescale) | **CC0-1.0** | ⭐ **Best metric option.** First-class transformers.js architecture (`Metric3DForDepthEstimation`). Also outputs **`predicted_normal` + `normal_confidence`** — surface normals for free, ideal for collision planes. DPT processor, 518×518, `ensure_multiple_of: 14`, `do_normalize: false, do_rescale: false`. Only 159 dl/30d — unproven in the wild. |
| [`77ukhtar/depth-anything-v2-metric-onnx`](https://huggingface.co/77ukhtar/depth-anything-v2-metric-onnx) | **98.9 MB** fp32 (fp16 ~50 MB if we quantize) | **METRIC**, metres, range (0, 20), **indoor/Hypersim** | **Apache-2.0** | Community export of DA-V2-Metric-Hypersim-Small (24.8 M params → same fps as the relative Small). Card claims max-abs diff < 1e-3 vs PyTorch, opset 17. ⚠️ **0 downloads, single author — verify before trusting.** No transformers.js config; drive via onnxruntime-web. |
| [`Ruicheng/moge-2-vits-normal-onnx`](https://huggingface.co/Ruicheng/moge-2-vits-normal-onnx) | **140.9 MB** fp32 | **METRIC** + normals + pointmap | **MIT** | Official Microsoft export, MoGe-2 ViT-S (35 M params). ⚠️ Raw `forward()` only — focal/shift recovery and reprojection must be reimplemented in JS. Outputs `points, normal, mask, metric_scale`. |
| [`onnx-community/depth-anything-v2-base`](https://huggingface.co/onnx-community/depth-anything-v2-base) | fp32 388.9 MB · fp16 194.6 MB · q4f16 72.5 MB | Relative | ⚠️ **CC-BY-NC-4.0** | **Non-commercial. Disqualified.** |
| [`onnx-community/depth-anything-v2-large`](https://huggingface.co/onnx-community/depth-anything-v2-large) | fp32 1,336.9 MB · q4f16 234.6 MB | Relative | ⚠️ **CC-BY-NC-4.0** | **Disqualified.** Quality gain is small anyway: NYU-D δ1 0.979 (L) vs 0.973 (S). |
| [`onnx-community/depth-anything-v3-small`](https://huggingface.co/onnx-community/depth-anything-v3-small) | ~**105 MB** (0.6 MB graph + 104.7 MB external data) | **Relative**, but **direct depth, not disparity** — V3 reverses V2's convention | Apache-2.0 | 235 dl/30d. New; external-data format is more awkward to load. Upstream DA3-SMALL is 0.08 B params, which does not obviously reconcile with a 105 MB fp32 export — **the exported precision is unverified.** |
| [`onnx-community/metric3d-vit-large`](https://huggingface.co/onnx-community/metric3d-vit-large) | fp32 1,649 MB · fp16 825.2 MB | Metric | CC0-1.0 | Too large for web. |
| [`onnx-community/DepthPro-ONNX`](https://huggingface.co/onnx-community/DepthPro-ONNX) | fp32 **3,802.8 MB** · fp16 1,902.8 MB · q4f16 600.3 MB | **Metric, absolute scale — and the only model that estimates its own focal length** | ⚠️ `apple-amlr` / `apple-ascl` — **not OSI-approved** | 952 M params. README: *"metric, with absolute scale, without relying on … camera intrinsics"* and *"generates a 2.25-megapixel depth map in 0.3 seconds on a standard GPU."* Solves our focal problem perfectly — and is disqualified on both size and licence. Painful. |
| MoGe-2 ViT-L via [`lyonsno/moge-webgpu`](https://github.com/lyonsno/moge-webgpu) | **~660 MB** fp16 | **Metric** (dedicated scale head) | MIT (model: MIT) | **~2.5 s/image on M4 Max.** Accuracy verified to 0.25% vs PyTorch. Not interactive. |
| UniDepth / UniDepthV2 | only `ibaiGorordo/unidepth-v2-vits14-onnx`, 311.7 MB, 0 dl | Metric; **predicts its own intrinsics** | ⚠️ **CC BY-NC 4.0** | **Disqualified on licence.** |
| VGGT · π³/Pi3 · MapAnything | **No ONNX found on HF** | Multi-view pointmap; metric status unverified | VGGT-1B non-commercial; Pi3X CC-BY-NC-4.0 | Not web-runnable. Ignore. |

**Param counts** (from the [official README](https://github.com/DepthAnything/Depth-Anything-V2)): Small 24.8 M · Base 97.5 M · Large 335.3 M · Giant 1.3 B ("coming soon"). The metric fine-tunes exist at all three of Small/Base/Large, for **indoor (Hypersim, `max_depth = 20 m`)** and **outdoor (Virtual KITTI 2, `max_depth = 80 m`)** separately, at the same param counts as the base models.

**Depth Anything V3 licensing** (from the [official README table](https://github.com/ByteDance-Seed/Depth-Anything-3)) — the same non-commercial trap, one tier lower:

| DA3 model | Params | Output | License |
|---|---|---|---|
| DA3-SMALL | 0.08 B | Relative (direct depth, not disparity) | **Apache-2.0** |
| DA3-BASE | 0.12 B | Relative | **Apache-2.0** |
| DA3-LARGE / GIANT | 0.35 B / 1.15 B | Relative | ⚠️ CC BY-NC 4.0 |
| **DA3METRIC-LARGE** | 0.35 B | **Metric**, via `metric_depth = focal * net_output / 300` | **Apache-2.0** — but ~1.4 GB fp32, too big for web |
| DA3MONO-LARGE | 0.35 B | Relative, high-quality | Apache-2.0 |
| DA3NESTED-GIANT-LARGE | 1.40 B | Metric, already in metres | ⚠️ CC BY-NC 4.0 |

Note V3's headline architectural change: it *"directly predicts depth"* rather than disparity, *"unlike disparity-based models (e.g. Depth Anything 2)."* That is the convention reversal — near/far handling must be revisited if we ever switch.

**MiDaS** ([isl-org/MiDaS](https://github.com/isl-org/MiDaS), MIT, ★5,419) is **relative** and is now superseded, but its README publishes the only clean speed/quality ladder in the field (RTX 3090): `midas_v21_small_256` 21 M/90 fps · `dpt_swin2_tiny_256` 42 M/64 fps · `dpt_levit_224` 51 M/73 fps · `dpt_swin2_large_384` 213 M/41 fps · `dpt_beit_large_512` 345 M/5.7 fps. File sizes in MB are not published — **unverified**.

**License trap, stated plainly.** Quoting the official README verbatim:

> "Depth-Anything-V2-Small model is under the Apache-2.0 license. Depth-Anything-V2-Base/Large/Giant models are under the CC-BY-NC-4.0 license."

Verified independently via the HF API on both the `depth-anything/*` originals and the `onnx-community/*` ONNX ports. For an open-source project this collapses the choice to Small — which is fine, since it is also the fastest and the only one with real adoption (1,725,669 downloads/30d for `Depth-Anything-V2-Small-hf`).

### Segmentation

| Model / build | Size | License | Notes |
|---|---|---|---|
| [`onnx-community/EdgeTAM-ONNX`](https://huggingface.co/onnx-community/EdgeTAM-ONNX) ⭐ | enc **9.7 MB** fp16 (19.5 fp32 / 4.9 int8) + dec **10.5 MB** fp16 (21.0 fp32 / 4.6 q4f16) = **~20 MB fp16** | **Apache-2.0** (facebook/EdgeTAM) | ⭐ **Likely the right pick.** Natively supported in transformers.js (`edgetam` → `EdgeTamModel`). Same size class as SlimSAM but it is a **Track-Anything model — it tracks the selected object across frames**, which SlimSAM cannot do and which we need the moment the camera or object moves. |
| [`Xenova/slimsam-77-uniform`](https://huggingface.co/Xenova/slimsam-77-uniform) | enc **8.9 MB** + dec **4.9 MB** int8 (= **13.8 MB**); fp16 12.2 + 8.6 = ~21 MB; fp32 23.3 + 16.6 MB | **Apache-2.0** | **51,299 dl/30d** — by far the most proven. Powers the official `segment-anything-webgpu` example. Single-frame click-to-segment only, **no tracking**. Already downloaded in `models/`. Good first milestone; expect to move to EdgeTAM. |
| [`onnx-community/sam2.1-hiera-tiny-ONNX`](https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX) | enc **67.0 MB** fp16 (134.1 fp32 / 28.5 q4f16) + dec 10.5 fp16 = **~78 MB fp16** | Apache-2.0 | 6,493 dl/30d. Also tracks, but ~4× EdgeTAM's size for the same capability class. |
| [`Xenova/sam-vit-base`](https://huggingface.co/Xenova/sam-vit-base) | enc 359.3 fp32 / 180.2 fp16 / 101.1 int8 MB | Apache-2.0 | Too heavy. Superseded. |
| MediaPipe `selfie_segmenter.tflite` | **0.25 MB** | Apache-2.0 | Person-only. Not useful for tabletop objects. |
| [`onnx-community/rtdetr_r18vd`](https://huggingface.co/onnx-community/rtdetr_r18vd) | fp32 82.6 MB · **fp16 41.4 MB** · int8 21.7 MB | Apache-2.0 | **The permissive detector.** First-class transformers.js `object-detection` pipeline. Use this instead of YOLO if we need class labels or auto-proposals. `onnx-community/rfdetr_nano-ONNX` is another Apache-2.0 option. |
| YOLOv8/v11-seg via [onnxruntime-web](https://github.com/nomi30701/yolo-multi-task-onnxruntime-web) | Unverified | ⛔ **Ultralytics = AGPL-3.0** | Works in-browser, but **AGPL is a hard blocker** — and the taint propagates to exported weights: even `Xenova/yolov8n-pose` and `onnx-community/yolov10n` carry `license:agpl-3.0` on HF. **Avoid the entire Ultralytics family.** Also not supported by transformers.js (needs hand-written letterbox/NMS/mask-prototype postprocessing). |
| [FastSAM](https://github.com/CASIA-LMC-Lab/FastSAM) | no web ONNX found | ⛔ **AGPL-3.0** (confirmed from LICENSE) | ★8,408. **Disqualified on license.** |
| [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) | community only (`PulpCut/mobilesam-onnx`: enc 28.2 MB, dec 16.5 / 8.8 quant) | Apache-2.0 | ★5,865. Loads via `SamModel` since it is SAM-arch, but there is **no `onnx-community`/`Xenova` build** — less proven than SlimSAM at a larger size. |
| [EfficientSAM](https://github.com/yformer/EfficientSAM) | ❌ no web ONNX; no transformers.js architecture | Apache-2.0 | ★2,494, last push 2024-12-24. **Not web-runnable.** |

**transformers.js integration detail that will bite:** the **`mask-generation` pipeline is unsupported** (❌ in the README task table). But the *model classes* exist — `MODEL_FOR_MASK_GENERATION_MAPPING_NAMES` maps `sam` → `SamModel`, `sam2` → `Sam2Model`, `edgetam` → `EdgeTamModel`, `sam3_tracker` → `Sam3TrackerModel`. So **all segmentation must go through `SamModel.from_pretrained()` + `AutoProcessor`, never `pipeline('mask-generation')`.**

**Also note the library is now v4, not v3.** npm `@huggingface/transformers` latest is **4.2.0**; v4 shipped a **native WebGPU execution provider rewritten in C++** on ONNX Runtime (which also brings WebGPU to Node/Bun/Deno), and the repo is now a monorepo under `packages/transformers/`. Supported `depth-estimation` architectures are exactly eight: `chmv2`, `dpt`, `depth_anything`, `glpn`, `sapiens`, `depth_pro`, **`metric3d`**, **`metric3dv2`**.

### Physics

| Engine | npm weekly downloads | 2D/3D | Deterministic fixed-step? | License | Last activity |
|---|---|---|---|---|---|
| **Rapier** (`@dimforge/rapier3d-compat`) | **5,636,524** | Both (separate 2D/3D builds) | **Yes — documented cross-platform deterministic, with `createSnapshot()`** | **Apache-2.0** | v0.20.0, 2026-08-08; repo pushed 2026-08-28 |
| `matter-js` | 201,507 | 2D | Deterministic within a platform; no cross-platform guarantee documented | MIT | v0.20.0, **2024-06-23** — stale |
| `cannon-es` | 92,615 | 3D | No documented determinism guarantee | MIT | **2022-08-12** — effectively dead (repo pushed 2024-01-06) |
| `jolt-physics` | 4,885 | 3D | Jolt is designed for deterministic sim; JS binding guarantee **unverified** | MIT | v1.1.0, 2026-07-11; [JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js) ★565 pushed 2026-08-23 |
| `box2d-wasm` | 2,127 | 2D | — | Zlib | **2022-04-12** — stale |
| `physx-js-webidl` | 170 | 3D | — | MIT | v2.7.3, 2026-04-15 (PhysX 5.6.1) |

**Pick: Rapier.** It wins on every axis simultaneously — 27× the downloads of the next live 3D option, Apache-2.0, actively released, and the only one with a *documented* cross-platform determinism guarantee plus world snapshotting. Snapshotting matters for us specifically: it is how a predicted trajectory becomes reproducible and shareable.

**Independent corroboration against cannon-es:** the Video2Game authors, who shipped in-browser physics on reconstructed real scenes, warn in their CVPR'24 paper: *"Because of the limitation of Cannon.js, the physical simulation with the exported assets requires lots of laborious tasks. We thus recommend that use Unreal Engine."* They hit cannon's ceiling on exactly our problem shape — physics over geometry derived from a real scene. cannon-es is also effectively dead (last npm publish 2022-08-12). Do not start there.

### Runtime / tracking / rendering

| Component | npm weekly downloads | Version | License | Notes |
|---|---|---|---|---|
| `onnxruntime-web` | **3,836,901** | 1.29.0 (2026-09-04) | MIT | Very actively maintained. |
| `@huggingface/transformers` (**v4**, not v3) | **2,512,214** | 4.2.0 (2026-04-22) | Apache-2.0 | ★16,290, repo pushed 2026-09-07. v4 rewrote the WebGPU execution provider in C++ on ONNX Runtime. **Known footgun:** an unhandled module-scoped promise chain permanently poisons the session on any `session.run()` rejection — only recovery is discarding the worker. |
| `@mediapipe/tasks-vision` | **4,204,195** | 1.0.1 (2026-09-07) | Apache-2.0 | Hand landmarker 7.82 MB, EfficientDet-Lite0 13.84 MB. |
| `three` | **14,025,392** | 0.185.1 | MIT | Rendering + the AR overlay compositing layer. |

### Browser support envelope (from caniuse feature JSON)

| Capability | Chrome/Edge | Safari desktop | **iOS Safari** | Firefox |
|---|---|---|---|---|
| `getUserMedia` | ✅ y (151–154) | ✅ y (26.5–27) | ✅ **y (11+, current 26.3–26.6)** | ✅ |
| WebXR Device API | ⚠️ a — partial (79+) | ❌ n d — flag only | ❌ **n — not compiled in** | ❌ n d — flag only |
| WebXR raw camera access (`XRView.camera`) | ✅ 107+ **Android only**; ❌ Android WebView | ❌ | ❌ | ❌ |
| WebXR Depth Sensing | ✅ 90+ **Android only**; ❌ Android WebView | ❌ | ❌ | ❌ |
| `getDisplayMedia` (screen capture) | ✅ | ✅ | ❌ **false** | ✅ |
| WebGPU (for inference) | ✅ 113+ | ✅ 26+ | ✅ **26+** (WASM fallback below) | 141+ Win / 147+ macOS; Linux falls back |

Note on WASM fallback: **multi-threaded WASM requires `COOP`/`COEP` headers for `SharedArrayBuffer`**, which **GitHub Pages cannot set**. Single-threaded WASM runs "at a few frames per second." If we host on GitHub Pages we are single-threaded on every non-WebGPU device — a real deployment constraint that should drive the hosting decision early.

---

## Recommended stack (concrete)

| Layer | Pick | Size | Why |
|---|---|---|---|
| Camera | `getUserMedia` + `requestVideoFrameCallback`, own canvas/WebGL overlay | 0 | Only path that works on iPhone. Explicitly **not** WebXR. |
| Runtime | `@huggingface/transformers` **v4.2.0** (WebGPU EP) + `onnxruntime-web` fallback | — | Apache-2.0 / MIT, both ~2.5–3.8 M dl/wk |
| Depth (v0) | `onnx-community/depth-anything-v2-small`, fp16 on WebGPU / q8 on WASM | 49.6 / 27.3 MB | Apache-2.0, **20 fps measured**, only permissive member of its family. Already in `models/`. |
| Depth (metric) | `onnx-community/metric3d-vit-small` fp16 | 75.8 MB | CC0, first-class transformers.js arch, **and gives surface normals free** — collision-plane orientation for the physics scene |
| Scale | Focal length from `getSettings()` / one-time calibration / sane default; reference-object fallback | 0 | Every metric model needs a focal; only the disqualified Depth Pro estimates its own |
| Segmentation + tracking | `onnx-community/EdgeTAM-ONNX` fp16 (start with SlimSAM int8 for the first milestone) | ~20 MB (or 13.8 MB) | Apache-2.0, tiny, and EdgeTAM **tracks across frames** |
| Detection (if needed) | `onnx-community/rtdetr_r18vd` fp16 | 41.4 MB | Apache-2.0 — **never Ultralytics/YOLO (AGPL)** |
| Physics | `@dimforge/rapier3d-compat` | WASM inlined | Apache-2.0, deterministic, snapshotable, 5.6 M dl/wk |
| Render | `three` | — | MIT, 14 M dl/wk |
| Optional input | `@mediapipe/tasks-vision` hand landmarker | 7.82 MB | If the "push" becomes a hand gesture |

**First-load model budget on the WebGPU path:**
- Minimum viable (relative depth + SlimSAM): **~63 MB**
- Full metric + tracking (Metric3D + EdgeTAM): **~96 MB**

Both are reasonable for a browser tool with HTTP caching. Every component is Apache-2.0, MIT, or CC0 — **no AGPL, no CC-BY-NC, no bespoke vendor licence anywhere in the stack.**

### Suggested build order

1. **Benchmark first.** No credible published browser fps exists for *any* of these models (see below). Measure DA-V2-small, Metric3D-small, SlimSAM and EdgeTAM on target hardware before committing to a pipeline shape. The `en970/depth-realtime` optimizations are the baseline to start from, not to rediscover.
2. **Resolve the focal-length question**, since all three metric paths depend on it.
3. **Prove the ugly middle:** depth + mask → a Rapier collision scene that produces a *plausible-looking* trajectory, composited back onto the live frame in register. **This is the actual unsolved step and the only one with no prior art to copy** — every published system either stops before it (depth demos) or buys its way past it with offline optimization. Everything before and after it is assembled from proven parts, and both PhysGen (3 s sim on CPU) and Video2Game (102 FPS in Chrome) suggest the compute here is not the constraint. The constraint is turning a noisy, single-view, partially-occluded depth map into collision geometry that behaves sensibly. Budget accordingly: this is where the project succeeds or fails.

---

## Open questions / unverified

- **Browser fps for essentially everything.** This is the largest gap in this document. There is **no first-party published WebGPU-vs-WASM fps figure for depth-anything-v2-small, SlimSAM, EdgeTAM, SAM2.1-tiny, or MediaPipe's web runtime.** HF's own Spaces (`Xenova/webgpu-realtime-depth-estimation`, `Xenova/depth-anything-web`, `Xenova/webgpu-depth-anything-v2`) render a live FPS counter in the DOM but publish no number — their READMEs are bare 8-line Space configs. The only published transformers.js claim is the generic *"WebGPU support (up to 100x faster than WASM!)"* headline from the [v3.0.0 release](https://github.com/huggingface/transformers.js/releases), which is not depth-specific. **The single credible number in this whole document is `en970/depth-realtime`'s 20 fps / 47 ms** (M-series, WebGPU, fp16, 350×196). Everything else must be measured locally.
- **Whether Metric3D ViT-Small degrades gracefully with an assumed (wrong) focal length.** This determines whether the metric path is viable at all. Highest-value experiment available.
- **Whether `77ukhtar/depth-anything-v2-metric-onnx` is trustworthy** — 0 downloads, single author, self-claimed verification. Cheap to check against the PyTorch reference.
- **Metric3D's normal output quality** — if `predicted_normal` is good, it may simplify collision-plane construction dramatically. Unproven.
- **MiDaS file sizes in MB** — the README publishes params and RTX-3090 fps but not download sizes.
- **MediaPipe web/JS runtime latency** — all published figures are Pixel 6 native CPU/GPU.
- **8th Wall's historical price points** — unverifiable; the archived pricing page was JS-rendered and no dollar figures survive in Wayback HTML. Its *current* status is verified: free, open source, no paid tier since 2026-02-28.
- **Whether the Niantic→Scopely games-division transaction affects 8th Wall's stewardship** — not mentioned anywhere on reachable Niantic Spatial pages. **Unverified.** The verifiable corporate fact is that 8th Wall's copyright and license are now held by Niantic Spatial, Inc.
- **Rate of camera-permission denial in in-app browsers** (Instagram/Facebook/LINE `WKWebView`) — unknown, and directly threatens a share-driven funnel. Worth measuring early with a trivial test page.
- **Jolt's JS binding determinism guarantee** — Jolt's C++ core is designed for determinism; whether the emscripten binding preserves it is undocumented.
