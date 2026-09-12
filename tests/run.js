#!/usr/bin/env node
/**
 * node tests/run.js
 *
 * Everything here runs headless, with no browser, no camera and no ONNX. What it can
 * check is the deterministic core: geometry, the plane fit, the rolling model, the growth
 * of the uncertainty band, the refusal rules, camera-motion detection, and the tracker --
 * the last two against a synthetic table with exact ground truth.
 *
 * What it CANNOT check is whether a real ball on a real table lands in the band. That is
 * the v0.0 milestone and it is measured with a ball, not with node.
 */
import { readdirSync } from 'node:fs';
import { report } from './harness.js';

const here = new URL('.', import.meta.url);
const files = readdirSync(here).filter((f) => f.endsWith('.test.js')).sort();
for (const f of files) {
  console.log(`\n${f}`);
  await import(new URL(f, here).href);
}
process.exit(report() ? 1 : 0);
