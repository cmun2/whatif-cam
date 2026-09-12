/**
 * Every condition under which the app declines to draw. These are the product.
 */
import { test, assert, note } from './harness.js';
import * as Conf from '../app/src/confidence.js';
import * as C from '../app/src/constants.js';

// Typical of the owner's eleven photos, measured through the app's own code path with the
// appearance gate on: coverage 0.23-0.29, flatness 0.27-0.36 %, bend 2.4-3.7 deg.
const goodFit = {
  ok: true, inlierFraction: 0.27, flatnessPct: 0.31, nearfarDeg: 3.2,
  elevationDeg: 38, plane: { n: [0, -0.8, -0.6], d: -0.45 }, extent: 2, separated: true,
};
const goodTap = {
  ok: true, maskPx: 900, areaFraction: 0.01, touchesEdge: false,
  contactOffPlane: 0.3, localNoise: 1.1,
};

test('a good scene raises nothing at all', () => {
  assert(Conf.worst(Conf.checkPlane(goodFit)) === 'ok', JSON.stringify(Conf.checkPlane(goodFit)));
  assert(Conf.worst(Conf.checkTap(goodTap)) === 'ok');
});

const planeCases = [
  ['no plane at all', { ok: false, reason: 'x' }, 'no-plane'],
  ['a surface that covers almost nothing', { ...goodFit, inlierFraction: 0.05 }, 'small-surface'],
  ['a surface that is not flat', { ...goodFit, flatnessPct: 2.4 }, 'not-flat'],
  ['a surface that is bent', { ...goodFit, nearfarDeg: 20 }, 'bent'],
  ['a camera nearly level with the table', { ...goodFit, elevationDeg: 9 }, 'too-shallow'],
  ['a camera nearly straight down', { ...goodFit, elevationDeg: 80 }, 'too-steep'],
];
for (const [name, fit, code] of planeCases) {
  test(`REFUSES: ${name}`, () => {
    const issues = Conf.checkPlane(fit);
    assert(Conf.worst(issues) === 'refuse', `expected refuse, got ${Conf.worst(issues)}`);
    assert(issues.some((i) => i.code === code), `expected ${code}, got ${issues.map((i) => i.code)}`);
    for (const i of issues) {
      assert(i.title && i.detail && i.detail.length > 30,
        `${i.code} must explain itself in the UI, not just name itself`);
    }
  });
}

const warnCases = [
  ['a surface that could not be separated from its surroundings',
    { ...goodFit, separated: false, separationNote: 'no image was supplied.' }, 'unseparated'],
  ['a noisy depth map', { ...goodFit, flatnessPct: 0.9 }, 'flatness'],
  ['a slightly bent surface', { ...goodFit, nearfarDeg: 8 }, 'bend'],
  ['an untested camera angle', { ...goodFit, elevationDeg: 28 }, 'untested-angle'],
];
for (const [name, fit, code] of warnCases) {
  test(`WARNS: ${name}`, () => {
    const issues = Conf.checkPlane(fit);
    assert(Conf.worst(issues) === 'warn', `expected warn, got ${Conf.worst(issues)}`);
    assert(issues.some((i) => i.code === code));
  });
}

const tapCases = [
  ['nothing segmented', { ok: false, reason: 'x' }, 'no-mask'],
  ['a tap that selected the whole table', { ...goodTap, areaFraction: 0.5 }, 'mask-too-big'],
  ['an object too small to measure', { ...goodTap, maskPx: 20 }, 'mask-too-small'],
  ['an object running off the frame', { ...goodTap, touchesEdge: true }, 'mask-edge'],
  ['an object not resting on the fitted plane', { ...goodTap, contactOffPlane: 5 }, 'off-plane'],
  ['a tap where the depth map is unreliable', { ...goodTap, localNoise: 4 }, 'noisy-tap'],
];
for (const [name, tap, code] of tapCases) {
  test(`REFUSES: ${name}`, () => {
    const issues = Conf.checkTap(tap);
    assert(Conf.worst(issues) === 'refuse', `expected refuse, got ${Conf.worst(issues)}`);
    assert(issues.some((i) => i.code === code), `expected ${code}, got ${issues.map((i) => i.code)}`);
  });
}

test('the widened error bar grows with distance outside the tested angles', () => {
  const base = Conf.planeSigmaFor(goodFit, C.PLANE_SIGMA_INT8_DEG);
  const a = Conf.planeSigmaFor({ ...goodFit, elevationDeg: 25 }, C.PLANE_SIGMA_INT8_DEG);
  const b = Conf.planeSigmaFor({ ...goodFit, elevationDeg: 18 }, C.PLANE_SIGMA_INT8_DEG);
  assert(base < a && a < b, `${base} < ${a} < ${b}`);
  note(`plane sigma: 38 deg ${base.toFixed(2)}, 25 deg ${a.toFixed(2)}, 18 deg ${b.toFixed(2)}`);
});

test('a prediction that is still moving at the horizon warns rather than faking a stop', () => {
  const issues = Conf.checkPrediction({
    ok: true, timedOutFraction: 0.8, leftSurfaceFraction: 0,
    stopEllipse: { rx: 5, ry: 5 }, stopDistanceM: { p5: 1, p50: 2, p95: 3 },
  }, {});
  assert(issues.some((i) => i.code === 'still-rolling'));
});

test('a prediction that leaves the measured surface says so', () => {
  const issues = Conf.checkPrediction({
    ok: true, timedOutFraction: 0, leftSurfaceFraction: 0.9,
    stopEllipse: { rx: 5, ry: 5 }, stopDistanceM: { p5: 0.2, p50: 0.22, p95: 0.25 },
  }, {});
  assert(issues.some((i) => i.code === 'off-table'));
});

test('a band as wide as the roll is called out', () => {
  const issues = Conf.checkPrediction({
    ok: true, timedOutFraction: 0, leftSurfaceFraction: 0,
    stopEllipse: { rx: 40, ry: 20 }, stopDistanceM: { p5: 0.06, p50: 0.22, p95: 0.42 },
  }, {});
  assert(issues.some((i) => i.code === 'band-huge'), 'the default friction guess makes this common');
});
