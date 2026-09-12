/**
 * Camera-motion detection.
 *
 * ROADMAP.md risk 5: "Camera motion silently invalidates the plane. Needs active
 * detection, not a disclaimer." It is also the most likely way this app is wrong in
 * someone's hands, because nothing on screen would look different.
 *
 * Method: fingerprint the setup frame as a 64-wide luminance thumbnail. Each frame,
 * search a small integer shift for the best match and report both the shift and the
 * residual after it. A hand passing through the frame raises the residual but not the
 * shift; picking the phone up raises both. We react on either, after it has persisted --
 * a single bad frame is not a moved camera.
 *
 * Deliberately NOT used: DeviceOrientation / DeviceMotion. The M0 gate passed, so the
 * plane comes from depth; adding a motion-sensor dependency would make the app stop
 * working on a laptop and would need a permission prompt on iOS.
 */
import { grayThumb } from './imageops.js';
import * as C from './constants.js';

export function fingerprint(rgba, w, h) {
  const tw = C.MOTION_GRID_W;
  const th = Math.max(8, Math.round((tw * h) / w));
  return { g: grayThumb(rgba, w, h, tw, th), tw, th, srcW: w, srcH: h };
}

/** Best integer shift within +/-3 px of the thumbnail, plus the residual after it. */
export function compare(ref, cur) {
  if (!ref || !cur || ref.tw !== cur.tw || ref.th !== cur.th) return null;
  const { tw, th } = ref;
  let best = { dx: 0, dy: 0, res: Infinity };
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      let s = 0, n = 0;
      for (let y = 4; y < th - 4; y++) {
        for (let x = 4; x < tw - 4; x++) {
          const a = ref.g[y * tw + x];
          const b = cur.g[(y + dy) * tw + (x + dx)];
          s += Math.abs(a - b); n++;
        }
      }
      const res = s / n;
      if (res < best.res) best = { dx, dy, res };
    }
  }
  // Express the shift in pixels of the original frame, which is what a user understands.
  const scale = ref.srcW / tw;
  return {
    shiftThumb: Math.hypot(best.dx, best.dy),
    shiftPx: Math.hypot(best.dx, best.dy) * scale,
    residual: best.res,
    dx: best.dx, dy: best.dy,
  };
}

/** Stateful watcher: only calls it a move when the condition holds for MOTION_HOLD_S. */
export class MotionWatch {
  constructor() { this.ref = null; this.since = null; this.state = null; }
  setReference(rgba, w, h) { this.ref = fingerprint(rgba, w, h); this.since = null; this.state = null; }
  update(rgba, w, h, tSec) {
    if (!this.ref) return null;
    const c = compare(this.ref, fingerprint(rgba, w, h));
    if (!c) return null;
    const bad = c.shiftThumb >= C.MOTION_SHIFT_REFUSE_PX || c.residual >= C.MOTION_RESIDUAL_REFUSE;
    if (bad) {
      if (this.since == null) this.since = tSec;
    } else {
      this.since = null;
    }
    const moved = this.since != null && tSec - this.since >= C.MOTION_HOLD_S;
    this.state = { ...c, moved, bad };
    return this.state;
  }
}
