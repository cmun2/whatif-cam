/**
 * The playhead.
 *
 * A drawn path is a diagram. A ball that takes 1.4 s to cross the table is something a
 * person believes. But "something a person believes" is exactly the risk: the honest
 * content of this screen is that the ball could stop anywhere across a wide band, and a
 * single confident sphere sliding along the mean path would quietly delete that.
 *
 * So the moving thing is not one ball. It is the whole ensemble: all 64 sampled futures
 * advance together, and the spread you watch open up IS the band. The mean is drawn as a
 * hollow ring, not a solid ball, so nothing on screen looks like a measured position.
 *
 * A sampled future that runs off the measured surface stops being drawn at the moment it
 * leaves. The swarm thins out. That is the app losing track of the world, shown rather
 * than described.
 */

export class Clock {
  /** @param {(t:number)=>void} onFrame called with the playhead time in seconds */
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.t = 0;
    this.duration = 0;
    this.playing = false;
    this._last = null;
  }

  get reducedMotion() {
    return typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  setDuration(d) {
    this.duration = Math.max(0, d || 0);
    if (this.t > this.duration) this.t = this.duration;
  }

  /** Load a new prediction. Autoplays unless the viewer asked for less motion. */
  reset(duration, autoplay = true) {
    this.setDuration(duration);
    this.t = 0;
    this._last = null;
    this.playing = autoplay && !this.reducedMotion && this.duration > 0.05;
    this.onFrame(this.t);
  }

  play() {
    if (this.duration <= 0) return;
    if (this.t >= this.duration - 1e-6) this.t = 0;
    this.playing = true;
    this._last = null;
  }

  pause() { this.playing = false; this._last = null; }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  replay() { this.t = 0; this.play(); }

  seek(t) {
    this.t = Math.max(0, Math.min(this.duration, t));
    this.playing = false;
    this._last = null;
    this.onFrame(this.t);
  }

  /** Advance from a rAF timestamp in milliseconds. Returns true if it moved. */
  advance(tsMs) {
    if (!this.playing) return false;
    const now = tsMs / 1000;
    if (this._last == null) { this._last = now; return false; }
    const dt = Math.min(0.1, now - this._last);   // a backgrounded tab must not teleport
    this._last = now;
    this.t += dt;
    if (this.t >= this.duration) { this.t = this.duration; this.playing = false; }
    this.onFrame(this.t);
    return true;
  }
}

/**
 * Interpolate one sampled future's pixel position at time t, or null if that future has
 * already run off the measured surface. `times` is the prediction's sample grid.
 */
export function sampleAtTime(pixels, times, t, leftAt) {
  if (leftAt != null && t > leftAt) return null;
  if (!pixels || !pixels.length) return null;
  if (t <= times[0]) return pixels[0];
  const last = times.length - 1;
  if (t >= times[last]) return pixels[last];
  let k = 0;
  while (k + 1 <= last && times[k + 1] <= t) k++;
  const a = pixels[k], b = pixels[Math.min(last, k + 1)];
  if (!a) return null;
  if (!b) return a;
  const t0 = times[k], t1 = times[Math.min(last, k + 1)];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
}
