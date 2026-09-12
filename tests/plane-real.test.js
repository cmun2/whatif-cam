/**
 * The app's own plane path, on the owner's own eleven photos.
 *
 * Fixtures are produced by `.venv/bin/python tests/make-fixtures.py`: the int8 depth
 * model's output at the working resolution, plus the four-tap reference plane the M0 gate
 * measured against. They are gitignored, so this file skips on a fresh clone.
 *
 * The comparison is the same one M0 made -- depth plane versus four-tap plane -- but
 * through the APP's code: whole-frame RANSAC with no tapped quad, which is what a user
 * will actually get.
 */
import { test, assert, skip, note } from './harness.js';
import * as PF from '../app/src/planefit.js';
import * as G from '../app/src/geometry.js';
import * as Conf from '../app/src/confidence.js';
import { readFileSync, existsSync } from 'node:fs';

const dir = new URL('./fixtures/', import.meta.url);
const indexPath = new URL('index.json', dir);

if (!existsSync(indexPath)) {
  skip('the app plane agrees with the M0 four-tap reference on all eleven photos',
    'no tests/fixtures -- run: .venv/bin/python tests/make-fixtures.py');
} else {
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));

  /** Is a pixel inside the M0 four-tap quad, and if not, how far outside? */
  const inQuad = (q, u, v) => {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = q[i], [xj, yj] = q[j];
      if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const distToQuad = (q, u, v) => {
    let best = Infinity;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [ax, ay] = q[j], [bx, by] = q[i];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(u - (ax + t * dx), v - (ay + t * dy)));
    }
    return best;
  };

  const results = index.map((f) => {
    const b = readFileSync(new URL(`${f.stem}.disp.f32`, dir));
    const disp = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
    const rgbPath = new URL(`${f.stem}.rgb`, dir);
    let lum = null;
    if (existsSync(rgbPath)) {
      const rgb = readFileSync(rgbPath);
      lum = new Float32Array(f.w * f.h);
      for (let i = 0; i < lum.length; i++) {
        lum[i] = (0.299 * rgb[3 * i] + 0.587 * rgb[3 * i + 1] + 0.114 * rgb[3 * i + 2]) / 255;
      }
    }
    const K = G.intrinsics(f.fov_deg, f.w, f.h);
    const fit = PF.fitSupportPlane(disp, f.w, f.h, K, { step: 3, lum });
    const raw = PF.fitSupportPlane(disp, f.w, f.h, K, { step: 3 });
    const leak = (ft) => ft.inlierPixels.filter(([u, v]) =>
      !inQuad(f.quad, u, v) && distToQuad(f.quad, u, v) > 20).length;
    const onTable = (ft) => ft.inlierPixels.filter(([u, v]) => inQuad(f.quad, u, v)).length;
    let qtot = 0;
    for (let v = 0; v < f.h; v += 3) for (let u = 0; u < f.w; u += 3) if (inQuad(f.quad, u, v)) qtot++;
    return {
      f, fit, raw,
      err: G.angleBetween(fit.plane.n, f.quad_normal),
      rawErr: G.angleBetween(raw.plane.n, f.quad_normal),
      leak: leak(fit), rawLeak: leak(raw),
      recall: onTable(fit) / qtot,
      issues: Conf.checkPlane(fit),
    };
  });
  const errs = results.map((r) => r.err).sort((a, b) => a - b);
  const median = errs[errs.length >> 1];

  test('every photo lands inside the 5 deg budget ROADMAP.md set', () => {
    for (const r of results) {
      assert(r.err < 5, `${r.f.stem}: ${r.err.toFixed(2)} deg`);
    }
    note(`median ${median.toFixed(2)} deg, range ${errs[0].toFixed(2)}-${errs[errs.length - 1].toFixed(2)}`
      + ` (M0's own int8 figure over a hand-delimited region: 2.92 deg)`);
  });

  test('the plane error the band assumes is not optimistic', () => {
    // The app tells the user +/- 2.9 deg (1 sigma) for the int8 model. If the observed
    // median on real photos were larger than that, the band would be a lie.
    assert(median <= 2.9, `observed median ${median.toFixed(2)} vs quoted sigma 2.9`);
  });

  test('none of the eleven is refused, and none of them warns', () => {
    for (const r of results) {
      const w = Conf.worst(r.issues);
      assert(w !== 'refuse', `${r.f.stem} refused: ${r.issues.map((i) => i.code)}`);
      assert(w === 'ok', `${r.f.stem} warned: ${r.issues.map((i) => i.code)}`);
    }
  });

  test('the fitted surface covers enough of each frame to be a table', () => {
    for (const r of results) {
      assert(r.fit.inlierFraction > 0.2,
        `${r.f.stem}: only ${(100 * r.fit.inlierFraction).toFixed(0)} %`);
    }
    const fr = results.map((r) => r.fit.inlierFraction);
    note(`surface coverage ${(100 * Math.min(...fr)).toFixed(0)}-${(100 * Math.max(...fr)).toFixed(0)} % of frame`);
  });

  test('the fitted surface is the TABLETOP, not everything coplanar with it', () => {
    // The defect this catches: whole-frame RANSAC finds a plane that the carpet beside the
    // owner's table and the partition behind it also lie near, so the app claimed a surface
    // that reached up to 188 px past the table's edge and predicted the ball rolling onto
    // the floor. No inlier threshold separates them -- they really are near-coplanar.
    // Appearance does.
    for (const r of results) {
      assert(r.fit.separated, `${r.f.stem}: the appearance gate fell back`);
      assert(r.leak === 0,
        `${r.f.stem}: ${r.leak} fitted points more than 20 px outside the tabletop`);
      assert(r.recall > 0.75,
        `${r.f.stem}: kept only ${(100 * r.recall).toFixed(0)} % of the tabletop`);
    }
    const rawLeaks = results.map((r) => r.rawLeak).sort((a, b) => a - b);
    const recalls = results.map((r) => r.recall);
    note(`points >20 px off the tabletop: geometry alone median ${rawLeaks[rawLeaks.length >> 1]} `
      + `(max ${rawLeaks[rawLeaks.length - 1]}) -> with the appearance gate, 0 on every photo`);
    note(`tabletop kept: ${(100 * Math.min(...recalls)).toFixed(0)}-${(100 * Math.max(...recalls)).toFixed(0)} %`);
  });

  test('and cleaning up the surface does not move the plane', () => {
    // Worth stating plainly: the leak was neither flattering nor punishing the plane
    // number. 2.7 deg was right, for the wrong-looking reason.
    const e = results.map((r) => r.err).sort((a, b) => a - b);
    const re = results.map((r) => r.rawErr).sort((a, b) => a - b);
    const med = (a) => a[a.length >> 1];
    assert(Math.abs(med(e) - med(re)) < 0.15,
      `median moved ${med(re).toFixed(2)} -> ${med(e).toFixed(2)}`);
    note('per photo, geometry only -> appearance gated: '
      + results.map((r) => `${r.f.stem.slice(4)} ${r.rawErr.toFixed(2)}->${r.err.toFixed(2)}`).join(', '));
  });

  test('the recovered elevation matches what M0 measured for these photos', () => {
    const es = results.map((r) => r.fit.elevationDeg);
    note(`elevation ${Math.min(...es).toFixed(1)}-${Math.max(...es).toFixed(1)} deg `
      + `(M0 quoted 34.8-40.2 from the tapped quads)`);
    for (const e of es) assert(e > 30 && e < 46, `elevation ${e.toFixed(1)} is nowhere near M0's`);
  });
}
