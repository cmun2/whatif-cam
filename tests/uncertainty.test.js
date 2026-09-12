/**
 * The band is the product. These tests ask whether it is a real distribution or a ribbon.
 *
 * The distinction that matters and is easy to miss: a band can be SELF-CONSISTENT (if the
 * world is drawn from the assumptions the app samples, the truth lands inside 90 % of the
 * time) without being CALIBRATED TO REALITY (a real table's friction is whatever it is).
 * Only the first is testable here. The second is the 7-of-10 milestone, and it needs a
 * ball.
 */
import { test, assert, close, note } from './harness.js';
import * as S from '../app/src/synth.js';
import * as PF from '../app/src/planefit.js';
import * as G from '../app/src/geometry.js';
import * as Unc from '../app/src/uncertainty.js';
import * as C from '../app/src/constants.js';

function build(opts = {}) {
  const scene = S.makeScene({ pitchDeg: opts.pitchDeg ?? 37 });
  const ballR = 0.02;
  const p0 = opts.p0 ?? [-0.1, 0.5];
  const fr = S.renderFrame(scene, p0, ballR);
  const fit = PF.fitSupportPlane(S.disparityFrom(fr), scene.W, scene.H, scene.K, { step: 3 });
  // Contact point and pixel radius as the app would derive them from the rendered ball.
  const contact3 = G.sub(
    G.scale3(G.ray(scene.K, fr.ballPixel[0], fr.ballPixel[1]), 0), [0, 0, 0]);
  void contact3;
  const centre = fr.ballPixel;
  const r = G.ray(fit.plane ? scene.K : scene.K, centre[0], centre[1]);
  const den = G.dot(r, fit.plane.n);
  const rRelGuess = (fr.ballRadiusPx * ((fit.plane.d) / den)) / scene.K.fx;
  const t = (fit.plane.d + rRelGuess) / den;
  const X = G.sub(G.scale3(r, t), G.scale3(fit.plane.n, rRelGuess));
  const contactPixel = G.project(scene.K, X);
  return {
    truthScene: scene, fit, ballR,
    scene: {
      W: scene.W, H: scene.H,
      hfovDeg: opts.hfov ?? scene.hfov, hfovSigmaDeg: opts.fovSigma ?? C.HFOV_SIGMA_ASSUMED_DEG,
      plane: fit.plane, planeSigmaDeg: opts.planeSigma ?? C.PLANE_SIGMA_INT8_DEG,
      ballPixel: contactPixel, ballRadiusPx: fr.ballRadiusPx, ballRadiusM: ballR,
      camHeightM: scene.camH, scaleMode: 'ball',
      frictionA: opts.friction ?? C.FRICTION_DECEL_DEFAULT,
      frictionSigmaRel: opts.frictionSigma ?? C.FRICTION_DECEL_SIGMA_REL,
      supportMask: null,
    },
    launch: { mode: 'flick', releasePixel: opts.release ?? [fr.ballPixel[0] + 90, fr.ballPixel[1] - 30], pixelSigma: 2 },
  };
}

test('the band widens with time instead of being a constant-width ribbon', () => {
  const b = build();
  const pred = Unc.predict(b.scene, b.launch);
  assert(pred.ok, pred.reason);
  // Width, measured as the distance between the two sides of the polygon at each step.
  const M = pred.meanPixels.length;
  const w = [];
  for (let j = 0; j < M; j++) {
    const l = pred.bandPolygon[j], r = pred.bandPolygon[2 * M - 1 - j];
    if (l && r) w.push(Math.hypot(l[0] - r[0], l[1] - r[1]));
  }
  close(w[0], 0, 3, 'the band starts narrow');
  assert(w[w.length - 1] > 4 * Math.max(1, w[0]), 'the band must grow');
  let rising = 0;
  for (let i = 1; i < w.length; i++) if (w[i] >= w[i - 1] - 0.5) rising++;
  assert(rising > 0.85 * w.length, `the band should grow monotonically, ${rising}/${w.length}`);
  note(`band width 0 -> ${w[w.length - 1].toFixed(0)} px over ${pred.times[pred.times.length - 1].toFixed(2)} s`);
});

const ellipseArea = (p) => Math.PI * p.stopEllipse.rx * p.stopEllipse.ry;
const alongTrack = (p) => 2 * Math.max(p.stopEllipse.rx, p.stopEllipse.ry);

