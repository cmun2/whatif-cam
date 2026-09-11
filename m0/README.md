# M0 — the plain-table gate

One afternoon. Ten photos. One number that decides the architecture of everything after it.

`ROADMAP.md` names this as the first implementation milestone: *before any application
code*, check whether a monocular relative-depth model recovers the support plane of a
**plain, untextured** table well enough to build v0.0 on. Every plane number in
`RESEARCH.md` came from a *textured* surface (a rendered checkerboard, pool-hall felt).
Plain surfaces are the actual target and the known weak case.

---

## Run it

```bash
./m0/run.sh photos/
```

That is the whole thing. It uses the existing `.venv` and the ONNX models already in
`models/`; nothing is re-downloaded, no key, no login, no network at all once the models
are present. About 1–2 s per photo on an M1.

Other entry points:

```bash
./m0/run.sh --selftest    # verify the harness reproduces probe/real_probe.py's numbers (~25 s)
./m0/run.sh --validate    # ground-truth check on the NYU frames already in probe/out/ (~15 s)
./m0/run.sh --validate --fov-sweep   # how much the assumed focal length moves the answer
./m0/run.sh --demo        # worked example on the synthetic scene, before you have photos
./m0/run.sh --pick        # open the corner picker in a browser
./m0/run.sh photos/ --size 392 --keep-aspect --tap-sigma 1   # extra args pass through
```

---

## 1. Take the photos (~10 minutes)

**Ten photos, across at least three different plain surfaces, three or four angles each.**
The point of ten is to get a *distribution*, not an existence proof — `RESEARCH.md` has an
n=1 result already and that is exactly its weakness.

### What counts as "plain and untextured"

The test: crop a 200×200 patch out of the middle of the tabletop. If you could not tell
where on the table that patch came from, it is plain. That is precisely the condition
under which a depth model has nothing local to work with.

**Good surfaces** — white or grey melamine desk · matte black IKEA tabletop · a painted
MDF table · solid-colour kitchen laminate · a plain-finish wooden desk whose grain is
invisible from a metre away.

**Not the test** (fine to shoot as a *control*, but label it in the sidecar `note`) —
visible high-contrast wood grain with knots · a tablecloth or placemat · a patterned or
printed top · papers spread over the surface · crumbs and clutter · anything glass,
mirrored, or high-gloss enough to reflect the ceiling as a structured image.

Keep the surface **bare**. One or two small objects near an edge are fine; a covered desk
is measuring the clutter, not the table.

### Camera

- **Hold it where a user would**: 30–60 cm above the top, looking down.
- **Vary the angle deliberately**: some shots near 20° below horizontal (nearly edge-on —
  the hard case for depth *and* the easy case for the 4-tap reference), some near 45–50°
  (looking down — the opposite). If every photo is the same angle you have measured one
  condition ten times.
- **1× lens only.** The ultra-wide (0.5×) has enough distortion to break both the pinhole
  back-projection and the vanishing-line math. Both would be wrong, quietly.
- **Standard photo mode.** Not Portrait — its synthetic background blur will wreck the
  depth model in a way that tells you nothing about real tables.
- **All four corners of the tabletop in frame.** The 4-tap reference needs them. If the
  table is too big to fit, lay a sheet of A4/Letter flat near the *far* edge and tap its
  corners instead — then draw the measured region over bare table well away from the
  paper, and say so in the sidecar `note`, because the paper is a texture cue.
- **JPEG, not HEIC**, if you can (Settings ▸ Camera ▸ Formats ▸ Most Compatible). HEIC is
  handled — the harness shells out to macOS `sips` — but JPEG removes a moving part.
- **Keep EXIF.** The focal length matters: a 20 % focal-length error costs 4–7° of plane
  error (`--selftest` prints this). AirDrop or a cable preserve EXIF; most messengers and
  every screenshot destroy it. Do not crop or re-export. If EXIF is gone the harness
  falls back to 65° and says `default` in the `fov` column — treat those rows as weaker.

