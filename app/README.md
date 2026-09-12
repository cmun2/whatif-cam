# v0.0 — "Ghost Ball"

One ball, one table, one flick, one honest band around the answer.

```bash
./app/run.sh
```

That is the whole thing. It fetches what is missing (about 90 MB of runtime and weights,
all free and open-weight, no account), serves the repo on `localhost:8017`, and opens the
page. **No build step.** The source is plain ES modules; what is on disk is what runs.

```bash
./app/run.sh --test     # the headless suite: geometry, physics, band, refusals, tracker
```

---

## The first ten seconds, with no camera and no ball

The page opens on **`photos/IMG_5359.JPG` — one of your own eleven M0 photos** — runs the
depth model once, fits the support plane, drops a virtual 40 mm ball in the middle of the
surface it found, and flicks it. What you see is your own table with the fitted surface
stippled green over it and a ghost path across it.

About four seconds of that is the int8 depth model in WASM; on a browser with WebGPU it is
faster. Either way it happens **once**. Then drag anywhere on the image to flick it
yourself, pick a different photo, or switch to the synthetic table.

If `photos/` is empty — it is gitignored, so a fresh clone has none — the app says so and
falls back to the synthetic table, which needs no files at all.

---

## What is on screen

| | |
|---|---|
| green stipple | the pixels the plane was actually fitted to. If this is not your table, nothing below it is worth reading. |
| dashed blue line | the prediction. Dashed, and labelled `PREDICTION - not a measurement`, because it is not a track. |
| pale blue band | the 90 % band, drawn from **64 complete re-rollouts** with every assumed quantity re-drawn. It widens with time because the uncertainty does. |
| faint blue threads | those 64 futures, individually. The band is their spread, not a ribbon someone drew. |
| yellow dashed ellipse | the 90 % region the ball should come to rest in. **This is what the 7-of-10 bar is measured against.** |
| green/red crosshair | where a real ball actually stopped, in Measure mode. |

And the panel on the right — "what this is assuming" — shows the numbers that decide all
of it: the assumed field of view and where it came from, the fitted plane's elevation
against the range anything was ever tested in, its flatness and bend, how much of the frame
it covers, the plane error the band is using, the metric scale and its source, and the
assumed friction. `window.whatif` in the console holds the same state, unrounded.

---

## Where it refuses

A refusal takes over the frame and no path is drawn. Everything in `src/confidence.js`:

| it refuses when | because |
|---|---|
| no plane at a table-like angle is found | there is nothing to roll a ball on |
| the surface covers under 12 % of the frame | a patch that small is a lucky fit, not a table |
| scatter about the plane exceeds 0.6 % of its size | the thing in front of the camera is not a plane |
| the near/far halves disagree by more than 12° | the depth map is warped, and no plane fit rescues that |
| the camera is below 15° or above 70° elevation | too foreshortened to be useful / too little perspective to fit |
| the tap selects over 35 % of the frame, or under 60 px | that is the table, or it is noise |
| the object runs off the edge of the frame | its contact point with the table cannot be located |
| the object's base sits over 3 ball-radii off the plane | it is not on the table we measured, or the plane is wrong |
| depth scatter around the tap is over 2.5× the surface's | the depth map is unreliable exactly where it matters |
| **the camera has moved since setup** | the plane was measured from one frame; moving invalidates it silently |

And where it cautions instead — visible in the panel, counted in the hint line, not
covering the image: an untested camera angle, a noisy or slightly bent surface, a ball that
rolls off the measured region, a roll still moving at the 6 s horizon, and **a band as wide
as the prediction is long**, which with friction merely guessed is most of the time.

Two things it refuses to *claim* rather than refusing to draw: if most sampled futures run
off the fitted surface or are still moving at the horizon, there is **no stop region** —
the path is drawn to the edge and labelled as running off, and Measure mode discards the
trial rather than scoring against a place the ball never stops.

### Camera motion

A 64-wide luminance thumbnail of the setup frame, compared every frame with a ±3 px shift
search. A ball rolling through the frame raises the residual a little and the shift not at
all; picking the camera up raises both. Either, held for 0.35 s, withdraws the prediction.
Deliberately *not* used: `DeviceOrientation`. The M0 gate passed, so the plane comes from
depth, and a motion-sensor dependency would break the laptop case and add an iOS prompt.

---

## The field of view, and why it is a guess

**A browser is told nothing about the lens on a live camera stream.**
`MediaStreamTrack.getSettings()` reports width, height and frame rate, and not one thing
about optics. So the app assumes **68°** horizontal — a 26 mm-equivalent lens, which is an
iPhone's 1× rear camera, and the middle of the 60–78° band laptop webcams occupy — and says
`assumed` next to it, with a slider and three presets.