test('a worse plane makes a wider band -- ALONG the path, not across it', () => {
  // Measured while writing these tests, and worth knowing: plane-tilt error moves the
  // prediction mostly ALONG the roll, hardly at all sideways. The reason is the same one
  // m0/README.md section 6 gives for the verdict metric being insensitive to the assumed
  // FOV -- the ball's start, the flick's direction and the ball's scale are all read off
  // the SAME wrong plane, so they rotate together and the screen-space path is partly
  // self-correcting. What does not cancel is the metric scale, so the distance moves.
  //
  // Friction has to be pinned down for any of this to be visible, which is the point of
  // the test below it.
  const wide = alongTrack(Unc.predict(build({ planeSigma: 8, frictionSigma: 0.05 }).scene,
    build({ planeSigma: 8, frictionSigma: 0.05 }).launch));
  const tight = alongTrack(Unc.predict(build({ planeSigma: 0.5, frictionSigma: 0.05 }).scene,
    build({ planeSigma: 0.5, frictionSigma: 0.05 }).launch));
  // Only ~14 %. That is small, and it is the correct answer, not a weak test: the
  // ball-diameter scale error alone is worth more than 8 deg of plane tilt here.
  assert(wide > 1.10 * tight, `along-track ${tight.toFixed(1)} -> ${wide.toFixed(1)} px`);
  note(`stop region length, plane sigma 0.5 deg: ${tight.toFixed(0)} px, 8 deg: ${wide.toFixed(0)} px`);
});

test('a worse field-of-view guess makes a wider band', () => {
  const a = build({ fovSigma: 1, frictionSigma: 0.05 });
  const c = build({ fovSigma: 16, frictionSigma: 0.05 });
  const pa = Unc.predict(a.scene, a.launch), pc = Unc.predict(c.scene, c.launch);
  assert(alongTrack(pc) > 1.30 * alongTrack(pa),
    `${alongTrack(pa).toFixed(1)} -> ${alongTrack(pc).toFixed(1)} px`);
  note(`stop region length, FOV sigma 1 deg: ${alongTrack(pa).toFixed(0)} px, `
    + `16 deg: ${alongTrack(pc).toFixed(0)} px`);
});

test('at the DEFAULT friction uncertainty, neither of those is visible at all', () => {
  // The honest ordering of the error budget on this scene: friction swamps everything.
  const base = (o) => ellipseArea(Unc.predict(build(o).scene, build(o).launch));
  const none = base({ planeSigma: 0, fovSigma: 0, frictionSigma: 0 });
  const plane = base({ planeSigma: 8, fovSigma: 0, frictionSigma: 0 });
  const fov = base({ planeSigma: 0, fovSigma: 16, frictionSigma: 0 });
  const fric = base({ planeSigma: 0, fovSigma: 0, frictionSigma: 0.4 });
  note(`stop-region area: scale alone ${none.toFixed(0)}, +8 deg plane ${plane.toFixed(0)}, `
    + `+16 deg FOV ${fov.toFixed(0)}, +40 % friction ${fric.toFixed(0)} px^2`);
  assert(fric > 4 * plane && fric > 3 * fov,
    'friction should dominate both -- if it no longer does, the ordering in the README is stale');
});

test('friction alone, with perfect geometry, still makes a wide band -- it dominates', () => {
  const b = build({ planeSigma: 0, fovSigma: 0 });
  const pred = Unc.predict(b.scene, b.launch);
  const spread = pred.stopDistanceM.p95 - pred.stopDistanceM.p5;
  assert(spread > 0.25 * pred.stopDistanceM.p50,
    `even with an exact camera and plane the spread is ${(100 * spread).toFixed(0)} cm`);
  note(`perfect geometry, friction guessed: stop distance ${(100 * pred.stopDistanceM.p50).toFixed(0)} cm `
    + `+/- ${(100 * spread / 2).toFixed(0)} cm. This is why v0.2 exists.`);
});

test('the prediction is deterministic -- the same scene gives the same band', () => {
  const b = build();
  const a = Unc.predict(b.scene, b.launch);
  const c = Unc.predict(b.scene, b.launch);
  close(a.stopEllipse.cx, c.stopEllipse.cx, 0);
  close(a.stopEllipse.rx, c.stopEllipse.rx, 0);
  close(a.stopDistanceM.p50, c.stopDistanceM.p50, 0);
});

