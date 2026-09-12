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
  const results = index.map((f) => {
    const b = readFileSync(new URL(`${f.stem}.disp.f32`, dir));
    const disp = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
    const K = G.intrinsics(f.fov_deg, f.w, f.h);
    const fit = PF.fitSupportPlane(disp, f.w, f.h, K, { step: 3 });
    return { f, fit, err: G.angleBetween(fit.plane.n, f.quad_normal), issues: Conf.checkPlane(fit) };
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

  test('the recovered elevation matches what M0 measured for these photos', () => {
    const es = results.map((r) => r.fit.elevationDeg);
    note(`elevation ${Math.min(...es).toFixed(1)}-${Math.max(...es).toFixed(1)} deg `
      + `(M0 quoted 34.8-40.2 from the tapped quads)`);
    for (const e of es) assert(e > 30 && e < 46, `elevation ${e.toFixed(1)} is nowhere near M0's`);
  });
}
