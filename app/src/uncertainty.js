/**
 * The uncertainty band.
 *
 * ARCHITECTURE.md: "R8 is not satisfied by printing Confidence: medium." So the band is
 * not decoration and not a fixed percentage of the path length. It is the actual spread
 * of the actual prediction when every quantity the app had to assume is re-sampled from
 * the range it is genuinely known to within:
 *
 *   plane tilt   sigma from m0-out/m0.json, re-measured for the int8 model (2.9 deg)
 *   field of view sigma from "we do not know what camera this is" (8 deg assumed)
 *   friction      the widest term, and entirely a guess until v0.2 fits it
 *   scale         the ball diameter the user typed, plus the mask's radius error
 *   the flick     pixel noise on where the drag was released, or the residual of the
 *                 velocity fit in Measure mode
 *
 * Each sample re-derives the camera, the plane, the contact point, the metric scale and
 * the initial velocity from scratch, then rolls the ball. Nothing is linearised.
 */
import {
  intrinsics, planeFrame, tiltPlane, pixelToPlane, planeToPixel, rayPlane, ray, camToPlane, ballRadiusRel,
} from './geometry.js';
import { roll, sampleAt } from './sim.js';
import * as C from './constants.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * One rollout under one draw of the assumptions.
 * `scene` carries the nominal values; `draw` the perturbations.
 */
/** Why the most recent rolloutOnce returned null. Read by predict() to explain itself. */
let lastFailure = 'geometry';

