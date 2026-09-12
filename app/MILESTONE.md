# The 7-of-10 test

`ROADMAP.md` defines v0.0 as done when *"the ghost path is drawn and the real ball, when
actually pushed, ends up inside the band on ≥ 7 of 10 trials on one real table."*

Nothing on this branch measures that. I cannot hold a camera or roll a ball, and no
synthetic result substitutes for it — the synthetic table shares every assumption the app
makes, so it can only ever confirm that the code is self-consistent. **This milestone is
yours to measure, and it takes about twenty minutes.**

---

## What you need

- **The table from the M0 photos.** Not a different one. Everything the app knows about its
  own accuracy comes from eleven photos of that surface, and starting anywhere else mixes
  two unknowns.
- **A table-tennis ball.** 40 mm, which is what the ball-diameter field already says, and
  regulation so you do not have to measure it. Any ball works if you measure its diameter
  and type it in — but it must be a *ball*, not a cylinder or a puck, because the app
  derives the scene's scale from a spherical silhouette.
  It must also be **visually distinct from the table**. The tracker follows a compact blob
  that differs from its surroundings; an orange ball on a white table is ideal, a white ball
  on a white table will report `Lost the ball`.
- **A phone or laptop that can hold still.** Propped against something, leaning on a book,
  anything. If you hold it in your hand the camera-motion detector will withdraw the
  prediction, which is it working correctly and will also end your afternoon.
- **A metre or so of clear table** in the direction you intend to roll.

## Setting up

1. `./app/run.sh`, then press **Camera**. Allow the camera. (On iOS this must be Safari or
   Chrome — an in-app browser inside Instagram or LINE denies the camera silently.
   `ROADMAP.md` risk 7.)

2. **Stand where you stood for the M0 photos.** About 40–60 cm above the top, looking down
   at roughly **35–40°**. The panel prints the elevation it recovered; if it is outside
   34.8–40.2° the app will say the angle has never been tested and widen the band, and your
   ten trials will then be measuring a wider band rather than a better app.

3. Frame the table so it **fills most of the view** and the rolling lane is in shot end to
   end. Keep it bare — the M0 shooting protocol applies unchanged.

4. **1× lens.** Not the ultra-wide. (All eleven M0 photos were 0.5×, which is the one place
   this test deliberately departs from them: 1× is what a user's camera will actually be,
   and it is what the depth model was trained on. If the 1× result is much worse than the
   photos suggested, that is itself the most interesting number of the day.)

5. Set the field of view. If you know your camera's, type it. If not, leave 68° and accept
   a wider band — the panel tells you which you are doing.

6. Press **Set up scene**. Look at the green stipple: **it should cover the tabletop and
   nothing else.** If it spills onto the floor or the wall, the panel will usually say the
   surface could not be separated from its surroundings — press Reset and re-frame so the
   table is more clearly the brightest continuous thing in shot. A wrong plane produces a
   confident wrong answer and the app cannot always tell.

7. Put the ball on the table, press **Tap a real object**, and tap it. Check the panel:
   `mask` should be a few hundred to a few thousand pixels, `local noise` near 1, and the
   little crosshair should sit where the ball touches the table — not at its middle.

## Calibrating the friction first — do not skip this

The friction slider starts at a **guess** of 0.35 m/s², sampled at ±40 %. At that width the
band swallows almost anything, and a 7-of-10 pass would be nearly free.

So run **three throwaway trials** first:

1. Press **Measure a real roll…**, then roll the ball. Roll it along the table with your
   fingers — a push, not a throw, and not a spin. Let it come to rest on its own.
2. The app freezes its prediction 0.30 s into the roll, then waits for the ball to stop.
3. Each row's **â** column is the deceleration your table actually had.

Take the median of those three and set the friction slider to it. Then press **clear**.

Those three trials do not count and the app does not make you pretend they do.

## The ten that count

Ten rolls, same setup, same camera position, nothing touched in between:

- Vary the **direction** — not all ten down the same line. Include one to the left and one
  to the right of straight ahead.
- Vary the **strength**, but keep every roll ending **on the table**. If the ball would
  leave the fitted surface the app discards the trial rather than scoring it, so a roll that
  is too hard costs you a trial rather than failing one.
- Roll, then take your hands out of shot and leave them out until the ball stops.
- If you bump the camera, the prediction is withdrawn and you start over from **Set up
  scene**. Do not try to save the run.

Each trial appears as a row: initial speed, predicted stop distance, actual stop distance,
**band width**, the implied deceleration, and in/out. The summary above it counts
`N / 10 inside the band` and names the bar met or not met.

## Recording it

Press **download trials.json**. It contains every trial with the full set of assumptions
that produced it — the field of view and its source, the plane's elevation, the plane sigma
the band used, the friction you set — plus every constant the build was running.

Then write down, next to the score, **the median band width against the median roll
distance**. Both are in the summary line and in the file.

- **7+ of 10, band comfortably narrower than the roll** → the milestone is met. v0.1 is the
  second object and collisions.
- **7+ of 10, band as wide as the roll** → the app passed its own test by being vague. The
  fix is v0.2, not v0.1: fit friction from the observed motion and report the residual.
- **Under 7 of 10** → the interesting question is *which way* it was wrong. The trial rows
  carry predicted against actual; if the predictions are consistently short or consistently
  long, that is a scale or friction error and it is fixable. If they scatter, it is the
  velocity fit, and `ROADMAP.md` risk 4 already predicted that would dominate.

## What is already known to be wrong before you start

- **Friction is a guess** until you calibrate it, and it dominates the band.
- **The field of view is a guess** on a live camera, worth about 2° of plane tilt per 4°.
- **One camera angle has ever been tested.** 34.8–40.2°, eleven times, one table, one room,
  one light.
- **A moderately warped depth map produces a confidently wrong plane and no diagnostic in
  the app catches it.** `tests/plane-synth.test.js` records this as a known blind spot;
  two candidate detectors were tried and neither separated it from good real data. The green
  stipple is the only defence, which is why step 6 above asks you to look at it.
- **The ball is assumed to roll, not slide or spin.** A ball with side-spin will curve and
  the app has no term for it.
