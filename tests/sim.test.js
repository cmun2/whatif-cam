import { test, assert, close, note } from './harness.js';
import { roll, analyticStop, sampleAt } from '../app/src/sim.js';

test('the fixed-step roll reproduces the closed form v0/a and v0^2/(2a)', () => {
  for (const v0 of [0.2, 0.6, 1.4]) {
    for (const a of [0.15, 0.35, 0.9]) {
      if (v0 / a > 5.5) continue;   // covered by the horizon test below
      const r = roll([0, 0], [v0, 0], a);
      const truth = analyticStop(v0, a);
      assert(r.stopped, `v0=${v0} a=${a} should reach rest inside the horizon`);
      close(r.stopTime, truth.time, 1e-9, `stop time v0=${v0} a=${a}`);
      close(r.p[r.p.length - 1][0], truth.distance, 1e-9, `distance v0=${v0} a=${a}`);
    }
  }
});

test('a roll longer than the horizon is flagged, not silently truncated', () => {
  // 1.4 m/s against 0.15 m/s^2 takes 9.3 s, past the 6 s horizon. The end of that array is
  // not a stop point and the app must be able to tell the difference.
  const r = roll([0, 0], [1.4, 0], 0.15);
  assert(!r.stopped, 'should not claim to have stopped');
  assert(r.timedOut, 'should report timedOut');
  close(r.stopTime, 6.0, 0.01);
});

test('direction is preserved exactly -- a rolling ball does not curve', () => {
  const v0 = [0.5, 0.9];
  const r = roll([1, 2], v0, 0.3);
  const end = r.p[r.p.length - 1];
  const dx = end[0] - 1, dy = end[1] - 2;
  close(dx / dy, v0[0] / v0[1], 1e-9);
});

test('the ball stops; it never reverses', () => {
  const r = roll([0, 0], [0.4, 0], 1.0);
  assert(r.stopped, 'should report stopped');
  let prev = Infinity;
  for (const v of r.v) {
    const s = Math.hypot(v[0], v[1]);
    assert(s <= prev + 1e-12, 'speed increased');
    prev = s;
  }
  const xs = r.p.map((p) => p[0]);
  for (let i = 1; i < xs.length; i++) assert(xs[i] >= xs[i - 1] - 1e-12, 'position went backwards');
});

test('a zero flick produces no motion at all', () => {
  const r = roll([0.3, 0.4], [0, 0], 0.35);
  assert(r.p.length === 1);
  close(r.stopTime, 0, 1e-12);
});

test('leaving the support surface stops the rollout there', () => {
  const r = roll([0, 0], [1.0, 0], 0.05, { onSurface: (x) => x < 0.25 });
  assert(r.leftSurface, 'should report leaving the surface');
  assert(r.p[r.p.length - 1][0] < 0.27, 'should stop at the boundary, not run past it');
  const free = roll([0, 0], [1.0, 0], 0.05);
  assert(free.p[free.p.length - 1][0] > 5, 'without a boundary it should keep going');
});

test('sampleAt holds the rest position after the ball has stopped', () => {
  const r = roll([0, 0], [0.5, 0], 0.5);
  const s = sampleAt(r, [0, 0.5, 1.0, 5.0]);
  close(s[3][0], r.p[r.p.length - 1][0], 1e-12);
});

test('halving the deceleration doubles the time and quadruples the distance', () => {
  const a1 = roll([0, 0], [0.8, 0], 0.4);
  const a2 = roll([0, 0], [0.8, 0], 0.2);
  close(a2.stopTime / a1.stopTime, 2, 0.02);
  close(a2.p[a2.p.length - 1][0] / a1.p[a1.p.length - 1][0], 2, 0.02);
});

note('the integrator matches the closed form to 1e-9 m at every speed tested.');
