/**
 * The whole pipeline, headless, against an answer that is known.
 *
 * frame -> depth (with a realistic error injected) -> RANSAC plane -> segment the ball ->
 * track the first 0.30 s of a real roll -> fit its velocity on the plane -> 64 rollouts ->
 * does the ball's TRUE resting place land in the 90 % region?
 *
 * This is a proxy for the v0.0 milestone, NOT the milestone. It shares the synthetic
 * world's assumptions -- a perfect sphere, a perfectly flat table, constant deceleration,
 * no motion blur, no rolling resistance that varies across the surface, no camera shake.
 * The real bar is ten rolls on a real table, and only the owner can measure it.
 */
import { test, assert, note } from './harness.js';
import * as S from '../app/src/synth.js';
import * as PF from '../app/src/planefit.js';
import * as G from '../app/src/geometry.js';
import * as Obj from '../app/src/object.js';
import * as Unc from '../app/src/uncertainty.js';
import { Tracker } from '../app/src/tracker.js';
import { gray } from '../app/src/imageops.js';
import * as C from '../app/src/constants.js';

const FPS = 30;
const BALL_R = 0.02;

function rngFactory(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussFrom = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

/** The ball is the only red thing in the scene; this stands in for SlimSAM's mask. */
function redMask(fr) {
  const m = new Uint8Array(fr.w * fr.h);
  for (let i = 0; i < m.length; i++) {
    const r = fr.rgba[4 * i], g = fr.rgba[4 * i + 1];
    if (r - g > 40) m[i] = 1;
  }
  return m;
}

function trial(seed, opts) {
  const r = rngFactory(seed);
  const truth = S.makeScene({ W: 480, H: 360, pitchDeg: opts.pitchDeg ?? 37, hfovDeg: 60 });
  const p0 = [-0.10 + 0.1 * (r() - 0.5), 0.40 + 0.1 * r()];
  const speed = 0.30 + 0.35 * r();
  const ang = Math.PI / 2 + (r() - 0.5) * 1.0;     // mostly away from the camera
  const v0 = [speed * Math.cos(ang), speed * Math.sin(ang)];
  const aTrue = opts.frictionTrue ?? C.FRICTION_DECEL_DEFAULT
    * Math.exp(gaussFrom(r) * C.FRICTION_DECEL_SIGMA_REL);

  // ---- setup frame: the app's view of the world
  const fr0 = S.renderFrame(truth, p0, BALL_R);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < fr0.zbuf.length; i++) {
    const z = fr0.zbuf[i];
    if (isFinite(z) && z < 5) { const d = 1 / z; if (d < mn) mn = d; if (d > mx) mx = d; }
  }
  const disp = S.disparityFrom(fr0, { shift: (opts.offsetFrac ?? 0.11) * (mx - mn) });

  const hfovApp = opts.hfovApp ?? 60;    // 60 = the truth; 68 = the app's default guess
  const K = G.intrinsics(hfovApp, truth.W, truth.H);
  const fit = PF.fitSupportPlane(disp, truth.W, truth.H, K,
    { step: 3, lum: gray(fr0.rgba, fr0.w, fr0.h) });
  if (!fit.ok) return { skipped: 'no plane' };
  const planeErr = G.angleBetween(fit.plane.n, truth.plane.n);

  const mask = redMask(fr0);
  const planeRms = (fit.flatnessPct / 100) * fit.extent;
  const a0 = Obj.analyseMask(mask, truth.W, truth.H, K, fit.plane, disp, planeRms, fit.extent);
  if (!a0.ok) return { skipped: a0.reason };

  // Seed the tracker on the silhouette centre, derived from the contact point.
  const centre0 = G.project(K, G.add(a0.contactCam, G.scale3(fit.plane.n, a0.radiusRel)));
  const tracker = new Tracker(gray(fr0.rgba, fr0.w, fr0.h), fr0.w, fr0.h,
    centre0[0], centre0[1], a0.radiusPx);

  // ---- watch the first OBS_WINDOW_S of the real roll
  const gt = S.groundTruthRoll(p0, v0, aTrue);
  const at = (t) => gt[Math.min(gt.length - 1, Math.round(t * 240))].p;
  const samples = [];
  for (let t = 1 / FPS; t <= C.OBS_WINDOW_S + 1e-9; t += 1 / FPS) {
    const fr = S.renderFrame(truth, at(t), BALL_R);
    const p = tracker.update(gray(fr.rgba, fr.w, fr.h));
    if (!p) return { skipped: 'tracker lost the ball' };
    samples.push({ t, u: p.u, v: p.v });
  }

  const scene = {
    W: truth.W, H: truth.H,
    hfovDeg: hfovApp, hfovSigmaDeg: opts.fovSigma ?? C.HFOV_SIGMA_EXIF_DEG,
    plane: fit.plane, planeSigmaDeg: C.PLANE_SIGMA_INT8_DEG,
    ballPixel: a0.contactPixel, ballRadiusPx: a0.radiusPx, ballRadiusM: BALL_R,
    camHeightM: truth.camH, scaleMode: 'ball',
    frictionA: C.FRICTION_DECEL_DEFAULT,
    frictionSigmaRel: opts.frictionSigma ?? C.FRICTION_DECEL_SIGMA_REL,
    supportMask: null,
  };
  const pred = Unc.predict(scene, { mode: 'track', samples, pixelSigma: 1.0 });
  if (!pred.ok) return { skipped: pred.reason };

  // ---- where it really stopped, in pixels, through the TRUE geometry
  const restTrue = gt[gt.length - 1].p;
  const restCam = G.planeToCam(truth.frame, restTrue);
  const restPx = G.project(truth.K, restCam);
  const inside = Unc.insideEllipse(pred.stopEllipse, restPx[0], restPx[1]);

  const trueDist = Math.hypot(restTrue[0] - p0[0], restTrue[1] - p0[1]);
  // The prediction starts at the END of the observation window, so that is the speed to
  // compare against -- not the speed at t=0.
  const trueSpeed = Math.max(0, Math.hypot(v0[0], v0[1]) - aTrue * C.OBS_WINDOW_S);
  return {
    inside, planeErr, trueSpeed, estSpeed: pred.nominalSpeed,
    trueDist, predDist: pred.stopDistanceM.p50,
    bandCm: 100 * (pred.stopDistanceM.p95 - pred.stopDistanceM.p5),
    aTrue,
  };
}