It matters: `m0/README.md` §6 measured that the absolute plane orientation moves about
**2° for every 4°** the focal length is wrong. That is folded into the band as a ±8°
1-sigma on the FOV, dropping to ±4° if you state one and ±1° if EXIF supplied it.

In **photo** mode there *is* EXIF, and it is read rather than guessed — including the walk
into the Exif sub-IFD at `0x8769`, which is where iPhones put tag 41989 and where the M0
harness was not looking until §6 of its README.

---

## Where the metres come from

Relative depth has no metres in it. `RESEARCH.md` §3.4 shows the path's *shape* does not
need them — but friction is a deceleration in m/s², so "how far before it stops" does.

Two sources, and the app says which one is in use:

- **a real ball of known diameter** (default 40 mm, a table-tennis ball), measured in
  pixels. Solved exactly: the silhouette's radius corresponds to the distance to the ball's
  *centre*, one radius up the plane normal from the contact point, so
  `r = (ρ·z_contact/f) / (1 − ρ·n_z/f)`. The obvious approximation is 2.2 % out, which is
  2.7 % on the speed and 5 % on the distance, in the same direction every time.
- **the stated camera height** above the table, when the ball is virtual and there is
  nothing of known size in the picture. Much weaker, sampled at ±25 %, and labelled
  `camera height (weak)`.

---

## Measure mode, and the friction problem

A drag sets a velocity you invented. A real roll has a velocity only the camera can know,
so for a trial the app watches the first **0.30 s** of the actual roll (the window
`probe/analyze2.py` used), fits the rolling model to the ball's position *on the plane*,
freezes the prediction at that instant, and keeps tracking until the ball comes to rest.
Then it records whether the rest point fell inside the 90 % region.

It also prints the deceleration your table actually had, `v₀²/(2d)`. That number is not fed
back into the model — fitting friction is v0.2 on the roadmap — but it is the number to
type into the friction slider before running the ten real trials.

**Read this before trusting a pass.** With friction merely guessed at ±40 %, the band is so
wide that a table with *three times* the assumed friction still lands inside it
(`tests/uncertainty.test.js` measures exactly that). Passing 7 of 10 with a band wider than
the roll proves very little. That is why every trial records its band width, why the
summary prints the median band width next to the score, and why the right sequence is: run
a few trials, read off the measured deceleration, set the slider, then run the ten that
count.

---

## What runs, and when

```
ONCE, at "Set up scene":     depth (26 MB int8)  ->  back-project  ->  RANSAC plane
ONCE, at the first tap:      SlimSAM encoder (13 MB)
PER TAP:                     SlimSAM decoder
PER FRAME:                   blob tracker + camera-motion fingerprint + canvas. No neural nets.
```

Measured in headless Chromium on WASM with no WebGPU adapter: depth **1.1–1.4 s**, SlimSAM
encode **2.8 s**, plane fit **~100 ms**. All of it once. That is `ARCHITECTURE.md`'s R5/R6
split, and it is the reason this fits in a browser at all.

---

## Files

```
app/index.html          one page
app/src/constants.js    every magic number, with the measurement it came from
app/src/geometry.js     pinhole camera, plane, in-plane frame. Pure.
app/src/planefit.js     depth -> RANSAC plane + the M0 diagnostics, ported from m0/planefit.py
app/src/sim.js          the rolling model. ~40 lines, exact against the closed form.
app/src/uncertainty.js  64 rollouts with every assumption re-drawn
app/src/confidence.js   every refusal, in one file
app/src/depth.js        Depth Anything V2 Small
app/src/segment.js      SlimSAM-77, ported from m0/region.py
app/src/object.js       mask -> contact point (lower edge, not centroid) + radius
app/src/tracker.js      blob-centroid tracking + the rolling-model velocity fit
app/src/motion.js       camera-motion detection
app/src/exif.js         FocalLengthIn35mmFilm, including the sub-IFD walk M0 needed
app/src/synth.js        probe/scene.py's tabletop in JavaScript, with exact ground truth
app/src/sources.js      camera / photo / synthetic
app/src/render.js       the overlay
app/src/app.js          wiring
```

Nothing is minified, bundled, or transpiled. There is no `package.json` because there are
no dependencies: the only third-party code is the ONNX Runtime build in `app/vendor/ort/`,
which is fetched verbatim and never modified.

## A fresh clone

`models/*.onnx`, `app/vendor/ort/`, `photos/` and `tests/fixtures/` are all gitignored.

```bash
./app/fetch-deps.sh          # runtime + weights, ~90 MB, free, no account
./app/run.sh                 # (runs fetch-deps itself if anything is missing)
```

The photos are yours and stay out of the repo; without them the app opens on the synthetic
table and `tests/plane-real.test.js` skips. To regenerate the test fixtures from the photos:

```bash
.venv/bin/python tests/make-fixtures.py
```