### Lighting

Normal room light, daytime, ceiling light on. Avoid a single hard lamp throwing one big
specular streak across the top (it blows out the surface and hides the corners), avoid
shooting into a window, avoid light dim enough to cause motion blur. Hold still.

### Three good shots, three bad ones

| | |
|---|---|
| **GOOD** | White melamine desk, completely bare, shot from standing height at ~45° down, all four corners in frame, ceiling light on, no shadow across the middle. Hard case for depth (no texture at all), clean reference. |
| **GOOD** | Same desk, crouched down to ~20° so the top is heavily foreshortened, corners still in frame. This is where perspective is strongest and where a near/far bend, if there is one, will show. |
| **GOOD** | Matte-black side table in a different room, one mug near the far-left corner, shot at ~35°. Different surface, different room, different light — that is what makes ten photos worth more than one. |
| **BAD** | Phone held directly over the table, looking almost straight down. The tabletop's edges are nearly parallel on screen, the vanishing points run off to infinity, and the 4-tap reference becomes ill-conditioned — the harness will warn, and the row is wasted. |
| **BAD** | Kitchen table with a runner, three plates and a fruit bowl. This measures a cluttered scene. Whatever it says, it does not answer the plain-table question. |
| **BAD** | Screenshot of the photo, or the photo after a WhatsApp round trip. EXIF gone, focal length unknown, and the number now carries an unstated 4–7° of possible error. |

---

## 2. Say where the table is (~1–2 minutes per photo)

No UI to build, no masks to paint. Next to each `photos/table1.jpg` put a
`photos/table1.json`:

```json
{"quad": [[412,533],[1690,498],[2010,1244],[95,1290]]}
```

Four corners of the tabletop, **clockwise from the far-left corner**: far-left,
far-right, near-right, near-left. Coordinates are full-resolution pixels of the upright
image; the harness rescales them. That single line gives *both* the measured region and
the 4-tap reference plane — nothing else is needed.

To read the coordinates off: `./m0/run.sh --pick`, drag the photo onto the page, click
four corners, copy the JSON. It runs entirely locally and uploads nothing. Any other
source of pixel coordinates works just as well.

Other keys, if you want them:

| key | meaning |
|---|---|
| `"click": [x,y]` | let SlimSAM segment the surface you clicked instead of using the quad interior |
| `"clicks": [[x,y],…], "neg": [[x,y],…]` | several positive / negative SlimSAM points |
| `"polygon": [[x,y],…]` | an explicit outline of any number of points |
| `"fov": 68.0` | override the horizontal field of view for this photo |
| `"note": "…"` | free text, copied into the JSON output |

You can combine them: `quad` + `polygon` uses the polygon as the measured region and the
quad only as the reference. That is the right move when the table has objects on it —
draw the polygon around bare surface, tap the quad on the real corners.

One shared `photos/regions.json` keyed by filename works too.

A photo with no sidecar is **skipped, loudly**. There is deliberately no auto-guess: a
wrong region produces a confident wrong number, which is worse than a missing one.

### If nobody is there to tap

```bash
.venv/bin/python m0/autoquad_run.py photos/
```

`m0/autoquad.py` detects the quad instead: SlimSAM-77 (already bundled) for a coarse
tabletop mask, a maximum-area quadrilateral in its convex hull as a seed, then each of the
four edges refined at **full resolution** by locating the bright→dark silhouette to
sub-pixel accuracy along perpendicular intensity profiles, and the corners taken as the
intersections of the fitted lines.

This does not repeal the paragraph above. It writes an ordinary sidecar, so the run is
identical to a hand-tapped one; it writes `m0-work/quad_<stem>.png` per photo, which you
must look at; and any photo whose four edges cannot be fitted with enough support is
**excluded and named**, not guessed at.

