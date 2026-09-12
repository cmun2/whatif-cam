/**
 * The physics. A ball rolling in a plane, slowed by a constant deceleration that always
 * opposes its velocity, integrated at a fixed step.
 *
 * Deliberately not a physics engine. v0.0 is one sphere on one plane; ARCHITECTURE.md's
 * reason for writing this by hand is that it has to be deterministic (so the Monte-Carlo
 * band is reproducible), cheap enough to run 64 times, and checkable against a closed
 * form. All three are in the tests.
 *
 * The closed form this is checked against:  stop time = v0/a,  distance = v0^2/(2a).
 *
 * Units are metres and seconds throughout. That is why the app needs a scale at all --
 * the path's SHAPE is scale-free (RESEARCH.md 3.4), but "how far before it stops" is not,
 * because friction is a deceleration in m/s^2.
 */
import * as C from './constants.js';

/**
 * @param {[number,number]} p0 start position, in-plane metres
 * @param {[number,number]} v0 initial velocity, in-plane m/s
 * @param {number} a rolling deceleration, m/s^2 (positive)
 * @param {object} opts {dt, tmax, stopPredicate}
 * @returns {{t:number[], p:[number,number][], v:[number,number][], stopped:boolean,
 *            stopTime:number, leftSurface:boolean}}
 */
export function roll(p0, v0, a, opts = {}) {
  const dt = opts.dt ?? C.SIM_DT;
  const tmax = opts.tmax ?? C.SIM_TMAX;
  const onSurface = opts.onSurface || null;

  let px = p0[0], py = p0[1];
  let vx = v0[0], vy = v0[1];
  const t = [0], p = [[px, py]], v = [[vx, vy]];
  let time = 0;
  let stopped = false;
  let leftSurface = false;
  let timedOut = false;

  const steps = Math.ceil(tmax / dt);
  for (let i = 0; i < steps; i++) {
    const s = Math.hypot(vx, vy);
    if (s < 1e-5) { stopped = true; break; }
    const dv = a * dt;
    const ux = vx / s, uy = vy / s;
    let step = dt;
    let nvx, nvy;
    if (dv >= s) {
      // The ball reaches rest partway through this step. It stops there; it does not roll
      // backwards. Taking the partial step exactly is what makes the integrator agree with
      // v0/a and v0^2/(2a) to a fraction of a millimetre instead of to 3 mm.
      step = s / a;
      nvx = 0; nvy = 0;
    } else {
      nvx = vx - ux * dv;
      nvy = vy - uy * dv;
    }
    // Trapezoidal position update. Exact for constant deceleration along a fixed
    // direction, which is precisely this model; still a fixed-step scheme, so v0.1's
    // collisions drop straight in.
    px += 0.5 * (vx + nvx) * step;
    py += 0.5 * (vy + nvy) * step;
    vx = nvx; vy = nvy;
    time += step;
    t.push(time); p.push([px, py]); v.push([vx, vy]);
    if (onSurface && !onSurface(px, py)) { leftSurface = true; break; }
    if (vx === 0 && vy === 0) { stopped = true; break; }
  }
  // A slow surface plus a hard flick can still be moving at the horizon. The end of the
  // array is then NOT a stop point, and pretending otherwise would draw a confident
  // resting place that the ball rolls straight through. Say so instead.
  if (!stopped && !leftSurface) timedOut = true;
  return { t, p, v, stopped, leftSurface, timedOut, stopTime: time };
}

/** Closed-form answers, for the tests and for the numbers printed in the UI. */
export function analyticStop(speed, a) {
  return { time: speed / a, distance: (speed * speed) / (2 * a) };
}

/** Resample a trajectory onto fixed times, holding the rest position after it stops. */
export function sampleAt(traj, times) {
  const out = [];
  let k = 0;
  for (const tt of times) {
    while (k + 1 < traj.t.length && traj.t[k + 1] <= tt) k++;
    if (tt >= traj.t[traj.t.length - 1]) {
      out.push(traj.p[traj.p.length - 1]);
    } else {
      const t0 = traj.t[k], t1 = traj.t[k + 1];
      const f = t1 > t0 ? (tt - t0) / (t1 - t0) : 0;
      out.push([
        traj.p[k][0] + f * (traj.p[k + 1][0] - traj.p[k][0]),
        traj.p[k][1] + f * (traj.p[k + 1][1] - traj.p[k][1]),
      ]);
    }
  }
  return out;
}
