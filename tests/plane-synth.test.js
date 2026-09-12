import { test, assert, close, note } from './harness.js';
import * as S from '../app/src/synth.js';
import * as PF from '../app/src/planefit.js';
import * as G from '../app/src/geometry.js';
import * as Conf from '../app/src/confidence.js';
import { FLATNESS_WARN_PCT as C_FLAT_WARN, NEARFAR_WARN_DEG as C_BEND_WARN } from '../app/src/constants.js';

const fitFor = (scene, dispOpts, fitOpts) => {
  const fr = S.renderFrame(scene, [0, 0.55], 0.02);
  const disp = S.disparityFrom(fr, dispOpts);
  return PF.fitSupportPlane(disp, scene.W, scene.H, scene.K, { step: 3, ...fitOpts });
};

test('exact depth recovers the plane to 0.1 deg across the angles the app is FOR', () => {
  let worst = 0;
  for (const pitch of [30, 33, 37, 40, 45, 50, 55, 60, 65]) {
    const scene = S.makeScene({ pitchDeg: pitch });
    const fit = fitFor(scene, {});
    assert(fit.ok, `no plane at ${pitch} deg`);
    worst = Math.max(worst, G.angleBetween(fit.plane.n, scene.plane.n));
    close(fit.elevationDeg, pitch, 0.1, `elevation at ${pitch}`);
  }
  assert(worst < 0.1, `worst error ${worst.toFixed(3)} deg`);
  note(`30-65 deg elevation, exact geometry: worst plane error ${worst.toFixed(3)} deg`);
});

test('below 30 deg the fit is looser, which is why the app warns there', () => {
  // At a shallow angle the table is heavily foreshortened and a large part of the frame is
  // background, so RANSAC has less to work with. It stays inside the 5 deg budget but it is
  // an order of magnitude worse than at 37 deg -- and 37 deg is the only regime anything
  // has been measured in. The widened band at these angles is not decoration.
  let worst = 0;
  for (const pitch of [16, 18, 20, 22, 25]) {
    const scene = S.makeScene({ pitchDeg: pitch });
    worst = Math.max(worst, G.angleBetween(fitFor(scene, {}).plane.n, scene.plane.n));
  }
  assert(worst < 1.6, `worst error ${worst.toFixed(3)} deg below 30 deg`);
  note(`16-25 deg elevation, exact geometry: worst plane error ${worst.toFixed(3)} deg`);
});

test('the plane fit is deterministic -- the same frame always gives the same plane', () => {
  const scene = S.makeScene({ pitchDeg: 37 });
  const a = fitFor(scene, {});
  const b = fitFor(scene, {});
  for (let i = 0; i < 3; i++) close(a.plane.n[i], b.plane.n[i], 0);
  close(a.inlierFraction, b.inlierFraction, 0);
});

test('an unknown disparity offset rotates the plane -- the failure m0 README 5 proves', () => {
  // This is the whole reason the M0 gate did not run on the near/far bend metric. A global
  // additive offset on the model's output leaves the surface perfectly flat and perfectly
  // un-bent, while turning it by degrees. The app's band is sized for exactly this error.
  const scene = S.makeScene({ pitchDeg: 37 });
  const rows = [];
  for (const shift of [0, 0.05, 0.1, 0.2, 0.4]) {
    const fit = fitFor(scene, { shift });
    rows.push([shift, G.angleBetween(fit.plane.n, scene.plane.n), fit.flatnessPct, fit.nearfarDeg ?? 0]);
  }
  assert(rows[0][1] < 0.1, 'no offset should be exact');
  assert(rows[4][1] > 3.0, `a 0.4 offset should turn the plane by degrees, got ${rows[4][1].toFixed(2)}`);
  for (const r of rows) {
    assert(r[2] < 0.01, `flatness stays ~0 despite a ${r[0]} offset (it saw nothing)`);
    assert(r[3] < 0.05, `the bend metric stays ~0 despite a ${r[0]} offset (it is blind to this)`);
  }
  note('offset ' + rows.map((r) => `${r[0]}->${r[1].toFixed(2)}deg`).join('  ')
    + '  |  bend metric stayed below 0.05 deg throughout');
});

test('the quoted 2.9 deg sigma is the right size for the offsets m0.json actually saw', () => {
  // m0.json records the best-fit disparity offset on each of the owner's photos as
  // 1-11 % of that region's own disparity range. Scaled to this scene's range (1.316),
  // that bracket produces exactly the error the app tells the user to expect.
  const scene = S.makeScene({ pitchDeg: 37 });
  const range = 1.316;
  const at = (frac) => G.angleBetween(fitFor(scene, { shift: frac * range }).plane.n, scene.plane.n);
  const lo = at(0.01), hi = at(0.11);
  assert(lo < 0.6, `1 % of range should be nearly free, got ${lo.toFixed(2)}`);
  assert(hi > 1.5 && hi < 3.5, `11 % of range should land near the quoted sigma, got ${hi.toFixed(2)}`);
  note(`disparity offset 1 % of range -> ${lo.toFixed(2)} deg, 11 % -> ${hi.toFixed(2)} deg; `
    + 'the band assumes 2.9 deg (1 sigma)');
});