function run(label, opts, N = 14) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const t = trial(1000 + i * 7, opts);
    if (t.skipped) { out.push({ skipped: t.skipped }); continue; }
    out.push(t);
  }
  const ok = out.filter((t) => !t.skipped);
  const hits = ok.filter((t) => t.inside).length;
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const ds = ok.map((t) => t.estSpeed - t.trueSpeed).sort((a, b) => a - b);
  note(`${label}: ${hits}/${ok.length} inside  |  plane err ${med(ok.map((t) => t.planeErr)).toFixed(1)} deg  |  `
    + `speed err ${(100 * ds[0]).toFixed(1)}..${(100 * ds[ds.length - 1]).toFixed(1)} cm/s  |  `
    + `median ${(100 * med(ds)).toFixed(1)} cm/s  |  `
    + `median band ${med(ok.map((t) => t.bandCm)).toFixed(0)} cm on a ${(100 * med(ok.map((t) => t.trueDist))).toFixed(0)} cm roll`);
  return { hits, n: ok.length, out: ok };
}

test('the tracker follows the ball to better than half a pixel', () => {
  const truth = S.makeScene({ W: 480, H: 360, pitchDeg: 37, hfovDeg: 60 });
  const p0 = [-0.1, 0.42];
  const fr0 = S.renderFrame(truth, p0, BALL_R);
  const tr = new Tracker(gray(fr0.rgba, fr0.w, fr0.h), fr0.w, fr0.h,
    fr0.ballPixel[0], fr0.ballPixel[1], fr0.ballRadiusPx);
  const gt = S.groundTruthRoll(p0, [0.25, 0.5], 0.3);
  let worst = 0;
  for (let t = 1 / FPS; t < 0.8; t += 1 / FPS) {
    const p = gt[Math.min(gt.length - 1, Math.round(t * 240))].p;
    const fr = S.renderFrame(truth, p, BALL_R);
    const got = tr.update(gray(fr.rgba, fr.w, fr.h));
    assert(got, `lost the ball at t=${t.toFixed(2)}`);
    worst = Math.max(worst, Math.hypot(got.u - fr.ballPixel[0], got.v - fr.ballPixel[1]));
  }
  note(`tracker worst error over 0.8 s: ${worst.toFixed(2)} px`);
  assert(worst < 0.5, `worst tracking error ${worst.toFixed(2)} px`);
});

