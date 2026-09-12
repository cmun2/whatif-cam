/**
 * Depth map -> support plane, plus the diagnostics the UI has to show.
 *
 * The plane math is a port of m0/planefit.py: least squares via the 3x3 covariance
 * eigen-decomposition, and the same near/far bend and flatness statistics that the M0
 * gate reported. Keeping the statistics identical is the point -- the numbers on screen
 * are then comparable to the numbers in m0/README.md section 6, which is the only
 * calibration this app has.
 *
 * What is NOT ported: the 4-tap reference plane. M0 gated on it and passed at 1.9 deg, so
 * v0.0 takes depth as the plane and does not ask the user to tap corners. What survives
 * is the error bar that comparison produced.
 */
import { norm3, dot, sub, cross, orient, elevationDeg, ray } from './geometry.js';
import * as C from './constants.js';

/** Symmetric 3x3 eigen-decomposition by Jacobi rotations. Small, exact enough, no deps. */
function eigenSym3(A) {
  const a = [A[0].slice(), A[1].slice(), A[2].slice()];
  let V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
    if (off < 1e-24) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const vals = [a[0][0], a[1][1], a[2][2]];
  const vecs = [0, 1, 2].map((j) => [V[0][j], V[1][j], V[2][j]]);
  const idx = [0, 1, 2].sort((i, j) => vals[i] - vals[j]);
  return { values: idx.map((i) => vals[i]), vectors: idx.map((i) => vecs[i]) };
}

/**
 * Least-squares plane through 3D points given as a flat Float64Array [x,y,z,...].
 * `idx` optionally selects a subset. Returns {n, d, rms}.
 */
export function fitPlane(P, idx) {
  const n = idx ? idx.length : P.length / 3;
  if (n < 3) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const k = 3 * (idx ? idx[i] : i);
    cx += P[k]; cy += P[k + 1]; cz += P[k + 2];
  }
  cx /= n; cy /= n; cz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i++) {
    const k = 3 * (idx ? idx[i] : i);
    const dx = P[k] - cx, dy = P[k + 1] - cy, dz = P[k + 2] - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const e = eigenSym3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
  const nv = norm3(e.vectors[0]);
  const c = [cx, cy, cz];
  let rms = 0;
  for (let i = 0; i < n; i++) {
    const k = 3 * (idx ? idx[i] : i);
    const r = (P[k] - cx) * nv[0] + (P[k + 1] - cy) * nv[1] + (P[k + 2] - cz) * nv[2];
    rms += r * r;
  }
  rms = Math.sqrt(rms / n);
  const o = orient(nv, dot(nv, c));
  return { n: o.n, d: o.d, rms };
}

/**
 * Back-project a disparity (relative inverse depth) map onto rays.
 *
 * depth = 1 / disp, i.e. the additive offset on the model's output is assumed to be zero.
 * m0/README.md section 5 is the argument for why that assumption is load-bearing and
 * invisible to the bend metric; section 6 is the measurement that it is very nearly right
 * for a table filling the frame from 40-60 cm. Both are quoted in the UI.
 */
export function backproject(disp, w, h, K, step, mask) {
  const pts = [];
  const uvs = [];
  for (let v = 0; v < h; v += step) {
    for (let u = 0; u < w; u += step) {
      if (mask && !mask[v * w + u]) continue;
      const dv = disp[v * w + u];
      if (!(dv > 1e-3)) continue;
      const z = 1 / dv;
      const r = ray(K, u, v);
      pts.push(r[0] * z, r[1] * z, z);
      uvs.push(u, v);
    }
  }
  return { P: Float64Array.from(pts), uv: Int32Array.from(uvs), count: uvs.length / 2 };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function extentOf(P, count) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const x = P[3 * i + a];
      if (x < mn[a]) mn[a] = x;
      if (x > mx[a]) mx[a] = x;
    }
  }
  return Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
}

/**
 * RANSAC for the dominant plane, restricted to orientations a table could plausibly have
 * relative to the camera. Deterministic: the seed is fixed, so the same frame always
 * produces the same plane and the same screenshot.
 */