export function rolloutOnce(scene, launch, draw) {
  lastFailure = 'geometry';
  const hfov = scene.hfovDeg + draw.dFov;
  const K = intrinsics(hfov, scene.W, scene.H);

  // A wrong focal length rotates the plane in the pitch sense at a measured ~0.5 deg per
  // degree (m0/README.md section 6). Apply that deterministically, then the model's own
  // error about a random axis on top.
  let plane = tiltPlane(scene.plane, C.PLANE_TILT_PER_FOV_DEG * draw.dFov, 0);
  plane = tiltPlane(plane, draw.tiltDeg, draw.tiltAz);
  const frame = planeFrame(plane);

  const contact = rayPlane(K, plane, scene.ballPixel[0], scene.ballPixel[1]);
  if (!contact) return null;
  const zc = contact[2];
  // Metres per relative unit -- the ONLY place metres enter the system. Two sources:
  //   'ball'   a real object of known diameter, measured in pixels. The good one.
  //   'height' the camera's stated height above the table. Used when the ball is virtual,
  //            e.g. dropped onto a photo of a bare table, and much weaker.
  let scaleM, rRel;
  if (scene.scaleMode === 'height') {
    const dAbs = Math.abs(plane.d);
    if (!(dAbs > 1e-9)) return null;
    scaleM = draw.camHeightM / dAbs;
    rRel = draw.ballRadiusM / scaleM;
  } else {
    rRel = ballRadiusRel(scene.ballRadiusPx, zc, K.fx, plane.n[2]);
    if (!(rRel > 1e-9)) { lastFailure = 'scale'; return null; }
    scaleM = draw.ballRadiusM / rRel;
  }

  const toPlaneM = (u, v) => {
    const q = pixelToPlane(K, plane, frame, u, v);
    return q ? [q[0] * scaleM, q[1] * scaleM] : null;
  };

  /**
   * A tracked ball is followed by its SILHOUETTE CENTRE, which is one radius above the
   * table -- unprojecting it straight onto the plane would put the ball systematically
   * too far from the camera, by about a radius. ROADMAP.md risk 3 is this error in its
   * other guise. The centre lies on the parallel plane n.X = d + r, so intersect that
   * instead and step back down the normal to the contact point. No approximation.
   */
  const centreToPlaneM = (u, v) => {
    const r = ray(K, u, v);
    const den = r[0] * plane.n[0] + r[1] * plane.n[1] + r[2] * plane.n[2];
    if (Math.abs(den) < 1e-9) return null;
    const t = (plane.d + rRel) / den;
    if (!(t > 0) || !isFinite(t)) return null;
    const X = [r[0] * t - plane.n[0] * rRel, r[1] * t - plane.n[1] * rRel, r[2] * t - plane.n[2] * rRel];
    const q = camToPlane(frame, X);
    return [q[0] * scaleM, q[1] * scaleM];
  };
  const toPixel = (pm) => planeToPixel(K, frame, [pm[0] / scaleM, pm[1] / scaleM]);

  const p0 = toPlaneM(scene.ballPixel[0], scene.ballPixel[1]);
  if (!p0) return null;

  let start = p0, vel;
  if (launch.mode === 'flick') {
    const q = toPlaneM(launch.releasePixel[0] + draw.relU, launch.releasePixel[1] + draw.relV);
    if (!q) return null;
    const dx = q[0] - p0[0], dy = q[1] - p0[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) return null;
    let speed = len / C.FLICK_TIME_CONSTANT_S;
    speed = Math.min(speed, C.FLICK_MAX_SPEED) * draw.speedFactor;
    vel = [(dx / len) * speed, (dy / len) * speed];
  } else if (launch.mode === 'track') {
    // Fitting a STRAIGHT LINE to the observed positions returns the average speed over the
    // window, which for a decelerating roll is the speed at its midpoint -- about
    // a*(window/2) slower than the speed at its end, where the prediction starts. On a
    // 0.30 s window at 0.35 m/s^2 that is 5 cm/s, a 13 % underestimate of a 0.4 m/s roll
    // and a 25 % underestimate of the distance. Measured in tests/endtoend.test.js.
    //
    // So fit the model we are actually going to integrate: a straight line in space, with
    // constant deceleration along it. Direction comes from the plain line fit; the speed
    // comes from regressing (distance along the line + a*t^2/2) on t, which is exactly
    // linear under this model. Each Monte-Carlo sample uses its OWN sampled `a` here, so
    // the friction uncertainty propagates into the velocity too, as it should.
    const pts = [];
    for (const s of launch.samples) {
      const q = centreToPlaneM(s.u + draw.trackNoise * s.nu, s.v + draw.trackNoise * s.nv);
      if (q) pts.push({ t: s.t, p: q });
    }
    if (pts.length < 3) return null;
    const n = pts.length;
    let st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
    for (const s of pts) {
      st += s.t; stt += s.t * s.t; sx += s.p[0]; sy += s.p[1];
      stx += s.t * s.p[0]; sty += s.t * s.p[1];
    }
    const den = n * stt - st * st;
    if (Math.abs(den) < 1e-12) return null;
    const lvx = (n * stx - st * sx) / den, lvy = (n * sty - st * sy) / den;
    const lsp = Math.hypot(lvx, lvy);
    if (!(lsp > 1e-9)) { lastFailure = 'velocity'; return null; }
    const ux = lvx / lsp, uy = lvy / lsp;              // direction of travel
    const px0 = sx / n, py0 = sy / n;                  // centroid, as the line's anchor

    let sy2 = 0, sty2 = 0;
    for (const s of pts) {
      const along = (s.p[0] - px0) * ux + (s.p[1] - py0) * uy;
      const y = along + 0.5 * draw.friction * s.t * s.t;
      sy2 += y; sty2 += s.t * y;
    }
    const v0fit = (n * sty2 - st * sy2) / den;         // speed at t = 0
    const s0fit = (sy2 - v0fit * st) / n;              // along-track offset at t = 0
    const tRef = pts[pts.length - 1].t;
    const vRef = v0fit - draw.friction * tRef;         // speed where the prediction starts
    if (!(vRef > 0)) { lastFailure = 'stopped'; return null; }
    const alongRef = s0fit + v0fit * tRef - 0.5 * draw.friction * tRef * tRef;
    // Perpendicular offset of the fitted line from the centroid is zero by construction,
    // so the start point is the anchor plus the along-track distance.
    start = [px0 + ux * alongRef, py0 + uy * alongRef];
    vel = [ux * vRef * draw.speedFactor, uy * vRef * draw.speedFactor];
  } else {
    return null;
  }

  // "Off the measured surface" is decided against the pixels the plane was actually
  // fitted to. Past that boundary nothing about this scene has been measured, so the
  // rollout stops rather than extrapolating over an edge it cannot see.
  const onSurface = scene.supportMask
    ? (x, y) => {
        const q = toPixel([x, y]);
        if (!q) return false;
        const u = Math.round(q[0]), v = Math.round(q[1]);
        if (u < 0 || v < 0 || u >= scene.W || v >= scene.H) return false;
        return !!scene.supportMask[v * scene.W + u];
      }
    : null;

  const traj = roll(start, vel, draw.friction, { onSurface });
  return { traj, toPixel, speed: Math.hypot(vel[0], vel[1]), scaleM, plane, K };
}