test('with a PERFECT depth map, the recovered speed is unbiased', () => {
  // Everything in the chain -- tracker, plane, the ball-radius scale solve, the rolling
  // model fit -- has to be right for this, and it is the only configuration where the
  // answer should be nearly exact.
  const r = run('velocity, exact depth + exact FOV', { hfovApp: 60, offsetFrac: 0, fovSigma: 0 }, 8);
  // Compared in m/s, not as a ratio: a trial whose ball is nearly stopped by the end of
  // the observation window has a tiny denominator and a meaningless ratio.
  const ds = r.out.map((t) => t.estSpeed - t.trueSpeed).sort((a, b) => a - b);
  const median = ds[ds.length >> 1];
  assert(Math.abs(median) < 0.01, `median speed error ${(100 * median).toFixed(2)} cm/s`);
  assert(ds.every((x) => Math.abs(x) < 0.06),
    `worst speed error ${(100 * ds[0]).toFixed(1)} cm/s -- the spread comes from the tracker's `
    + 'sub-pixel accuracy over a 9-frame window, which ROADMAP.md risk 4 already names as the '
    + 'dominant term in the error budget');
});

test('a realistic depth error costs a few cm/s of speed, systematically low', () => {
  // offsetFrac 0.11 is the largest disparity offset m0.json recorded on the owner's
  // photos, and it turns the plane by 2.9 deg -- the app's quoted 1 sigma. The speed then
  // comes out LOW every time, not scattered: this is a bias, not noise, and it is exactly
  // the kind of error the band has to be wide enough to contain.
  const r = run('velocity, 2.9 deg plane error', { hfovApp: 60, offsetFrac: 0.11, fovSigma: 1 }, 14);
  const ds = r.out.map((t) => t.estSpeed - t.trueSpeed).sort((a, b) => a - b);
  const median = ds[ds.length >> 1];
  assert(median < -0.01, `expected a systematic underestimate, median ${(100 * median).toFixed(2)} cm/s`);
  assert(ds.every((x) => Math.abs(x) < 0.08), 'but bounded');
});

test('PROXY for the 7-of-10 bar, with the focal length known', () => {
  const r = run('7-of-10 proxy, FOV known (photo mode)', { hfovApp: 60, fovSigma: 1 }, 14);
  assert(r.hits / r.n >= 0.7, `${r.hits}/${r.n}`);
});

test('PROXY for the 7-of-10 bar, with the focal length GUESSED at 68 deg', () => {
  // The camera case: the app assumes 68 deg, the world is 60 deg. The plane is wrong by
  // several degrees as a result -- and the band is told so, which is the point.
  const r = run('7-of-10 proxy, FOV assumed 68 vs true 60 (camera mode)',
    { hfovApp: 68, fovSigma: C.HFOV_SIGMA_ASSUMED_DEG }, 14);
  assert(r.hits / r.n >= 0.7, `${r.hits}/${r.n}`);
});

test('and it FAILS when the table is much grippier than assumed and friction is pinned', () => {
  // Pin the friction sigma to the "I measured my table" value but feed it a table 2.2x
  // grippier. The band should miss most of the time: it is a real prediction, not a net.
  const r = run('grippy table, friction sigma pinned to 10 %',
    { hfovApp: 60, fovSigma: 1, frictionTrue: 2.2 * C.FRICTION_DECEL_DEFAULT, frictionSigma: 0.10 }, 10);
  assert(r.hits / r.n < 0.4, `expected mostly misses, got ${r.hits}/${r.n}`);
});
