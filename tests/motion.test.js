/**
 * Camera motion. ROADMAP.md risk 5 calls this the failure that "silently invalidates the
 * plane", and it is the most likely way the app is wrong in someone's hands, because
 * nothing on screen looks different when it happens.
 *
 * The detector has to separate two things that both change pixels: the camera moving, and
 * something in the scene moving. Getting that wrong in either direction is bad -- a false
 * positive makes the app unusable while a ball rolls, a false negative is the silent
 * failure itself.
 */
import { test, assert, note } from './harness.js';
import * as S from '../app/src/synth.js';
import { MotionWatch, fingerprint, compare } from '../app/src/motion.js';
import * as Conf from '../app/src/confidence.js';
import * as C from '../app/src/constants.js';

const scene = (o = {}) => S.makeScene({ W: 480, H: 360, pitchDeg: o.pitchDeg ?? 37, hfovDeg: o.hfov ?? 60 });

function watchFor(frames, dtEach = 0.1) {
  const w = new MotionWatch();
  w.setReference(frames[0].rgba, frames[0].w, frames[0].h);
  let t = 0, last = null;
  for (const f of frames.slice(1)) { t += dtEach; last = w.update(f.rgba, f.w, f.h, t); }
  return last;
}

test('a ball rolling across a static frame is NOT called camera motion', () => {
  const sc = scene();
  const frames = [];
  for (const p of [[-0.15, 0.42], [-0.05, 0.5], [0.05, 0.58], [0.15, 0.66], [0.25, 0.74]]) {
    frames.push(S.renderFrame(sc, p, 0.02));
  }
  const m = watchFor(frames);
  assert(!m.moved, `false positive: shift ${m.shiftPx.toFixed(2)} px, residual ${m.residual.toFixed(4)}`);
  note(`ball rolling: shift ${m.shiftThumb.toFixed(2)} thumb-px, residual ${m.residual.toFixed(4)} `
    + `(thresholds ${C.MOTION_SHIFT_REFUSE_PX} and ${C.MOTION_RESIDUAL_REFUSE})`);
});

test('the camera being bumped by 2 degrees IS caught', () => {
  const before = S.renderFrame(scene({ pitchDeg: 37 }), [-0.1, 0.5], 0.02);
  const after = S.renderFrame(scene({ pitchDeg: 39 }), [-0.1, 0.5], 0.02);
  const m = watchFor([before, after, after, after, after, after]);
  assert(m.moved, `missed a 2 deg bump: shift ${m.shiftThumb.toFixed(2)}, residual ${m.residual.toFixed(4)}`);
  note(`2 deg camera bump: shift ${m.shiftThumb.toFixed(2)} thumb-px, residual ${m.residual.toFixed(4)}`);
});

test('the camera being zoomed / moved closer IS caught', () => {
  const before = S.renderFrame(scene({ hfov: 60 }), [-0.1, 0.5], 0.02);
  const after = S.renderFrame(scene({ hfov: 54 }), [-0.1, 0.5], 0.02);
  const m = watchFor([before, after, after, after, after, after]);
  assert(m.moved, `missed a 6 deg field-of-view change: residual ${m.residual.toFixed(4)}`);
});

test('one bad frame is not a moved camera -- the condition has to persist', () => {
  const sc = scene();
  const good = S.renderFrame(sc, [-0.1, 0.5], 0.02);
  const bumped = S.renderFrame(scene({ pitchDeg: 42 }), [-0.1, 0.5], 0.02);
  const w = new MotionWatch();
  w.setReference(good.rgba, good.w, good.h);
  const a = w.update(bumped.rgba, bumped.w, bumped.h, 0.05);
  assert(a.bad, 'the frame should be flagged as bad');
  assert(!a.moved, 'but not yet reported as moved');
  const b = w.update(good.rgba, good.w, good.h, 0.10);
  assert(!b.moved && !b.bad, 'and recovering should clear it');
  // Now hold it.
  w.update(bumped.rgba, bumped.w, bumped.h, 0.20);
  const c = w.update(bumped.rgba, bumped.w, bumped.h, 0.20 + C.MOTION_HOLD_S + 0.01);
  assert(c.moved, 'held past MOTION_HOLD_S it must report moved');
});

test('a moved camera produces a refusal, not a warning', () => {
  const before = S.renderFrame(scene({ pitchDeg: 37 }), [-0.1, 0.5], 0.02);
  const after = S.renderFrame(scene({ pitchDeg: 41 }), [-0.1, 0.5], 0.02);
  const m = watchFor([before, after, after, after, after, after]);
  const issues = Conf.checkMotion(m);
  assert(Conf.worst(issues) === 'refuse', 'camera motion must refuse');
  assert(Conf.worst(Conf.checkMotion({ moved: false })) === 'ok');
});

test('the fingerprint comparison finds the shift it was given', () => {
  const sc = scene();
  const f = S.renderFrame(sc, [-0.1, 0.5], 0.02);
  const shifted = { rgba: new Uint8ClampedArray(f.rgba.length), w: f.w, h: f.h };
  const dx = 8;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const sx = Math.min(f.w - 1, x + dx);
      for (let c = 0; c < 4; c++) shifted.rgba[(y * f.w + x) * 4 + c] = f.rgba[(y * f.w + sx) * 4 + c];
    }
  }
  const c = compare(fingerprint(f.rgba, f.w, f.h), fingerprint(shifted.rgba, f.w, f.h));
  const expected = dx / (f.w / C.MOTION_GRID_W);
  assert(Math.abs(c.shiftThumb - expected) <= 1.01,
    `expected about ${expected.toFixed(1)} thumb-px, got ${c.shiftThumb.toFixed(1)}`);
});