function drawFrom(rng, scene, launch, i) {
  const speedSigma = launch.mode === 'track' ? 0.0 : 0.0;
  return {
    dFov: i === 0 ? 0 : gauss(rng) * scene.hfovSigmaDeg,
    tiltDeg: i === 0 ? 0 : Math.abs(gauss(rng)) * scene.planeSigmaDeg,
    tiltAz: rng() * 2 * Math.PI,
    ballRadiusM: (i === 0 ? 1 : 1 + gauss(rng) * C.BALL_DIAMETER_SIGMA_REL) * (scene.ballRadiusM || 0.02),
    camHeightM: (i === 0 ? 1 : 1 + gauss(rng) * C.CAM_HEIGHT_SIGMA_REL) * (scene.camHeightM || C.CAM_HEIGHT_M_DEFAULT),
    friction: i === 0 ? scene.frictionA
      : scene.frictionA * Math.exp(gauss(rng) * (scene.frictionSigmaRel ?? C.FRICTION_DECEL_SIGMA_REL)),
    relU: i === 0 ? 0 : gauss(rng) * (launch.pixelSigma ?? 2),
    relV: i === 0 ? 0 : gauss(rng) * (launch.pixelSigma ?? 2),
    trackNoise: i === 0 ? 0 : 1,
    speedFactor: i === 0 ? 1 : 1 + gauss(rng) * speedSigma,
  };
}

/**
 * Run the ensemble. Sample 0 is always the unperturbed nominal prediction -- that is the
 * line drawn as "prediction"; every other sample is a draw and together they are the band.
 */