Where it is available it is also *better* than a tap, for two reasons. A tabletop with
radiused corners has no vertex to tap — a human taps the arc and is biased inward by the
radius, while intersecting the extended edges recovers the ideal vertex the
vanishing-point math actually wants. And it works when a corner falls outside the frame,
provided both of its edges are partly visible. On the owner's photos the fitted edges have
an RMS of 0.4–0.8 px over 4032 px, against a 4-tap noise floor quoted at ±2 px.

**Look at `m0-out/overlays/`.** Red is what was measured, green is the tapped quad. Thirty
seconds of looking at ten overlays catches every mistake this harness can make.

---

## 3. What comes out

```
image              region  fov  near/far      ci90  flat%  4tap-vs-depth  4tap noise  after shift-fit
kitchen_20deg.jpg  118402   68*     1.4d  [0.9,2.6]  0.41%          6.2d      +-0.9d             1.8d
```

| column | what it is |
|---|---|
| `region` | pixels measured. Under ~3000 and the row is skipped. |
| `fov` | horizontal field of view; `*` means it came from EXIF rather than a guess. |
| `near/far` | angle between planes fitted to the near half and the far half of the region — `ROADMAP.md`'s metric, computed by the same code as `probe/real_probe.py`. **Measures bend, not orientation.** See §5. |
| `ci90` | 90 % interval on that, by bootstrap over 24×24 px blocks. On a small region this number is high-variance; the interval says how much to trust it. |
| `flat%` | scatter of the surface about its own best-fit plane, as a percentage of the region's extent. |
| `4tap-vs-depth` | **the verdict metric.** Angle between the depth-derived plane and the plane implied by your four taps. |
| `4tap noise` | how far the 4-tap plane itself moves under ±2 px of tap error — the fallback's own error bar. The comparison is depth *versus the fallback*, not depth versus perfection. |
| `after shift-fit` | residual disagreement once one scalar (the additive offset on the model's disparity) is solved for. Small means depth's *shape* is right and only that one number is missing. See §5. |

Everything, plus per-image normals and shift sensitivity, goes to `m0-out/m0.json`.

---

## 4. The verdict

Computed on the **median of `4tap-vs-depth`** across the photos.

| median | verdict |
|---:|---|
| **< 5°** | **BUILD v0.0 as planned.** `RESEARCH.md` §3.4 puts ≤2° at free and 5° at tolerable; depth can carry the plane and the design stands. |
| **5–10°** | **AMBIGUOUS.** Worse than the budget wants, not bad enough to abandon depth. The harness prints what would settle it, cheapest first. |
| **> 10°** | **FALL BACK to a manual 4-tap plane.** A 10° tilt error is 301 mm of trajectory error at 2 s — visibly wrong on screen. Since planar rolling is scale-invariant (`RESEARCH.md` §3.4), four tapped corners fully determine the plane up to a scale that does not matter. Smaller product, one extra interaction, no automatic surface detection — but honest, and it deletes the largest technical risk. |

If no photo has a `quad`, the verdict is **withheld**, not guessed. See §5 for why.

---

## 5. What the near/far number can and cannot see

This is the thing to read before trusting any of it.

Depth Anything V2 emits **affine-invariant** relative inverse depth: the true relation is
`1/depth = a·disp + b`, and both `a` and `b` are unknown per image. `probe/real_probe.py`
— and therefore every plane figure in `RESEARCH.md` §3.3 — assumes `b = 0` and takes
`depth = 1/disp`.

That assumption is load-bearing, and the near/far metric **cannot detect when it is
wrong**. The algebra: with the wrong offset `Δ`, a point on a plane `n·X = d` back-projects
to `X = κ·ray / ((n + κΔ·e_z)·ray)`, which satisfies `n'·X = κ` for `n' = n + κΔ·e_z`. It
is still exactly a plane — just a *rotated* one. So both halves of the region agree
perfectly, and the near/far number reads zero while the plane is wrong.

`./m0/run.sh --selftest` demonstrates this on exact synthetic geometry, no model involved:

```
  offset   true tilt error   near/far metric   flatness
    0.00            0.00d            0.00d     0.000%
    0.20            4.01d            0.00d     0.000%
    0.40            7.61d            0.00d     0.000%
```

And it is not a theoretical concern. On `probe/out/scene.png` — the synthetic tabletop
whose plane `RESEARCH.md` §3.3 reports at **0.03°** — that 0.03° is only reachable *after
a scale-and-shift alignment against ground truth*, which a product does not have. Without
it, `depth = 1/disp` puts the plane **13.5°** off, while the near/far metric reads 0.3°
and the four-tap plane recovers the truth to **0.012°**.

Hence the design of this harness: the near/far column stays, because bend is real and
worth knowing, but the **verdict runs on the 4-tap comparison**, which is the only
orientation-*accuracy* number obtainable from a photograph with no ground truth. The
4-tap plane comes from the horizon line of the tapped rectangle (`n = Kᵀ(v₁ × v₂)`), so it
touches neither the depth map nor the unknown offset.

The same caution applies to `RESEARCH.md` §3.3's conclusion that plane orientation is
robust to the focal length ("FOV 45°→0.5°, 90°→0.9°"). Those are near/far readings. Run
`./m0/run.sh --validate --fov-sweep`: on NYU frames with ground truth, the *true*
orientation error of the depth plane swings by a median of **6.5°** and up to **13.1°**
across an assumed FOV of 40°–100°. Focal length is not free for either method.

### The third path

If `after shift-fit` is small while `4tap-vs-depth` is large, the depth map's shape is
fine and the entire error is that one unknown scalar. Falling back to manual taps is then
the wrong conclusion — the cheaper fixes are, in order:

1. **The phone's gravity vector.** `DeviceOrientation` is free in the browser and, for a
   horizontal table, gives the plane normal outright. This may make the whole question
   moot for the actual product.
2. **A metric-depth model**, which emits true depth with no offset ambiguity.
   `RESEARCH.md` §4 lists browser-runnable CC0/MIT options.
3. **A second visible plane** at a known angle (table + wall), which pins the offset.

The harness prints this branch when it applies.

---

## 6. What has already been measured, and what is still open

Everything below was produced on this machine, reproducible with the commands named.
None of it is the plain-table verdict — that needs the owner's photos.

**Ground truth, real photographs** (`./m0/run.sh --validate`; 8 usable frames of the
NYU Depth V2 subset already in `probe/out/`, regions found automatically by RANSAC on GT
depth, so no hand-tuning):

| quantity | median |
|---|---:|
| **true** plane-orientation error of DAv2-Small, `depth = 1/disp` | **4.8°** (range 1.9–6.7°) |
| the near/far proxy on the same regions | 4.9° |
| correlation between the proxy and the true error | **0.47** |
| error after solving the disparity offset against GT | 3.5° |
| **4-tap plane with 2 px of tap error, same images** | **1.0°** |
| near/far measured on *ground-truth* depth (the metric's own noise floor here) | 3.0° |

Two things to take from that table. First, on real indoor photographs of mostly plain
horizontal surfaces the depth model sits **right at the edge of the 5° budget**, not
comfortably inside it — a very different picture from the 0.5–1.3° in `RESEARCH.md` §3.3.
Second, **the manual fallback is about five times more accurate than the depth model on
the same images**. The fallback is not a consolation prize.

Caveats, stated plainly: NYU frames are 2011 Kinect-era 640×480 RGB of offices and
classrooms, not modern phone photos of the owner's table; the automatically-found regions
mix desktops with floors; and the near/far noise floor of 3.0° on GT depth means small
regions produce noisy readings. This is a strong prior, not the verdict.

**Regression** (`./m0/run.sh --selftest`): `m0/planefit.py` reproduces
`probe/real_probe.py`'s published pool-hall numbers to 0.02° (0.67/1.34/0.48 vs the
published 0.7/1.3/0.5), so the M0 code has not drifted from the code the research round
validated.

**The owner's photos, 2026-09-11** (`./m0/run.sh photos/`; 11 JPEGs of one plain white
office tabletop, iPhone 16 Pro Max, 4032x3024, EXIF intact):

