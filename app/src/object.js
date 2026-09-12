/**
 * Mask -> the three numbers the simulation needs: where the ball touches the table, how
 * big it is, and whether the depth map is behaving in that neighbourhood.
 *
 * The contact point is taken from the mask's LOWER EDGE, not its centroid. ROADMAP.md
 * risk 3: unprojecting a centroid onto the plane is biased by roughly the object's radius,
 * and that is a systematic error no amount of good depth fixes.
 */
import { ray, rayPlane, dot, ballRadiusRel } from './geometry.js';

export function analyseMask(mask, w, h, K, plane, disp, planeRms, extent) {
  let n = 0, minU = 1e9, maxU = -1e9, minV = 1e9, maxV = -1e9;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      if (!mask[v * w + u]) continue;
      n++;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
  }
  if (n < 10) return { ok: false, reason: 'the mask was empty' };

  const touchesEdge = minU <= 1 || minV <= 1 || maxU >= w - 2 || maxV >= h - 2;

  // Contact point: horizontal centroid of the bottom three occupied rows.
  let su = 0, sn = 0;
  for (let v = maxV; v > maxV - 3 && v >= 0; v--) {
    for (let u = 0; u < w; u++) if (mask[v * w + u]) { su += u; sn++; }
  }
  const contactU = sn ? su / sn : (minU + maxU) / 2;
  const contactV = maxV;

  // Radius from area: for a sphere the silhouette is a disc, so sqrt(A/pi) is the best
  // estimator available and is far less noisy than a bbox half-width.
  const radiusPx = Math.sqrt(n / Math.PI);
  const bboxAspect = (maxU - minU + 1) / Math.max(1, maxV - minV + 1);

  const X = rayPlane(K, plane, contactU, contactV);
  if (!X) return { ok: false, reason: 'the contact point\'s ray does not meet the fitted plane in front of the camera' };
  const rRel = ballRadiusRel(radiusPx, X[2], K.fx, plane.n[2]);
  if (!rRel) return { ok: false, reason: 'the object\'s size on the plane could not be solved' };

  // Is the plane actually right HERE? Sample table pixels in a ring 1.5-3 ball radii
  // around the contact point, excluding the object, and compare them to the plane.
  let s2 = 0, sres = 0, m = 0;
  const r0 = 1.5 * radiusPx, r1 = 3.5 * radiusPx;
  for (let v = Math.max(0, Math.round(contactV - r1)); v < Math.min(h, contactV + r1); v++) {
    for (let u = Math.max(0, Math.round(contactU - r1)); u < Math.min(w, contactU + r1); u++) {
      const rr = Math.hypot(u - contactU, v - contactV);
      if (rr < r0 || rr > r1) continue;
      if (mask[v * w + u]) continue;
      const dv = disp[v * w + u];
      if (!(dv > 1e-3)) continue;
      const z = 1 / dv;
      const rv = ray(K, u, v);
      const res = dot([rv[0] * z, rv[1] * z, z], plane.n) - plane.d;
      s2 += res * res; sres += res; m++;
    }
  }
  const localRms = m > 8 ? Math.sqrt(s2 / m) : null;
  const localBias = m > 8 ? sres / m : null;

  return {
    ok: true,
    maskPx: n,
    areaFraction: n / (w * h),
    bbox: [minU, minV, maxU, maxV],
    bboxAspect,
    touchesEdge,
    contactPixel: [contactU, contactV],
    contactCam: X,
    radiusPx,
    radiusRel: rRel,
    localNoise: localRms != null && planeRms > 0 ? localRms / planeRms : null,
    contactOffPlane: localBias != null && rRel > 0 ? Math.abs(localBias) / rRel : null,
  };
}