export function predict(scene, launch, opts = {}) {
  const N = opts.samples ?? C.MC_SAMPLES;
  const rng = mulberry32(opts.seed ?? 7);
  const runs = [];
  const why = { geometry: 0, stopped: 0, tooFew: 0 };
  for (let i = 0; i < N; i++) {
    const d = drawFrom(rng, scene, launch, i);
    if (launch.mode === 'track') {
      // Fixed per-sample pixel jitter pattern, drawn once so the fit is perturbed
      // coherently rather than re-randomised inside the loop.
      for (const s of launch.samples) {
        s.nu = i === 0 ? 0 : gauss(rng) * (launch.pixelSigma ?? 1);
        s.nv = i === 0 ? 0 : gauss(rng) * (launch.pixelSigma ?? 1);
      }
    }
    const r = rolloutOnce(scene, launch, d);
    if (r) runs.push(r); else why[lastFailure] = (why[lastFailure] || 0) + 1;
  }
  if (runs.length < 8) {
    const reasons = {
      geometry: 'the ball, or the point you flicked towards, does not sit on the fitted plane in front of the camera',
      stopped: 'the ball had already all but stopped by the end of the observation window, so there is no roll left to predict',
      velocity: 'no usable direction of travel could be fitted to the observed motion',
      scale: 'the scene has no usable metric scale: the ball\'s size on the plane could not be solved',
    };
    return { ok: false, reason: (reasons[lastFailure] || 'the geometry did not resolve')
      + ` (${runs.length} of ${N} sampled futures survived)` };
  }

  const nominal = runs[0];
  const tEnd = Math.max(...runs.map((r) => r.traj.t[r.traj.t.length - 1]));
  const M = 48;
  const times = Array.from({ length: M }, (_, j) => (tEnd * j) / (M - 1));

  const perRun = runs.map((r) => ({
    plane: sampleAt(r.traj, times),
    pixels: null,
    toPixel: r.toPixel,
    stopM: r.traj.p[r.traj.p.length - 1],
    stopT: r.traj.t[r.traj.t.length - 1],
    left: r.traj.leftSurface,
    timedOut: r.traj.timedOut,
    speed: r.speed,
  }));
  for (const pr of perRun) pr.pixels = pr.plane.map((pm) => pr.toPixel(pm));

  // ---- band in pixel space: mean path, and the 90 % perpendicular spread at each time
  const mean = [];
  const sigmaPerp = [];
  for (let j = 0; j < M; j++) {
    let sx = 0, sy = 0, n = 0;
    for (const pr of perRun) { const q = pr.pixels[j]; if (q) { sx += q[0]; sy += q[1]; n++; } }
    mean.push(n ? [sx / n, sy / n] : null);
  }
  for (let j = 0; j < M; j++) {
    const m = mean[j];
    if (!m) { sigmaPerp.push(0); continue; }
    const a = mean[Math.max(0, j - 1)] || m, b = mean[Math.min(M - 1, j + 1)] || m;
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    let s2 = 0, n = 0;
    for (const pr of perRun) {
      const q = pr.pixels[j];
      if (!q) continue;
      const perp = (q[0] - m[0]) * -ty + (q[1] - m[1]) * tx;
      s2 += perp * perp; n++;
    }
    sigmaPerp.push(n > 1 ? Math.sqrt(s2 / (n - 1)) : 0);
  }

  const left = [], right = [];
  for (let j = 0; j < M; j++) {
    const m = mean[j];
    if (!m) continue;
    const a = mean[Math.max(0, j - 1)] || m, b = mean[Math.min(M - 1, j + 1)] || m;
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const w = C.BAND_Z90 * sigmaPerp[j];
    left.push([m[0] - ty * w, m[1] + tx * w]);
    right.push([m[0] + ty * w, m[1] - tx * w]);
  }
  const bandPolygon = left.concat(right.reverse());

  // ---- stop-point cloud: this is what the 7-of-10 test is measured against
  const stopPx = perRun.map((pr) => pr.toPixel(pr.stopM)).filter(Boolean);
  const leftFrac = perRun.filter((pr) => pr.left).length / perRun.length;
  const timedFrac = perRun.filter((pr) => pr.timedOut).length / perRun.length;
  // If most sampled futures run off the edge of the surface that was actually measured, or
  // are still moving at the horizon, then the end of the path is not a resting place and
  // there is no stop region to report. Drawing one anyway would be the exact failure the
  // honesty rule exists to prevent: a confident marker on a place the ball never stops.
  const hasStop = leftFrac <= 0.5 && timedFrac <= 0.5;
  const stopEllipse = hasStop ? ellipse90(stopPx) : null;
  const stopM = perRun.map((pr) => pr.stopM);
  const distM = perRun.map((pr) => Math.hypot(
    pr.stopM[0] - pr.plane[0][0], pr.stopM[1] - pr.plane[0][1]));
  distM.sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];

  const stopTimes = perRun.map((pr) => pr.stopT).sort((a, b) => a - b);

  return {
    ok: true,
    nominalPixels: perRun[0].pixels,
    nominalPlane: perRun[0].plane,
    nominalStopM: perRun[0].stopM,
    nominalStopPx: perRun[0].toPixel(perRun[0].stopM),
    nominalSpeed: perRun[0].speed,
    nominalStopTime: perRun[0].stopT,
    samplePixels: perRun.slice(1).map((pr) => pr.pixels),
    meanPixels: mean,
    bandPolygon,
    stopPx: hasStop ? stopPx : [],
    stopEllipse,
    hasStop,
    stopDistanceM: { p5: q(distM, 0.05), p50: q(distM, 0.5), p95: q(distM, 0.95) },
    stopTimeS: { p5: q(stopTimes, 0.05), p50: q(stopTimes, 0.5), p95: q(stopTimes, 0.95) },
    leftSurfaceFraction: perRun.filter((pr) => pr.left).length / perRun.length,
    timedOutFraction: perRun.filter((pr) => pr.timedOut).length / perRun.length,
    times,
    nRuns: runs.length,
    scaleM: nominal.scaleM,
  };
}

/** 90 % confidence ellipse of a 2D point cloud, as centre + the two principal axes. */
export function ellipse90(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p[0] - mx, dy = p[1] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  sxx /= n - 1; sxy /= n - 1; syy /= n - 1;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (tr * tr) / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc), l2 = tr / 2 - Math.sqrt(disc);
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const k = Math.sqrt(C.ELLIPSE_CHI2_90);
  return {
    cx: mx, cy: my, angle,
    rx: k * Math.sqrt(Math.max(l1, 1e-12)),
    ry: k * Math.sqrt(Math.max(l2, 1e-12)),
  };
}

/** Is a pixel inside the 90 % stop ellipse? This is the pass/fail rule for a trial. */
export function insideEllipse(el, u, v) {
  if (!el) return false;
  const c = Math.cos(-el.angle), s = Math.sin(-el.angle);
  const dx = u - el.cx, dy = v - el.cy;
  const x = dx * c - dy * s, y = dx * s + dy * c;
  return (x * x) / (el.rx * el.rx) + (y * y) / (el.ry * el.ry) <= 1;
}