| quantity | median |
|---|---:|
| **`4tap-vs-depth` -- the verdict metric** | **1.9 deg** (range 0.9-5.2) |
| near/far disagreement | 3.3 deg |
| surface flatness | 0.28 % |
| 4-tap noise floor (2 px taps) | 0.1 deg |
| residual after solving the disparity offset | 1.0 deg |

**Verdict: BUILD.** All eleven photos land under the 5 deg budget. This is a markedly
better result than the NYU prior above (4.8 deg), and the reason is visible in the
numbers: the best-fit disparity offset is only 1-11 % of each region's own disparity
range, so `depth = 1/disp` is very nearly right for this geometry. That is a property of
the *configuration* -- a table filling the frame from 40-60 cm has a large disparity
range, which makes the unknown additive offset proportionally small. `shift_sensitivity`
is still ~22 deg per unit of disparity range, so a smaller or more distant surface would
not inherit this result.

Three caveats, in descending order of how much they should worry you:

1. **One surface, one room, one light, one angle.** The camera elevation across all
   eleven photos is 34.8-40.2 deg -- a 5.4 deg spread. Per "Take the photos" above, that
   is one condition measured eleven times, not a distribution. There is also **no
   textured-surface positive control**, so a bad result could not have been attributed.
2. **Every photo is the ultra-wide (0.5x) lens**, EXIF `FocalLengthIn35mmFilm` = 14 mm,
   HFOV 104.3 deg -- outside the 45-90 deg the FOV sweep covered, and against this
   README's own instruction to shoot at 1x. Measured rather than assumed, the *geometric*
   half of that worry is unfounded (see below), but Depth Anything V2 was not trained on
   104 deg imagery and that part cannot be checked from here.
