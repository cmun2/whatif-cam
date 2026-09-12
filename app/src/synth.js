/**
 * A synthetic tabletop, with exact ground truth.
 *
 * This is probe/scene.py's geometry re-stated in JavaScript so that the same scene can be
 * (a) rendered in the browser as a demo that needs no webcam and no model download, and
 * (b) used headlessly in tests, where it is the only way to check the whole chain --
 * plane fit, contact point, tracker, velocity fit, prediction -- against an answer that
 * is known rather than eyeballed.
 *
 * Camera convention matches geometry.js and probe/scene.py: x right, y DOWN, z forward.
 */
import { intrinsics, planeFrame, planeToCam, project, ray, orient, rad } from './geometry.js';

function ballPixelGuess(K, c) {
  return c[2] > 1e-6 ? project(K, c) : [K.cx, K.cy];
}

export function makeScene(opts = {}) {
  const W = opts.W ?? 640, H = opts.H ?? 480;
  const hfov = opts.hfovDeg ?? 60;
  const camH = opts.camH ?? 0.45;            // metres above the table
  const pitch = rad(opts.pitchDeg ?? 37);    // downward pitch == elevation above the plane
  const K = intrinsics(hfov, W, H);
  const plane = orient([0, -Math.cos(pitch), -Math.sin(pitch)], -camH);
  const frame = planeFrame(plane);
  return {
    W, H, hfov, camH, pitchDeg: opts.pitchDeg ?? 37, K, plane, frame,
    halfWidth: opts.halfWidth ?? 0.62,
    nearY: opts.nearY ?? 0.16,
    farY: opts.farY ?? 1.25,
  };
}

export function onTable(scene, p) {
  return Math.abs(p[0]) < scene.halfWidth && p[1] > scene.nearY && p[1] < scene.farY;
}

function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Render one frame. The table is deliberately PLAIN -- the M0 gate's hard case -- with
 * only a faint gradient and sensor noise, so that nothing here flatters the depth model or
 * the tracker.
 * @returns {{rgba:Uint8ClampedArray, w, h, ballPixel:[number,number], ballRadiusPx:number}}
 */
