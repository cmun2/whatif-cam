/**
 * Pinhole camera + support plane. Pure functions, no DOM, no I/O.
 *
 * Conventions are OpenCV's and match probe/scene.py exactly: x right, y DOWN, z forward.
 * A plane is {n, d} with n a unit normal satisfying n . X = d for points X on it. The
 * normal is always oriented "up" in the world sense, which in this frame means n[1] < 0.
 */

export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

/** Intrinsics from a horizontal field of view. Square pixels, principal point centred. */
export function intrinsics(hfovDeg, W, H) {
  const fx = W / 2 / Math.tan(rad(hfovDeg) / 2);
  return { fx, fy: fx, cx: W / 2, cy: H / 2, W, H };
}

export function hfovFromFx(fx, W) {
  return deg(2 * Math.atan(W / 2 / fx));
}

/** Unit-z ray through a pixel (not normalised: z == 1, which is what back-projection wants). */
export function ray(K, u, v) {
  return [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1];
}

export function project(K, X) {
  return [(K.fx * X[0]) / X[2] + K.cx, (K.fy * X[1]) / X[2] + K.cy];
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function norm3(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** Angle in degrees between two directions, ignoring sign (planes have no front). */
export function angleBetween(a, b) {
  const c = Math.min(1, Math.max(-1, Math.abs(dot(norm3(a), norm3(b)))));
  return deg(Math.acos(c));
}

/**
 * Where a pixel's ray meets the plane. Returns null when the ray is parallel to the
 * plane, grazes it, or meets it behind the camera -- all of which are real conditions the
 * caller must refuse on rather than paper over with a clamp.
 */
export function rayPlane(K, plane, u, v) {
  const r = ray(K, u, v);
  const den = dot(r, plane.n);
  if (Math.abs(den) < 1e-9) return null;
  const t = plane.d / den;
  if (!(t > 0) || !isFinite(t)) return null;
  return scale3(r, t);
}

/**
 * An orthonormal 2D frame lying in the plane. Identical construction to
 * probe/analyze2.py's frame(): e1 is the camera's x axis projected into the plane, so the
 * in-plane coordinates are "screen right" and "away from the camera along the table".
 */
export function planeFrame(plane) {
  const origin = scale3(plane.n, plane.d);
  let e1 = [1, 0, 0];
  e1 = norm3(sub(e1, scale3(plane.n, dot(e1, plane.n))));
  if (!isFinite(e1[0])) e1 = norm3(sub([0, 0, 1], scale3(plane.n, dot([0, 0, 1], plane.n))));
  const e2 = norm3(cross(plane.n, e1));
  return { origin, e1, e2 };
}

export function camToPlane(frame, X) {
  const w = sub(X, frame.origin);
  return [dot(w, frame.e1), dot(w, frame.e2)];
}

export function planeToCam(frame, p) {
  return add(frame.origin, add(scale3(frame.e1, p[0]), scale3(frame.e2, p[1])));
}

/** Pixel -> in-plane 2D, or null if the ray misses the plane usefully. */
export function pixelToPlane(K, plane, frame, u, v) {
  const X = rayPlane(K, plane, u, v);
  return X ? camToPlane(frame, X) : null;
}

export function planeToPixel(K, frame, p) {
  const X = planeToCam(frame, p);
  if (!(X[2] > 1e-6)) return null;
  return project(K, X);
}

/**
 * Camera elevation above the plane, in degrees: the angle between the optical axis and
 * the table surface. asin(|n_z|), which is how m0/README.md section 6 quotes the
 * 34.8-40.2 deg spread of the owner's photos.
 */
export function elevationDeg(plane) {
  return deg(Math.asin(Math.min(1, Math.abs(plane.n[2]))));
}

/** Rotate a vector about a unit axis by `angle` radians (Rodrigues). */
export function rotateAbout(v, axis, angle) {
  const k = norm3(axis);
  const c = Math.cos(angle), s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
}

/**
 * Tilt a plane's normal by `tiltDeg` about an axis in the plane at `azimuth`.
 * Used by the Monte-Carlo band to sample "what if the plane is wrong by this much".
 * The offset d is kept, which is the right thing: the camera height above the surface is
 * not what the tilt error is about.
 */
export function tiltPlane(plane, tiltDeg, azimuthRad) {
  const f = planeFrame(plane);
  const axis = norm3([
    f.e1[0] * Math.cos(azimuthRad) + f.e2[0] * Math.sin(azimuthRad),
    f.e1[1] * Math.cos(azimuthRad) + f.e2[1] * Math.sin(azimuthRad),
    f.e1[2] * Math.cos(azimuthRad) + f.e2[2] * Math.sin(azimuthRad),
  ]);
  let n = norm3(rotateAbout(plane.n, axis, rad(tiltDeg)));
  let d = plane.d;
  if (n[1] > 0) { n = scale3(n, -1); d = -d; }
  // |d| is kept: "the plane is tilted by 2 deg" means the surface turned, not that the
  // camera changed height above it. The contact point still moves, because its ray
  // re-intersects a differently-oriented plane -- which is the error being modelled.
  return { n, d };
}

/** Normalise a fitted plane so that n points "up" (negative y) and d has the matching sign. */
export function orient(n, d) {
  if (n[1] > 0) return { n: scale3(n, -1), d: -d };
  return { n, d };
}


/**
 * The ball's radius in the depth map's own units, solved exactly rather than approximated.
 *
 * The naive `radius_px * z_contact / f` is wrong by the same kind of radius-sized bias that
 * ROADMAP.md risk 3 warns about for the contact point. The silhouette's pixel radius
 * corresponds to the distance to the ball's CENTRE, which is one radius up the plane
 * normal from the contact point -- and the radius is what we are trying to find. Writing
 * that out:
 *     r = rho * z_centre / f  and  z_centre = z_contact + n_z * r
 *  => r = (rho * z_contact / f) / (1 - rho * n_z / f)
 * Measured on the synthetic table: the approximation put the metric scale 2.2 % out, which
 * is 2.7 % on the speed and 5 % on the distance -- a systematic error, in the same
 * direction every time.
 */
export function ballRadiusRel(radiusPx, zContact, fx, planeNz) {
  const den = 1 - (radiusPx * planeNz) / fx;
  if (!(den > 1e-6)) return null;
  const r = (radiusPx * zContact) / fx / den;
  return r > 0 ? r : null;
}