export function ransacPlane(P, count, opts = {}) {
  const iters = opts.iters ?? 900;
  const rng = mulberry32(opts.seed ?? 12345);
  const extent = extentOf(P, count);
  if (!(extent > 0)) return null;
  // The inlier threshold is scaled by the MEDIAN DEPTH of the cloud, not by its extent.
  // Extent is set by the furthest thing in frame -- the wall behind the table -- so a
  // scene with a lot of background gets a threshold several centimetres wide, loose
  // enough that a plane slicing through table AND wall outscores the table itself.
  // Measured: at a 30 deg camera elevation on exact synthetic geometry that cost 3.3 deg.
  const depths = [];
  for (let i = 0; i < count; i += Math.max(1, (count / 4000) | 0)) depths.push(P[3 * i + 2]);
  depths.sort((a, b) => a - b);
  // The 35th percentile rather than the median: the table is the near thing, the wall is
  // the far thing, and the threshold should be scaled by the surface we are looking for.
  const refDepth = depths[Math.max(0, Math.round(0.35 * (depths.length - 1)))] || extent;
  const tau = (opts.tauRel ?? 0.02) * refDepth;
  let best = null;

  const get = (i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
  for (let it = 0; it < iters; it++) {
    const i0 = (rng() * count) | 0, i1 = (rng() * count) | 0, i2 = (rng() * count) | 0;
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    const a = get(i0), b = get(i1), c = get(i2);
    let nv = norm3(cross(sub(b, a), sub(c, a)));
    if (!isFinite(nv[0]) || (nv[0] === 0 && nv[1] === 0 && nv[2] === 0)) continue;
    const o = orient(nv, dot(nv, a));
    const elev = Math.asin(Math.min(1, Math.abs(o.n[2]))) * 180 / Math.PI;
    if (elev < C.ELEV_REFUSE_MIN_DEG || elev > C.ELEV_REFUSE_MAX_DEG) continue;
    let inl = 0;
    for (let i = 0; i < count; i++) {
      const r = P[3 * i] * o.n[0] + P[3 * i + 1] * o.n[1] + P[3 * i + 2] * o.n[2] - o.d;
      if (r < tau && r > -tau) inl++;
    }
    if (!best || inl > best.inliers) best = { n: o.n, d: o.d, inliers: inl };
  }
  if (!best) return null;

  // Refine: least squares on the inliers, re-selecting each round. The inlier threshold
  // is re-derived from the inliers' OWN extent each time, because the first one had to be
  // scaled by the whole point cloud -- which includes the wall behind the table, and so is
  // far too loose to separate a ball resting on the surface from the surface itself.
  let plane = { n: best.n, d: best.d };
  let idx = null;
  let tauCur = tau;
  for (let round = 0; round < 4; round++) {
    idx = [];
    for (let i = 0; i < count; i++) {
      const r = P[3 * i] * plane.n[0] + P[3 * i + 1] * plane.n[1] + P[3 * i + 2] * plane.n[2] - plane.d;
      if (r < tauCur && r > -tauCur) idx.push(i);
    }
    if (idx.length < 3) return null;
    const f = fitPlane(P, idx);
    if (!f) return null;
    plane = { n: f.n, d: f.d, rms: f.rms };
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const i of idx) {
      for (let a = 0; a < 3; a++) {
        const x = P[3 * i + a];
        if (x < mn[a]) mn[a] = x;
        if (x > mx[a]) mx[a] = x;
      }
    }
    const inlierExtent = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    // Monotonically non-increasing, with a floor. Letting it grow is a runaway: a few
    // background pixels widen the extent, which widens the threshold, which admits more
    // background. Measured on the synthetic scene at a 30 deg elevation, that feedback
    // turned an exact plane into a 3.5 deg error.
    void inlierExtent;
    tauCur = Math.min(tauCur, Math.max(3 * (plane.rms || 0), 0.25 * tau));
  }
  return { plane, inlierIdx: idx, inlierFraction: idx.length / count, extent, tau: tauCur };
}

/**
 * The same two diagnostics m0/planefit.py's plane_stats reports, computed on the inlier
 * set: flatness (scatter about the plane as a percentage of the region's extent) and the
 * near/far bend (angle between planes fitted to the near half and the far half in image
 * rows). Both go straight to the UI.
 */
export function planeDiagnostics(P, uv, idx) {
  const sub_ = (sel) => fitPlane(P, sel);
  const all = sub_(idx);
  if (!all) return null;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const vs = [];
  for (const i of idx) {
    vs.push(uv[2 * i + 1]);
    for (let a = 0; a < 3; a++) {
      const x = P[3 * i + a];
      if (x < mn[a]) mn[a] = x;
      if (x > mx[a]) mx[a] = x;
    }
  }
  const extent = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  const sorted = vs.slice().sort((a, b) => a - b);
  const medV = sorted[sorted.length >> 1];
  const near = [], far = [];
  for (const i of idx) (uv[2 * i + 1] > medV ? near : far).push(i);
  let nearfar = null;
  if (near.length > 50 && far.length > 50) {
    const a = sub_(near), b = sub_(far);
    if (a && b) {
      const c = Math.min(1, Math.abs(dot(a.n, b.n)));
      nearfar = (Math.acos(c) * 180) / Math.PI;
    }
  }
  return {
    flatnessPct: (100 * all.rms) / extent,
    nearfarDeg: nearfar,
    extent,
    nPoints: idx.length,
  };
}

/** Everything the setup step needs, in one call. */
export function fitSupportPlane(disp, w, h, K, opts = {}) {
  const step = opts.step ?? 3;
  const bp = backproject(disp, w, h, K, step);
  if (bp.count < 200) return { ok: false, reason: 'depth map produced too few usable points' };
  const r = ransacPlane(bp.P, bp.count, opts);
  if (!r) return { ok: false, reason: 'no plane in this frame matched a table-like orientation' };
  const diag = planeDiagnostics(bp.P, bp.uv, r.inlierIdx);
  const inlierPixels = r.inlierIdx.map((i) => [bp.uv[2 * i], bp.uv[2 * i + 1]]);
  return {
    ok: true,
    plane: r.plane,
    inlierFraction: r.inlierFraction,
    inlierPixels,
    step,
    elevationDeg: elevationDeg(r.plane),
    ...diag,
  };
}
