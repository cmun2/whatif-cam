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
| hollow white ring | the playhead: where the middle of the ensemble is at the instant being played. Never a solid ball, because it is not a measured position. |
| blue dots | the 64 futures at that same instant. They start together and drift apart; that drift is the band. |
| dashed blue line | the prediction. Dashed, and labelled `PREDICTION - not a measurement`, because it is not a track. |
| pale blue band | the 90 % band, drawn from **64 complete re-rollouts** with every assumed quantity re-drawn. It widens with time because the uncertainty does. |
| faint blue threads | those 64 futures, individually. The band is their spread, not a ribbon someone drew. |
| yellow dashed ellipse | the 90 % region the ball should come to rest in. **This is what the 7-of-10 bar is measured against.** |
| green/red crosshair | where a real ball actually stopped, in Measure mode. |

### Playing it

The path is also a thing that happens over time. Press play (it starts on its own when you
release a flick, unless your system asks for reduced motion) and the whole ensemble
advances together over the roll's real duration. Scrub, pause, replay.

What moves is **not one ball**. A single confident sphere sliding along the mean would
quietly undo the work the band does: on the demo photo the predicted roll is 34 cm and the
90 % interval is 81 cm, and a ball gliding to a definite stop would bury that. So all 64
futures move, the mean is a hollow ring rather than a sphere, and the readout under the
frame says, at every instant, how many futures are still on the measured surface and **how
far apart they are in centimetres**. On the demo that number passes 68 cm while the ball is
still moving.

When the roll runs off the fitted surface, the playhead stops there, strikes the marker
out, and says *off the measured surface — nothing beyond here is known*. Futures that have
left stop being drawn, so the swarm visibly thins: the app losing track of the world, shown
rather than described. It is not animated sailing across the carpet.

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
| scatter about the plane exceeds 1.5 % of its size | the thing in front of the camera is not a plane |
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

One more caution, and it is the one that first mattered in practice: **the fitted surface
may include more than the table**, raised when the surface could not be separated from its
surroundings by appearance. See below.

Two things it refuses to *claim* rather than refusing to draw: if most sampled futures run
off the fitted surface or are still moving at the horizon, there is **no stop region** —
the path is drawn to the edge and labelled as running off, and Measure mode discards the
trial rather than scoring against a place the ball never stops.

### The surface is the table, not everything coplanar with it

The first real defect found in use: on the owner's own photo the green stipple spread well
past the tabletop — over the partition behind it and the carpet beside it — and the
prediction then ran off the table onto the floor.

That is not a threshold problem. Sweeping the inlier threshold from 0.005 to 0.03 never
removes those points: at every setting that keeps 80 % of the tabletop, tens to hundreds of
carpet points come with it. Nor is it connectivity — the depth map is smooth across the
table's edge, so the inlier set bridges it and 99 % of the leak is one connected blob with
the table. **The carpet is genuinely near-coplanar with the tabletop** in back-projected
relative depth, and geometry alone cannot tell them apart.

Appearance can. A tabletop is one continuous surface with smooth shading across it, and its
edge is a brightness *step*. So the fit grows a region outward from the middle of the
surface, accepting a neighbour whose brightness is within 0.06 of the cell it came from —
which crosses the table's own shading gradient, of any total size, and stops dead at its
edge. The seed is the point with the most neighbours that are both plane inliers and close
to it in tone, i.e. deepest inside a uniform region; seeding on inlier density alone
saturates and lands on the table's edge, where an edge-stopping fill cannot move at all.

Measured across all eleven M0 photos: fitted points more than 20 px outside the four-tap
quad go from a median of 168 (max 406) to **zero on every photo**, keeping 82–97 % of the
tabletop, while the plane's own error against the same reference is unchanged. Two side
effects worth knowing: at shallow camera angles the fit got an order of magnitude better
(16–25° elevation, exact geometry: 1.30° → 0.048°, because the wall behind the table no
longer leaks in), and the flatness and bend numbers moved onto a different scale, now
close to what M0 itself reports over a hand-delimited region.

If the gate cannot find one continuous region — a table the same tone as the floor, say —
it falls back to the raw geometry and **says so in the panel**, because then the surface
really might be everything coplanar with the table.

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
app/src/anim.js         the playhead clock and its interpolation
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