export function renderFrame(scene, ballPlane, ballRadiusM, opts = {}) {
  const { W, H, K, plane, frame } = scene;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const ballCentre = (() => {
    const onPlane = planeToCam(frame, ballPlane);
    return [
      onPlane[0] + plane.n[0] * ballRadiusM,
      onPlane[1] + plane.n[1] * ballRadiusM,
      onPlane[2] + plane.n[2] * ballRadiusM,
    ];
  })();
  const zbuf = new Float32Array(W * H).fill(Infinity);

  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const r = ray(K, u + 0.5, v + 0.5);
      const den = r[0] * plane.n[0] + r[1] * plane.n[1] + r[2] * plane.n[2];
      let col = [34, 37, 44];
      let z = Infinity;
      if (Math.abs(den) > 1e-9) {
        const t = plane.d / den;
        if (t > 0) {
          const X = [r[0] * t, r[1] * t, r[2] * t];
          const w0 = [X[0] - frame.origin[0], X[1] - frame.origin[1], X[2] - frame.origin[2]];
          const a = w0[0] * frame.e1[0] + w0[1] * frame.e1[1] + w0[2] * frame.e1[2];
          const b = w0[0] * frame.e2[0] + w0[1] * frame.e2[1] + w0[2] * frame.e2[2];
          if (onTable(scene, [a, b])) {
            const shade = 232 - 26 * Math.min(1, Math.max(0, (b - scene.nearY) / (scene.farY - scene.nearY)));
            col = [shade, shade - 2, shade - 6];
            z = X[2];
          }
        }
      }
      zbuf[v * W + u] = z;
      const k = (v * W + u) * 4;
      const n0 = (hash2(u, v) - 0.5) * (opts.noise ?? 6);
      rgba[k] = col[0] + n0; rgba[k + 1] = col[1] + n0; rgba[k + 2] = col[2] + n0; rgba[k + 3] = 255;
    }
  }

  // The ball, ray-traced as a sphere so its silhouette and its depth are both exact.
  const c = ballCentre, R = ballRadiusM;
  let minU = 1e9, maxU = -1e9, minV = 1e9, maxV = -1e9, count = 0;
  // Only scan the sphere's projected bounding box. The silhouette of a sphere of radius R
  // at distance z spans about 2*R*f/z pixels; a generous margin costs nothing and this
  // turns the per-frame cost from "the whole image twice" into "the ball".
  const bboxR = c[2] > 1e-6 ? (1.6 * R * K.fx) / c[2] + 4 : Math.max(W, H);
  const v0b = Math.max(0, Math.floor(ballPixelGuess(K, c)[1] - bboxR));
  const v1b = Math.min(H, Math.ceil(ballPixelGuess(K, c)[1] + bboxR));
  const u0b = Math.max(0, Math.floor(ballPixelGuess(K, c)[0] - bboxR));
  const u1b = Math.min(W, Math.ceil(ballPixelGuess(K, c)[0] + bboxR));
  for (let v = v0b; v < v1b; v++) {
    for (let u = u0b; u < u1b; u++) {
      const r0 = ray(K, u + 0.5, v + 0.5);
      const L = Math.hypot(r0[0], r0[1], r0[2]);
      const dn = [r0[0] / L, r0[1] / L, r0[2] / L];
      const bq = 2 * (dn[0] * -c[0] + dn[1] * -c[1] + dn[2] * -c[2]);
      const cq = c[0] * c[0] + c[1] * c[1] + c[2] * c[2] - R * R;
      const disc = bq * bq - 4 * cq;
      if (disc <= 0) continue;
      const t = (-bq - Math.sqrt(disc)) / 2;
      if (!(t > 0)) continue;
      const X = [dn[0] * t, dn[1] * t, dn[2] * t];
      if (X[2] >= zbuf[v * W + u]) continue;
      const nx = (X[0] - c[0]) / R, ny = (X[1] - c[1]) / R, nz = (X[2] - c[2]) / R;
      const lam = Math.max(0.18, -(nx * plane.n[0] + ny * plane.n[1] + nz * plane.n[2])) * 0.8 + 0.2;
      const k = (v * W + u) * 4;
      rgba[k] = 222 * lam; rgba[k + 1] = 76 * lam; rgba[k + 2] = 56 * lam; rgba[k + 3] = 255;
      zbuf[v * W + u] = X[2];
      count++;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
  }
  const ballPixel = project(K, c);
  return {
    rgba, w: W, h: H,
    ballPixel, ballRadiusPx: Math.sqrt(count / Math.PI),
    ballBBox: [minU, minV, maxU, maxV],
    ballMaskPx: count,
    zbuf,
  };
}

/**
 * Ground-truth disparity (1/z) for a rendered frame, optionally corrupted the way a real
 * depth model corrupts it: a global affine shift on the disparity (the error m0/README.md
 * section 5 proves the bend metric cannot see) plus smooth low-frequency warp.
 */
export function disparityFrom(frameOut, opts = {}) {
  const { zbuf, w, h } = frameOut;
  const out = new Float32Array(w * h);
  const shift = opts.shift ?? 0;
  const warp = opts.warp ?? 0;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const z = zbuf[v * w + u];
      let d = isFinite(z) ? 1 / z : 1 / 6;
      if (warp) {
        d *= 1 + warp * Math.sin((3 * Math.PI * u) / w) * Math.cos((2 * Math.PI * v) / h);
      }
      out[v * w + u] = d + shift;
    }
  }
  return out;
}

/** The ground-truth roll, for checking a prediction against an answer. */
export function groundTruthRoll(p0, v0, a, dt = 1 / 240, tmax = 6) {
  let px = p0[0], py = p0[1], vx = v0[0], vy = v0[1], t = 0;
  const out = [{ t: 0, p: [px, py] }];
  while (t < tmax) {
    const s = Math.hypot(vx, vy);
    if (s < 1e-5) break;
    const dv = a * dt;
    if (dv >= s) { vx = 0; vy = 0; } else { vx -= (vx / s) * dv; vy -= (vy / s) * dv; }
    px += vx * dt; py += vy * dt; t += dt;
    out.push({ t, p: [px, py] });
    if (vx === 0 && vy === 0) break;
  }
  return out;
}
