/** A test runner in 60 lines, because the app has no build step and should have no test one. */
let suite = '';
const results = [];
let failures = 0;

export function describe(name, fn) { suite = name; fn(); suite = ''; }

export function test(name, fn) {
  try {
    fn();
    results.push({ ok: true, name: `${suite ? suite + ' / ' : ''}${name}` });
  } catch (e) {
    failures++;
    results.push({ ok: false, name: `${suite ? suite + ' / ' : ''}${name}`, err: e });
  }
}

export function skip(name, why) {
  results.push({ skip: true, name: `${suite ? suite + ' / ' : ''}${name}`, err: { message: why } });
}

export function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

export function close(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) {
    throw new Error(`${msg || 'not close'}: ${a} vs ${b} (tolerance ${tol})`);
  }
}

export function report() {
  const pad = Math.max(...results.map((r) => r.name.length)) + 2;
  for (const r of results) {
    const tag = r.skip ? 'SKIP' : r.ok ? ' ok ' : 'FAIL';
    console.log(`  [${tag}] ${r.name.padEnd(pad)}${r.err ? r.err.message : ''}`);
    if (r.err && !r.ok && !r.skip && r.err.stack) {
      console.log(r.err.stack.split('\n').slice(1, 3).join('\n'));
    }
  }
  const pass = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skip).length;
  console.log(`\n  ${pass} passed, ${failures} failed, ${skipped} skipped`);
  return failures;
}

export function note(msg) { console.log(`         ${msg}`); }
