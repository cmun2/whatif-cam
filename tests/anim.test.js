/**
 * The playhead.
 *
 * The thing being guarded here is not "does it animate". It is that animating must not
 * quietly restore the confidence the rest of the app spends its effort removing: the swarm
 * has to thin out when futures run off the measured surface, and the ball must not sail on
 * across ground the app knows nothing about.
 */
import { test, assert, close, note } from './harness.js';
import { Clock, sampleAtTime } from '../app/src/anim.js';
import * as S from '../app/src/synth.js';
import * as PF from '../app/src/planefit.js';
import * as G from '../app/src/geometry.js';
import * as Unc from '../app/src/uncertainty.js';
import { gray } from '../app/src/imageops.js';
import * as C from '../app/src/constants.js';

// ---------------------------------------------------------------- the clock
test('the clock plays for the prediction\'s real duration and then stops', () => {
  let last = -1;
  const c = new Clock((t) => { last = t; });
  c.reset(1.5, true);
  assert(c.playing, 'should autoplay');
  close(c.t, 0, 0);
  c.advance(1000);                 // first tick only establishes the epoch
  close(c.t, 0, 0);
  // Sixty-hertz frames, as a browser would deliver them.
  for (let k = 1; k <= 120; k++) c.advance(1000 + (k * 1000) / 60);
  close(c.t, 1.5, 1e-9, 'plays for exactly the prediction\'s duration');
  assert(!c.playing, 'should stop at the end, not run on');
  close(last, 1.5, 1e-9);
});

test('a backgrounded tab does not teleport the ball', () => {
  const c = new Clock(() => {});
  c.reset(10, true);
  c.advance(1000);
  c.advance(61000);                // one minute later
  assert(c.t <= 0.1 + 1e-9, `advanced ${c.t} s in one frame`);
});

test('play, pause, replay and seek behave', () => {
  const c = new Clock(() => {});
  c.reset(2, false);
  assert(!c.playing);
  c.play(); assert(c.playing);
  c.pause(); assert(!c.playing);
  c.seek(1.25); close(c.t, 1.25, 0); assert(!c.playing, 'seeking pauses');
  c.seek(99); close(c.t, 2, 0, 'seek clamps to the end');
  c.seek(-5); close(c.t, 0, 0, 'and to the start');
  c.t = 2; c.play(); close(c.t, 0, 0, 'play from the end restarts');
  c.t = 1; c.replay(); close(c.t, 0, 0); assert(c.playing);
});

test('prefers-reduced-motion means it does not start on its own', () => {
  const saved = globalThis.matchMedia;
  globalThis.matchMedia = (q) => ({ matches: q.includes('reduced-motion') });
  try {
    const c = new Clock(() => {});
    c.reset(2, true);
    assert(!c.playing, 'must not autoplay under reduced motion');
    c.play();
    assert(c.playing, 'but an explicit press still works');
  } finally {
    if (saved) globalThis.matchMedia = saved; else delete globalThis.matchMedia;
  }
});

// ---------------------------------------------------------------- interpolation
test('sampleAtTime interpolates, clamps, and refuses after a future has left', () => {
  const times = [0, 1, 2];
  const px = [[0, 0], [10, 20], [20, 40]];
  close(sampleAtTime(px, times, 0.5, null)[0], 5, 1e-9);
  close(sampleAtTime(px, times, 0.5, null)[1], 10, 1e-9);
  close(sampleAtTime(px, times, 1.75, null)[0], 17.5, 1e-9);
  close(sampleAtTime(px, times, -1, null)[0], 0, 0);
  close(sampleAtTime(px, times, 99, null)[0], 20, 0);
  assert(sampleAtTime(px, times, 1.2, 1.0) === null, 'past its leave time it must vanish');
  assert(sampleAtTime(px, times, 0.9, 1.0) !== null, 'before it, it must not');
});

// ---------------------------------------------------------------- the honest part
/**
 * A prediction on the synthetic table, using the app's own support mask, at a chosen flick
 * strength and friction. Weak + grippy stays on the table; hard + slippery runs off it.
 */
