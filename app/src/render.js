/**
 * Everything drawn on top of the camera frame.
 *
 * The drawing is part of the honesty requirement, not decoration on top of it:
 *  - the predicted path is DASHED and labelled, so it never reads as a measured track;
 *  - the band is drawn before the line and widens with time, because it genuinely does;
 *  - the individual sampled futures are drawn faintly, so "uncertainty" is visibly a set
 *    of rollouts rather than a fixed-width ribbon someone drew around a confident answer;
 *  - the stop region is an explicit 90 % ellipse, because that is the thing the 7-of-10
 *    milestone bar is measured against and it should be on screen, not in a log;
 *  - the surface the plane was fitted to is shown, so a wrong plane is visible as a wrong
 *    green patch rather than as a subtly wrong path.
 */

const C_BAND = 'rgba(120, 190, 255, 0.20)';
const C_SAMPLE = 'rgba(120, 190, 255, 0.16)';
const C_PATH = 'rgba(150, 210, 255, 0.95)';
const C_STOP = 'rgba(255, 210, 90, 0.95)';
const C_PLANE = 'rgba(90, 240, 150, 0.17)';
const C_BALL = 'rgba(255, 120, 90, 0.95)';

/** Cache the fitted-surface overlay: thousands of little rects, drawn once. */
export function makePlaneLayer(fit, w, h) {
  const cv = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = cv.getContext('2d');
  g.fillStyle = C_PLANE;
  // A stipple rather than a wash. Painting every inlier solid hides the photograph
  // underneath, and the point of showing the fitted surface is to let someone compare it
  // against what is actually in the frame.
  const s = fit.step;
  for (const [u, v] of fit.inlierPixels) {
    if (((u / s) | 0) % 2 !== ((v / s) | 0) % 2) continue;
    g.fillRect(u, v, s, s);
  }
  return cv;
}

export function drawFrame(ctx, frame) {
  const img = new ImageData(frame.rgba, frame.w, frame.h);
  ctx.putImageData(img, 0, 0);
}

export function drawPlaneLayer(ctx, layer, show) {
  if (layer && show) ctx.drawImage(layer, 0, 0);
}

export function drawBall(ctx, ball) {
  if (!ball) return;
  const [u, v] = ball.contactPixel;
  ctx.save();
  if (ball.maskOutline) {
    ctx.strokeStyle = C_BALL; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const seg of ball.maskOutline) {
      ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]);
    }
    ctx.stroke();
  } else {
    ctx.strokeStyle = C_BALL; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(u, v - ball.radiusPx * 0.75, ball.radiusPx, ball.radiusPx, 0, 0, 2 * Math.PI);
    ctx.stroke();
  }
  // The contact point. ROADMAP.md risk 3: this is the mask's lower edge, not its centroid.
  ctx.fillStyle = C_BALL;
  ctx.beginPath(); ctx.arc(u, v, 3.5, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(u - 8, v); ctx.lineTo(u + 8, v); ctx.stroke();
  ctx.restore();
}

export function drawDrag(ctx, from, to) {
  if (!from || !to) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(to[0], to[1]); ctx.stroke();
  const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - 10 * Math.cos(a - 0.4), to[1] - 10 * Math.sin(a - 0.4));
  ctx.lineTo(to[0] - 10 * Math.cos(a + 0.4), to[1] - 10 * Math.sin(a + 0.4));
  ctx.closePath(); ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
  ctx.restore();
}