test('the nominal stop point is inside its own 90 % region', () => {
  for (const pitch of [30, 37, 45]) {
    const b = build({ pitchDeg: pitch });
    const p = Unc.predict(b.scene, b.launch);
    assert(Unc.insideEllipse(p.stopEllipse, p.nominalStopPx[0], p.nominalStopPx[1]),
      `nominal outside its own band at ${pitch} deg`);
  }
});

test('SELF-CONSISTENCY: a world drawn from the app\'s own assumptions lands inside ~90 %', () => {
  // Draw a "true world" from exactly the distributions the band samples, compute where the
  // ball really goes in that world, and ask whether the 90 % region contains it.
  const b = build();
  const pred = Unc.predict(b.scene, b.launch);
  let rng = 424242;
  const rand = () => {
    rng = (Math.imul(rng ^ (rng >>> 15), 1 | rng) + 0x6d2b79f5) | 0;
    return ((rng ^ (rng >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
  let hits = 0;
  const N = 300;
  for (let i = 0; i < N; i++) {
    const draw = {
      dFov: gauss() * b.scene.hfovSigmaDeg,
      tiltDeg: Math.abs(gauss()) * b.scene.planeSigmaDeg,
      tiltAz: rand() * 2 * Math.PI,
      ballRadiusM: b.scene.ballRadiusM * (1 + gauss() * C.BALL_DIAMETER_SIGMA_REL),
      camHeightM: b.scene.camHeightM,
      friction: b.scene.frictionA * Math.exp(gauss() * C.FRICTION_DECEL_SIGMA_REL),
      relU: gauss() * 2, relV: gauss() * 2, trackNoise: 0, speedFactor: 1,
    };
    const r = Unc.rolloutOnce(b.scene, b.launch, draw);
    if (!r) continue;
    const px = r.toPixel(r.traj.p[r.traj.p.length - 1]);
    if (px && Unc.insideEllipse(pred.stopEllipse, px[0], px[1])) hits++;
  }
  const rate = hits / N;
  note(`self-consistency coverage: ${(100 * rate).toFixed(0)} % of 300 draws inside the 90 % region`);
  assert(rate > 0.80 && rate < 0.99, `coverage ${(100 * rate).toFixed(0)} % is not ~90 %`);
});

function landsOutside(frictionSigma, frictionErrorFactor) {
  const b = build({ frictionSigma });
  const pred = Unc.predict(b.scene, b.launch);
  const r = Unc.rolloutOnce(b.scene, b.launch, {
    dFov: 0, tiltDeg: 0, tiltAz: 0,
    ballRadiusM: b.scene.ballRadiusM, camHeightM: b.scene.camHeightM,
    friction: b.scene.frictionA * frictionErrorFactor,
    relU: 0, relV: 0, trackNoise: 0, speedFactor: 1,
  });
  const px = r.toPixel(r.traj.p[r.traj.p.length - 1]);
  return !Unc.insideEllipse(pred.stopEllipse, px[0], px[1]);
}

test('HONEST LIMIT: with friction merely guessed, a 3x error still lands INSIDE the band', () => {
  // This is not a bug to fix by narrowing the band -- friction genuinely is not known -- but
  // it is the thing that makes a 7-of-10 pass cheap. Passing with a band this wide proves
  // very little, which is why the app records the band width next to every trial and why
  // fitting friction is v0.2.
  assert(!landsOutside(C.FRICTION_DECEL_SIGMA_REL, 3),
    'if this now fails, the default friction sigma was narrowed -- check that it was earned');
  note('friction sigma 40 % (the default): a 3x friction error is still inside the 90 % region');
});

test('once friction is measured, the band becomes falsifiable', () => {
  assert(landsOutside(C.FRICTION_SIGMA_MEASURED, 3), 'a 3x error must fall outside at 10 % sigma');
  assert(landsOutside(C.FRICTION_SIGMA_MEASURED, 1.8), 'an 80 % error must fall outside at 10 % sigma');
  assert(!landsOutside(C.FRICTION_SIGMA_MEASURED, 1.1), 'a 10 % error should still be inside');
  note('friction sigma 10 % (after measuring the table): 3x and 1.8x fall outside, 1.1x inside');
});
