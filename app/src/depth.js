/**
 * Depth Anything V2 Small, run once per scene.
 *
 * Output is affine-invariant relative INVERSE depth (disparity). The app takes
 * depth = 1/disp, i.e. it assumes the unknown additive offset is zero, exactly as
 * probe/real_probe.py and m0/planefit.py do. m0/README.md section 5 proves that
 * assumption is invisible to the near/far bend metric and section 6 measures that it is
 * very nearly right for a table filling the frame from 40-60 cm -- because a big
 * disparity range makes the unknown offset proportionally small. The UI repeats that
 * caveat where the numbers are shown, because a small or distant surface does not
 * inherit the result.
 *
 * Default weights are the int8 build (26 MB), which is what a browser can ship. That is
 * not free: re-measuring the eleven M0 photos with dav2s_q.onnx instead of dav2s_fp32.onnx
 * moves the plane-vs-4-tap median from 1.9 deg to 2.9 deg, and the two models' own planes
 * differ by a median 1.3 deg. The band uses the int8 figure.
 */
import { createSession } from './ort.js';
import { resizeRGBA, toTensorCHW, resizeFloat } from './imageops.js';

export const DEPTH_MODELS = {
  int8: { file: 'dav2s_q.onnx', mb: 26, planeSigmaDeg: 2.9,
          note: 'int8, 26 MB. Measured 2.9 deg median plane error on the eleven M0 photos.' },
  fp32: { file: 'dav2s_fp32.onnx', mb: 99, planeSigmaDeg: 1.9,
          note: 'fp32, 99 MB. The model the M0 gate was decided on: 1.9 deg median.' },
};

let cache = {};

export async function loadDepth(which = 'int8', onProgress) {
  if (!cache[which]) cache[which] = await createSession(DEPTH_MODELS[which].file, onProgress);
  return cache[which];
}

/**
 * @param {Uint8ClampedArray} rgba frame pixels
 * @returns {{disp:Float32Array, w:number, h:number, ms:number}} disparity at frame size
 */
export async function runDepth(sess, rgba, w, h, size = 518) {
  const t0 = performance.now();
  const small = resizeRGBA(rgba, w, h, size, size);
  const x = toTensorCHW(small, size, size);
  const ort = sess.ort;
  const feeds = { pixel_values: new ort.Tensor('float32', x, [1, 3, size, size]) };
  const out = await sess.session.run(feeds);
  const key = Object.keys(out)[0];
  const t = out[key];
  const oh = t.dims[t.dims.length - 2], ow = t.dims[t.dims.length - 1];
  const disp = resizeFloat(Float32Array.from(t.data), ow, oh, w, h);
  return { disp, w, h, ms: performance.now() - t0 };
}