export function drawPrediction(ctx, pred, opts = {}) {
  if (!pred || !pred.ok) return;
  ctx.save();

  if (pred.bandPolygon.length > 3) {
    ctx.fillStyle = C_BAND;
    ctx.beginPath();
    ctx.moveTo(pred.bandPolygon[0][0], pred.bandPolygon[0][1]);
    for (const p of pred.bandPolygon.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath(); ctx.fill();
  }

  if (opts.showSamples !== false) {
    ctx.strokeStyle = C_SAMPLE; ctx.lineWidth = 1;
    for (const run of pred.samplePixels) {
      ctx.beginPath();
      let started = false;
      for (const q of run) {
        if (!q) continue;
        if (!started) { ctx.moveTo(q[0], q[1]); started = true; } else ctx.lineTo(q[0], q[1]);
      }
      ctx.stroke();
    }
  }

  ctx.strokeStyle = C_PATH; ctx.lineWidth = 2.5; ctx.setLineDash([9, 6]);
  ctx.beginPath();
  let started = false;
  for (const q of pred.nominalPixels) {
    if (!q) continue;
    if (!started) { ctx.moveTo(q[0], q[1]); started = true; } else ctx.lineTo(q[0], q[1]);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  if (pred.stopEllipse) {
    const e = pred.stopEllipse;
    ctx.strokeStyle = C_STOP; ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.ellipse(e.cx, e.cy, e.rx, e.ry, e.angle, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 210, 90, 0.10)'; ctx.fill();
  }

  const tip = pred.nominalStopPx;
  if (tip) {
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const label = pred.hasStop
      ? 'PREDICTION - not a measurement'
      : 'PREDICTION - runs off the measured surface, no stop point';
    const wpx = ctx.measureText(label).width;
    const lx = Math.min(ctx.canvas.width - wpx - 12, Math.max(6, tip[0] + 10));
    const ly = Math.max(16, tip[1] - 12);
    ctx.fillStyle = 'rgba(8, 12, 20, 0.72)';
    ctx.fillRect(lx - 5, ly - 12, wpx + 10, 17);
    ctx.fillStyle = C_PATH;
    ctx.fillText(label, lx, ly);
  }
  ctx.restore();
}

/**
 * The playhead: every sampled future at one instant, plus a hollow ring on the mean.
 *
 * Deliberately NOT a solid ball on the mean path. The honest content of the screen is the
 * spread, and a confident-looking sphere sliding along the middle of it would read as a
 * measurement. What moves is the swarm; the ring only says where its middle is.
 */
export function drawPlayhead(ctx, pred, t, anim) {
  if (!pred || !pred.ok || t == null) return;
  const times = pred.times;
  ctx.save();

  let alive = 0;
  ctx.fillStyle = 'rgba(150, 210, 255, 0.55)';
  for (let i = 0; i < pred.samplePixels.length; i++) {
    const q = anim.sampleAtTime(pred.samplePixels[i], times, t, pred.sampleLeftAt[i]);
    if (!q) continue;
    alive++;
    ctx.beginPath();
    ctx.arc(q[0], q[1], 1.8, 0, 2 * Math.PI);
    ctx.fill();
  }

  const left = t > (pred.nominalLeftAt ?? Infinity);
  const m = anim.sampleAtTime(pred.nominalPixels, times, Math.min(t, pred.nominalLeftAt ?? t), null);
  if (m) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = left ? 'rgba(255, 140, 110, 0.95)' : 'rgba(235, 245, 255, 0.95)';
    ctx.beginPath();
    ctx.arc(m[0], m[1], 7, 0, 2 * Math.PI);
    ctx.stroke();
    if (left) {
      // It has run off the surface the plane was fitted to. Strike it out and say so.
      ctx.beginPath();
      ctx.moveTo(m[0] - 5, m[1] - 5); ctx.lineTo(m[0] + 5, m[1] + 5);
      ctx.moveTo(m[0] + 5, m[1] - 5); ctx.lineTo(m[0] - 5, m[1] + 5);
      ctx.stroke();
      // Below the marker: the path's own label sits above it.
      label(ctx, m, 'off the measured surface - nothing beyond here is known',
        'rgba(255, 140, 110, 0.95)', +1);
    }
  }

  // How much of the ensemble is still on the table, and how wide it has become. The
  // spread in centimetres is the whole point of animating the ensemble instead of one
  // ball: a single sphere gliding along the mean would quietly restore the confidence the
  // band exists to remove, so the number it is hiding goes on screen beside it.
  const total = pred.samplePixels.length;
  if (total) {
    let spread = null;
    if (pred.samplePlaneM) {
      // Each future's displacement from ITS OWN start, not from a shared origin: the
      // sampled scenes have different scales and slightly different ball positions, so a
      // common origin would report several centimetres of "spread" before anything moved.
      const ds = [];
      for (let i = 0; i < pred.samplePlaneM.length; i++) {
        if (pred.sampleLeftAt[i] != null && t > pred.sampleLeftAt[i]) continue;
        const track = pred.samplePlaneM[i];
        const q = anim.sampleAtTime(track, times, t, null);
        if (q) ds.push(Math.hypot(q[0] - track[0][0], q[1] - track[0][1]));
      }
      if (ds.length > 4) {
        ds.sort((a, b) => a - b);
        const q5 = ds[Math.round(0.05 * (ds.length - 1))];
        const q95 = ds[Math.round(0.95 * (ds.length - 1))];
        spread = 100 * (q95 - q5);
      }
    }
    const txt = `t = ${t.toFixed(2)} s   ${alive}/${total} futures still on the surface`
      + (spread != null ? `   spread ${spread.toFixed(0)} cm` : '');
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const w = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(8, 12, 20, 0.72)';
    ctx.fillRect(8, ctx.canvas.height - 44, w + 12, 17);
    ctx.fillStyle = alive < total ? 'rgba(255, 170, 140, 0.95)' : 'rgba(180, 215, 245, 0.95)';
    ctx.fillText(txt, 14, ctx.canvas.height - 32);
  }
  ctx.restore();
}

function label(ctx, at, text, colour, dir = -1) {
  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  const w = ctx.measureText(text).width;
  const x = Math.min(ctx.canvas.width - w - 12, Math.max(6, at[0] + 12));
  const y = dir < 0
    ? Math.max(16, at[1] - 14)
    : Math.min(ctx.canvas.height - 8, at[1] + 26);
  ctx.fillStyle = 'rgba(8, 12, 20, 0.78)';
  ctx.fillRect(x - 5, y - 12, w + 10, 17);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

/** The measured rest point of a real trial, drawn against the band that predicted it. */
export function drawObserved(ctx, px, inside) {
  if (!px) return;
  ctx.save();
  ctx.strokeStyle = inside ? 'rgba(110,240,160,0.95)' : 'rgba(255,110,110,0.95)';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(px[0], px[1], 8, 0, 2 * Math.PI); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px[0] - 11, px[1]); ctx.lineTo(px[0] + 11, px[1]);
  ctx.moveTo(px[0], px[1] - 11); ctx.lineTo(px[0], px[1] + 11);
  ctx.stroke();
  ctx.restore();
}

export function drawTrack(ctx, pts) {
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pts[0].u, pts[0].v);
  for (const p of pts.slice(1)) ctx.lineTo(p.u, p.v);
  ctx.stroke();
  ctx.restore();
}

/** Trace the boundary of a binary mask as line segments, for a crisp outline. */
export function maskOutline(mask, w, h) {
  const segs = [];
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      if (!mask[v * w + u]) continue;
      if (u === 0 || !mask[v * w + u - 1]) segs.push([u, v, u, v + 1]);
      if (u === w - 1 || !mask[v * w + u + 1]) segs.push([u + 1, v, u + 1, v + 1]);
      if (v === 0 || !mask[(v - 1) * w + u]) segs.push([u, v, u + 1, v]);
      if (v === h - 1 || !mask[(v + 1) * w + u]) segs.push([u, v + 1, u + 1, v + 1]);
    }
  }
  return segs;
}
