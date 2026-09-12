import { test, assert, close, note } from './harness.js';
import * as G from '../app/src/geometry.js';

const K = G.intrinsics(68, 640, 480);

test('intrinsics round-trip through the field of view', () => {
  close(G.hfovFromFx(K.fx, 640), 68, 1e-9);
});

test('pixel -> plane -> pixel is the identity', () => {
  const plane = G.orient([0, -Math.cos(0.65), -Math.sin(0.65)], -0.45);
  const f = G.planeFrame(plane);
  for (const [u, v] of [[100, 300], [320, 240], [600, 470], [20, 260]]) {
    const p = G.pixelToPlane(K, plane, f, u, v);
    assert(p, `no intersection at ${u},${v}`);
    const q = G.planeToPixel(K, f, p);
    close(q[0], u, 1e-6); close(q[1], v, 1e-6);
  }
});

test('a ray parallel to the plane returns null instead of a huge number', () => {
  // A plane containing the optical axis direction: the horizon row has no intersection.
  const plane = G.orient([0, -1, 0], -0.5);
  const horizon = K.cy; // v where the ray is (x,0,1), perpendicular to n=(0,-1,0)
  assert(G.rayPlane(K, plane, 320, horizon) === null, 'should refuse the horizon row');
});

test('points behind the camera are refused, not clamped', () => {
  // The horizon sits fy*tan(elevation) above the principal point, so it only falls inside
  // the frame at shallow angles. At 15 deg it does, and everything above it is behind the
  // camera -- which must come back as null, not as a large positive distance.
  const plane = G.orient([0, -Math.cos(G.rad(15)), -Math.sin(G.rad(15))], -0.45);
  const horizonV = K.cy - K.fy * Math.tan(G.rad(15));
  assert(horizonV > 4 && horizonV < 470, `horizon should be in frame, got ${horizonV}`);
  let refused = 0;
  for (let v = 0; v < Math.floor(horizonV) - 2; v++) if (G.rayPlane(K, plane, 320, v) === null) refused++;
  assert(refused === Math.floor(horizonV) - 2, `expected every row above the horizon refused, got ${refused}`);
  assert(G.rayPlane(K, plane, 320, Math.ceil(horizonV) + 4) !== null, 'below the horizon must hit');
});

test('elevation matches the M0 definition asin(|n_z|)', () => {
  for (const e of [15, 30, 37, 55]) {
    const p = G.orient([0, -Math.cos(G.rad(e)), -Math.sin(G.rad(e))], -0.4);
    close(G.elevationDeg(p), e, 1e-6);
  }
});

test('tiltPlane tilts by exactly the angle asked for, in any direction', () => {
  const plane = G.orient([0, -Math.cos(0.65), -Math.sin(0.65)], -0.45);
  for (const deg of [0.5, 1.9, 2.9, 8]) {
    for (const az of [0, 1.1, 2.7, 4.9]) {
      const t = G.tiltPlane(plane, deg, az);
      close(G.angleBetween(t.n, plane.n), deg, 1e-6, `tilt ${deg} az ${az}`);
    }
  }
});

test('the plane frame is orthonormal and lies in the plane', () => {
  const plane = G.orient([0.1, -0.8, -0.59], -0.5);
  const n = G.norm3(plane.n);
  const f = G.planeFrame({ n, d: plane.d });
  close(G.dot(f.e1, f.e1), 1, 1e-12);
  close(G.dot(f.e2, f.e2), 1, 1e-12);
  close(G.dot(f.e1, f.e2), 0, 1e-12);
  close(G.dot(f.e1, n), 0, 1e-12);
  close(G.dot(f.e2, n), 0, 1e-12);
  close(G.dot(f.origin, n) - plane.d, 0, 1e-12);
});

note('geometry is exact: every tolerance above is 1e-6 or tighter.');
