/**
 * A 2D template tracker. No neural network, no per-frame inference -- ARCHITECTURE.md's
 * per-frame box is "2D tracker + physics", and it has to run at camera rate.
 *
 * This exists for Measure mode, which is how the 7-of-10 milestone bar gets measured at
 * all. The primary v0.0 interaction is still the drag: ROADMAP.md cut hand tracking and
 * object detection, and this is neither -- it follows one already-segmented patch so the
 * app can (a) estimate the velocity of a roll the owner actually performed, instead of one
 * he typed in, and (b) record where the ball really came to rest.
 *
 * ROADMAP.md risk 4: 1 px of tracking noise over a 0.3 s window was worth 41 mm at 1 s,
 * so sub-pixel accuracy matters more here than a better depth model does.
 */
import * as C from './constants.js';

export class Tracker {
  /**
   * Blob centroid tracking, not template matching.
   *
   * Template NCC was tried first and drifts: as the ball rolls away from the camera its
   * silhouette shrinks -- measured on the synthetic table, 14.2 px to 9.8 px over 0.8 s --
   * the correlation score decays from 0.97 to 0.64 and the peak wanders by up to 4.7 px.
   * At 1 px of tracking noise costing 41 mm at 1 s (ROADMAP.md risk 4), that is fatal.
   *
   * A ball on a plain table is a compact region that differs from its surroundings, and
   * its intensity-weighted centroid is both sub-pixel and immune to scale change. The
   * window follows the ball's own velocity, and its radius is re-estimated every frame.
   *
   * The cost is a narrower assumption: this needs the ball to stand out from the table.
   * For v0.0 -- one ball, one plain surface -- that is the scene. A ball the same shade as
   * the table reports LOST, which is the honest outcome.
   *
   * @param {Float32Array} g luminance 0..1 at frame size
   */
  constructor(g, w, h, cx, cy, radiusPx) {
    this.w = w; this.h = h;
    this.x = cx; this.y = cy;
    this.vx = 0; this.vy = 0;
    this.radius = Math.max(2.5, radiusPx);
    this.lost = false;
    this.polarity = null;       // is the ball darker or brighter than the table?
    this.update(g);             // lock on to the initial appearance
    this.vx = 0; this.vy = 0;
  }

  #window() {
    const r = Math.min(60, 2.6 * this.radius + 8);
    const cx = this.x + this.vx, cy = this.y + this.vy;
    return {
      x0: Math.max(0, Math.round(cx - r)), x1: Math.min(this.w, Math.round(cx + r) + 1),
      y0: Math.max(0, Math.round(cy - r)), y1: Math.min(this.h, Math.round(cy + r) + 1),
    };
  }

  /** @returns {{u,v,score,radius}|null} */
  update(g) {
    const W = this.#window();
    const bw = W.x1 - W.x0, bh = W.y1 - W.y0;
    if (bw < 6 || bh < 6) { this.lost = true; return null; }

    // Background level from the window's border ring: the table around the ball.
    const ring = [];
    for (let x = W.x0; x < W.x1; x++) { ring.push(g[W.y0 * this.w + x], g[(W.y1 - 1) * this.w + x]); }
    for (let y = W.y0; y < W.y1; y++) { ring.push(g[y * this.w + W.x0], g[y * this.w + W.x1 - 1]); }
    ring.sort((a, b) => a - b);
    const bg = ring[ring.length >> 1];

    // The ball keeps the polarity it had when the tracker was created, so a shadow on the
    // other side of the brightness cannot capture it.
    let peak = 0, peakSigned = 0;
    for (let y = W.y0; y < W.y1; y++) {
      for (let x = W.x0; x < W.x1; x++) {
        const d = g[y * this.w + x] - bg;
        if (Math.abs(d) > peak) { peak = Math.abs(d); peakSigned = d; }
      }
    }
    if (this.polarity == null) this.polarity = Math.sign(peakSigned) || 1;
    if (peak < 0.035) { this.lost = true; return null; }   // no contrast: nothing to track

    const thr = 0.45 * peak;
    let sw = 0, sx = 0, sy = 0, count = 0;
    for (let y = W.y0; y < W.y1; y++) {
      for (let x = W.x0; x < W.x1; x++) {
        const d = (g[y * this.w + x] - bg) * this.polarity;
        if (d < thr) continue;
        const wgt = d - thr;
        sw += wgt; sx += wgt * (x + 0.5); sy += wgt * (y + 0.5); count++;
      }
    }
    if (!(sw > 0) || count < 6) { this.lost = true; return null; }
    if (count > 0.62 * bw * bh) { this.lost = true; return null; }  // it filled the window

    const nx = sx / sw, ny = sy / sw;
    this.vx = nx - this.x; this.vy = ny - this.y;
    this.x = nx; this.y = ny;
    this.radius = Math.max(2.0, Math.sqrt(count / Math.PI));
    this.lost = false;
    return { u: nx, v: ny, score: peak, radius: this.radius };
  }
}

/**
 * Least-squares straight-line fit of in-plane position against time.
 * Returns velocity, the position at the last observed instant, and the fit residual --
 * which is where the velocity's own error bar comes from, rather than a guess.
 */
export function fitVelocity(samples) {
  const n = samples.length;
  if (n < 3) return null;
  let st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
  for (const s of samples) {
    st += s.t; stt += s.t * s.t; sx += s.p[0]; sy += s.p[1];
    stx += s.t * s.p[0]; sty += s.t * s.p[1];
  }
  const den = n * stt - st * st;
  if (Math.abs(den) < 1e-12) return null;
  const vx = (n * stx - st * sx) / den, vy = (n * sty - st * sy) / den;
  const ax = (sx - vx * st) / n, ay = (sy - vy * st) / n;
  let r2 = 0;
  for (const s of samples) {
    const ex = ax + vx * s.t - s.p[0], ey = ay + vy * s.t - s.p[1];
    r2 += ex * ex + ey * ey;
  }
  const rms = Math.sqrt(r2 / n);
  const tLast = samples[n - 1].t;
  return { v: [vx, vy], p: [ax + vx * tLast, ay + vy * tLast], residualM: rms, tLast, n };
}