3. The quads were **auto-detected, not hand-tapped** (`m0/autoquad.py`).

**The lens, measured rather than assumed.** Two checks, both from the photos themselves:

- *Distortion.* The tabletop's four edges are physically straight, giving 44 straight
  lines probing out to 91 % of the frame-corner radius. `./m0/lenscheck.py photos/` fits
  one radial coefficient to them: **k1 = -0.001**, RMS 0.33 px versus 0.336 px for a pure
  pinhole -- a 3 % improvement, i.e. none. A genuinely uncorrected ultra-wide
  (k1 ~ -0.05 to -0.2) fits 12-60x *worse*. The phone's ISP has already rectified the
  0.5x lens before writing the JPEG, and `m0/planefit.py`'s pinhole model is valid on
  these files. Re-running the whole gate on undistorted images moves the verdict metric
  1.9 -> 2.1 deg.
- *Focal length.* The top is a rectangle, so the assumed FOV can be checked against the
  photos: sweeping it and asking which value makes all eleven views agree on the table's
  aspect ratio gives **104.5 deg** (aspect 1.581, CV 0.18 %) against EXIF's 104.3 deg.
  The recovered aspect corresponds to a 1200 x 760 mm table. At the harness's old 65 deg
  fallback the recovered aspect would have been 1.06 with 13x the spread.

That second check mattered more than it looks: `fov_from_exif` was reading PIL's IFD0,
where iPhones do not put tag 41989 -- it lives in the Exif sub-IFD. Every row would have
silently read `default` 65 deg. Fixed in `m0/planefit.py`.

Note that the verdict metric is nearly *insensitive* to the assumed FOV (1.8 deg at 90 deg,
2.0 deg at 115 deg) because the depth plane and the 4-tap plane rotate together with it.
The *absolute* orientation is not: it moves ~2 deg per 4 deg of FOV error. Agreement at a
wrong focal length would have been agreement on a wrong plane, which is why the
self-calibration above is load-bearing and not decoration.

**Still open:** other surfaces, other rooms, other lighting, a genuinely varied set of
angles, a textured positive control, and whether a 1x (24 mm) shot -- which is what the
product will actually see, and what the depth model was trained on -- reproduces the
1.9 deg.