function predictFlick(dragPx, frictionA) {
  const scene = S.makeScene({ pitchDeg: 37 });
  const ballR = 0.02;
  const fr = S.renderFrame(scene, [-0.1, 0.42], ballR);
  const fit = PF.fitSupportPlane(S.disparityFrom(fr), scene.W, scene.H, scene.K,
    { step: 3, lum: gray(fr.rgba, fr.w, fr.h) });
  const mask = PF.supportMaskFrom(fit, scene.W, scene.H);
  const r = G.ray(scene.K, fr.ballPixel[0], fr.ballPixel[1]);
  const den = G.dot(r, fit.plane.n);
  const rRel = (fr.ballRadiusPx * (fit.plane.d / den)) / scene.K.fx;
  const t = (fit.plane.d + rRel) / den;
  const X = G.sub(G.scale3(r, t), G.scale3(fit.plane.n, rRel));
  return Unc.predict({
    W: scene.W, H: scene.H, hfovDeg: scene.hfov, hfovSigmaDeg: 1,
    plane: fit.plane, planeSigmaDeg: C.PLANE_SIGMA_INT8_DEG,
    ballPixel: G.project(scene.K, X), ballRadiusPx: fr.ballRadiusPx, ballRadiusM: ballR,
    camHeightM: scene.camH, scaleMode: 'ball',
    frictionA, frictionSigmaRel: C.FRICTION_DECEL_SIGMA_REL,
    supportMask: mask,
  }, {
    mode: 'flick',
    releasePixel: [fr.ballPixel[0] + dragPx, fr.ballPixel[1] - Math.round(dragPx * 0.36)],
    pixelSigma: 2,
  });
}
const RUNS_OFF = () => predictFlick(200, 0.15);
const STAYS_ON = () => predictFlick(80, 0.35);

test('the ball starts ON the surface -- its own mask must not punch a hole in it', () => {
  // The object is not a plane inlier, so it leaves a ball-sized gap in the middle of the
  // fitted surface. Before the mask filled enclosed holes, a gentle roll was declared off
  // the measured surface on its first step and no prediction was produced at all.
  const pred = predictFlick(60, 0.35);
  assert(pred.ok, pred.reason);
  assert(pred.leftSurfaceFraction < 0.2,
    `${(100 * pred.leftSurfaceFraction).toFixed(0)} % of futures left immediately`);
});

test('a roll that leaves the measured surface is marked, not carried on', () => {
  const pred = RUNS_OFF();
  assert(pred.ok, pred.reason);
  assert(pred.leftSurfaceFraction > 0.5, `only ${pred.leftSurfaceFraction} left the surface`);
  assert(!pred.hasStop, 'there must be no stop region to claim');
  assert(pred.stopEllipse === null, 'and no ellipse to draw');
  assert(isFinite(pred.nominalLeftAt), 'the moment it leaves must be known');
  assert(pred.nominalLeftAt < pred.times[pred.times.length - 1],
    'and it must be before the end of the playback');
  note(`leaves the measured surface at t = ${pred.nominalLeftAt.toFixed(2)} s of a `
    + `${pred.times[pred.times.length - 1].toFixed(2)} s playback`);
});

test('the swarm thins out as futures run off the surface -- it does not stack up at the edge', () => {
  const pred = RUNS_OFF();
  const times = pred.times;
  const end = times[times.length - 1];
  const aliveAt = (t) => pred.samplePixels
    .filter((px, i) => sampleAtTime(px, times, t, pred.sampleLeftAt[i]) !== null).length;
  const a0 = aliveAt(0), aMid = aliveAt(end / 2), aEnd = aliveAt(end);
  assert(a0 === pred.samplePixels.length, 'all futures start on the surface');
  assert(aMid < a0, `the swarm must thin: ${a0} -> ${aMid}`);
  assert(aEnd < aMid, `and keep thinning: ${aMid} -> ${aEnd}`);
  // Monotone: a future that has left never comes back.
  let prev = Infinity;
  for (let k = 0; k <= 40; k++) {
    const n = aliveAt((end * k) / 40);
    assert(n <= prev, 'a future that left the surface must not reappear');
    prev = n;
  }
  note(`futures still on the surface: ${a0} at t=0, ${aMid} at halfway, ${aEnd} at the end`);
});