test('a warped depth map raises the bend metric, which is what it IS for', () => {
  const scene = S.makeScene({ pitchDeg: 37 });
  const flat = fitFor(scene, {});
  const warped = fitFor(scene, { warp: 0.04 });
  assert((warped.nearfarDeg ?? 0) > (flat.nearfarDeg ?? 0) + 0.5,
    `bend should rise: ${flat.nearfarDeg} -> ${warped.nearfarDeg}`);
  assert(warped.flatnessPct > flat.flatnessPct, 'flatness should rise too');
  note(`bend ${(flat.nearfarDeg ?? 0).toFixed(2)} -> ${warped.nearfarDeg.toFixed(2)} deg, `
    + `flatness ${flat.flatnessPct.toFixed(3)} -> ${warped.flatnessPct.toFixed(3)} %`);
});

test('a hugely warped surface is refused -- it stops looking like a table at all', () => {
  const scene = S.makeScene({ pitchDeg: 37 });
  const fit = fitFor(scene, { warp: 0.8 });
  assert(Conf.worst(Conf.checkPlane(fit)) === 'refuse',
    `expected refusal: ${JSON.stringify({ flat: fit.flatnessPct, bend: fit.nearfarDeg, cov: fit.inlierFraction })}`);
});

test('KNOWN BLIND SPOT: a moderate warp gives a badly wrong plane no diagnostic catches', () => {
  // This test exists to record a limitation, not to celebrate a feature. At warp 0.2 the
  // RANSAC latches onto a locally-flat sub-patch of a curved surface: flatness reads a
  // clean 0.09 %, the bend metric reads 3.2 deg (inside the range the owner's real photos
  // occupy), coverage is normal -- and the plane is more than 20 deg wrong.
  //
  // It is the same class of blindness m0/README.md section 5 proves for the disparity
  // offset: a frame does not contain the evidence. Two things were tried and neither
  // separated it from real data -- the fraction of the surface's bounding box left
  // unexplained, and the bend metric recomputed at a looser inlier threshold.
  //
  // In this particular case the elevation check happens to fire, because a plane 20 deg
  // wrong is also at an untested angle. That is luck. If someone adds a real detector,
  // this test should start failing on the last assertion -- that is the point of it.
  const scene = S.makeScene({ pitchDeg: 37 });
  const fit = fitFor(scene, { warp: 0.2 });
  const err = G.angleBetween(fit.plane.n, scene.plane.n);
  assert(err > 10, `expected a badly wrong plane, got ${err.toFixed(1)} deg`);
  assert(fit.flatnessPct < C_FLAT_WARN, 'flatness looks clean -- that is the blind spot');
  assert((fit.nearfarDeg ?? 0) < C_BEND_WARN, 'bend looks normal -- that is the blind spot');
  assert(Conf.worst(Conf.checkPlane(fit)) !== 'refuse',
    'still not refused: if this now fails, a real detector was added -- update the note in README');
  note(`warp 0.2: plane ${err.toFixed(1)} deg wrong, flatness ${fit.flatnessPct.toFixed(3)} %, `
    + `bend ${(fit.nearfarDeg ?? 0).toFixed(2)} deg -- undetectable from one frame`);
});

test('a camera at an untested elevation warns, and widens the band', () => {
  const inside = S.makeScene({ pitchDeg: 37 });
  const outside = S.makeScene({ pitchDeg: 25 });
  const fIn = fitFor(inside, {}), fOut = fitFor(outside, {});
  assert(Conf.worst(Conf.checkPlane(fIn)) === 'ok', 'inside the tested band should be silent');
  const w = Conf.checkPlane(fOut);
  assert(w.some((i) => i.code === 'untested-angle'), 'outside should warn');
  assert(Conf.planeSigmaFor(fOut, 2.9) > Conf.planeSigmaFor(fIn, 2.9), 'sigma should grow');
  note(`sigma 37 deg: ${Conf.planeSigmaFor(fIn, 2.9).toFixed(2)}, `
    + `25 deg: ${Conf.planeSigmaFor(fOut, 2.9).toFixed(2)}`);
});

test('a camera pointed almost straight down is refused', () => {
  const scene = S.makeScene({ pitchDeg: 80, camH: 0.5 });
  const fit = fitFor(scene, {});
  const issues = Conf.checkPlane(fit);
  assert(Conf.worst(issues) === 'refuse', `expected refusal at 80 deg, got ${Conf.worst(issues)}`);
});