test('a roll that stays on the table keeps its whole ensemble and gets a stop region', () => {
  const pred = STAYS_ON();
  assert(pred.ok, pred.reason);
  assert(pred.hasStop, 'this one should have a stop region');
  assert(!isFinite(pred.nominalLeftAt), 'and never leave the surface');
  const end = pred.times[pred.times.length - 1];
  const alive = pred.samplePixels
    .filter((px, i) => sampleAtTime(px, pred.times, end, pred.sampleLeftAt[i]) !== null).length;
  assert(alive > 0.9 * pred.samplePixels.length,
    `only ${alive} of ${pred.samplePixels.length} survived`);
  note(`soft roll: ${alive} of ${pred.samplePixels.length} futures still on the surface at the end`);
});

test('the swarm is the band: its spread at the end matches the 90 % stop region', () => {
  // If these two ever disagree, the animation is showing a different uncertainty from the
  // one the numbers report, and the moving picture would be the more persuasive lie.
  const pred = STAYS_ON();
  const end = pred.times[pred.times.length - 1];
  const pts = pred.samplePixels
    .map((px, i) => sampleAtTime(px, pred.times, end, pred.sampleLeftAt[i]))
    .filter(Boolean);
  let inside = 0;
  for (const p of pts) if (Unc.insideEllipse(pred.stopEllipse, p[0], p[1])) inside++;
  const frac = inside / pts.length;
  assert(frac > 0.8 && frac <= 1.0, `${(100 * frac).toFixed(0)} % of the swarm is inside its own 90 % region`);
  note(`${(100 * frac).toFixed(0)} % of the played swarm ends inside the drawn 90 % stop region`);
});

test('the playback reports the ensemble\'s spread in centimetres, and it grows', () => {
  // The guard against the animation out-shouting the band: at every instant the readout
  // says how far apart the futures are, in units a person can picture. If the moving ball
  // is persuasive, this number is what it has to be persuasive against.
  const pred = STAYS_ON();
  const times = pred.times;
  const end = times[times.length - 1];
  assert(pred.samplePlaneM && pred.samplePlaneM.length === pred.samplePixels.length,
    'in-plane positions must be published alongside the pixels');
  const spreadAt = (t) => {
    const ds = pred.samplePlaneM
      .map((px, i) => {
        const q = sampleAtTime(px, times, t, pred.sampleLeftAt[i]);
        return q ? Math.hypot(q[0] - px[0][0], q[1] - px[0][1]) : null;
      })
      .filter((x) => x != null)
      .sort((a, b) => a - b);
    return 100 * (ds[Math.round(0.95 * (ds.length - 1))] - ds[Math.round(0.05 * (ds.length - 1))]);
  };
  const s0 = spreadAt(0), sMid = spreadAt(end / 2), sEnd = spreadAt(end);
  close(s0, 0, 1e-6, 'they all start together');
  assert(sMid > s0 && sEnd > sMid, `spread must grow: ${s0} -> ${sMid} -> ${sEnd}`);
  note(`spread shown during playback: ${s0.toFixed(0)} cm at t=0, ${sMid.toFixed(0)} cm halfway, `
    + `${sEnd.toFixed(0)} cm at the end`);
});

test('the spread at the end agrees with the stop distance interval in the panel', () => {
  // Two numbers computed by different code paths from the same ensemble. If they ever
  // disagree the screen is telling the viewer two different stories at once.
  const pred = STAYS_ON();
  const end = pred.times[pred.times.length - 1];
  const ds = pred.samplePlaneM
    .map((px, i) => {
      const q = sampleAtTime(px, pred.times, end, pred.sampleLeftAt[i]);
      return q ? Math.hypot(q[0] - px[0][0], q[1] - px[0][1]) : null;
    })
    .filter((x) => x != null)
    .sort((a, b) => a - b);
  const played = ds[Math.round(0.95 * (ds.length - 1))] - ds[Math.round(0.05 * (ds.length - 1))];
  const panel = pred.stopDistanceM.p95 - pred.stopDistanceM.p5;
  assert(Math.abs(played - panel) < 0.05,
    `playback says ${(100 * played).toFixed(0)} cm, the panel says ${(100 * panel).toFixed(0)} cm`);
});
