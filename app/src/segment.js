/**
 * SlimSAM-77, tap-to-select. Preprocessing is a direct port of m0/region.py's sam_mask:
 * longest edge to 1024, zero-pad to 1024x1024, ImageNet normalisation, best of the three
 * decoder masks by predicted IoU.
 *
 * The encoder (841 ms natively, slower in WASM) runs once per scene. The decoder is
 * 19 ms, which is what makes tapping feel instant -- requirement R4 in ARCHITECTURE.md.
 */
import { createSession } from './ort.js';
import { resizeRGBA, toTensorCHW, resizeFloat } from './imageops.js';

let encSess = null, decSess = null;

export async function loadSegmenter(onProgress) {
  if (!encSess) encSess = await createSession('slimsam_enc_q.onnx', onProgress);
  if (!decSess) decSess = await createSession('slimsam_dec_q.onnx', onProgress);
  return { encSess, decSess };
}

/** Encode one frame. Returns the embeddings plus the letterbox geometry the tap needs. */
export async function encode(rgba, w, h) {
  const t0 = performance.now();
  const s = 1024 / Math.max(w, h);
  const rw = Math.round(w * s), rh = Math.round(h * s);
  const resized = resizeRGBA(rgba, w, h, rw, rh);
  const canvas = new Uint8ClampedArray(1024 * 1024 * 4);
  for (let y = 0; y < rh; y++) {
    canvas.set(resized.subarray(y * rw * 4, (y + 1) * rw * 4), y * 1024 * 4);
  }
  const x = toTensorCHW(canvas, 1024, 1024);
  const ort = encSess.ort;
  const out = await encSess.session.run({
    pixel_values: new ort.Tensor('float32', x, [1, 3, 1024, 1024]),
  });
  return {
    emb: out.image_embeddings, pos: out.image_positional_embeddings,
    s, rw, rh, w, h, ms: performance.now() - t0,
  };
}

/** Decode a mask for one positive point. Returns a Uint8Array mask at frame size. */
export async function decode(enc, points, labels) {
  const ort = decSess.ort;
  const pts = new Float32Array(points.length * 2);
  points.forEach((p, i) => { pts[2 * i] = p[0] * enc.s; pts[2 * i + 1] = p[1] * enc.s; });
  const lbl = BigInt64Array.from(labels.map((l) => BigInt(l)));
  const out = await decSess.session.run({
    input_points: new ort.Tensor('float32', pts, [1, 1, points.length, 2]),
    input_labels: new ort.Tensor('int64', lbl, [1, 1, labels.length]),
    image_embeddings: enc.emb,
    image_positional_embeddings: enc.pos,
  });
  const iou = out.iou_scores.data;
  let best = 0;
  for (let i = 1; i < iou.length; i++) if (iou[i] > iou[best]) best = i;
  const md = out.pred_masks.dims;
  const mh = md[md.length - 2], mw = md[md.length - 1];
  const plane = Float32Array.from(out.pred_masks.data.slice(best * mh * mw, (best + 1) * mh * mw));
  // 256x256 over the PADDED 1024 frame -> crop to the letterbox -> frame size.
  const up = resizeFloat(plane, mw, mh, 1024, 1024);
  const crop = new Float32Array(enc.rw * enc.rh);
  for (let y = 0; y < enc.rh; y++) {
    for (let x2 = 0; x2 < enc.rw; x2++) crop[y * enc.rw + x2] = up[y * 1024 + x2];
  }
  const full = resizeFloat(crop, enc.rw, enc.rh, enc.w, enc.h);
  const mask = new Uint8Array(enc.w * enc.h);
  for (let i = 0; i < mask.length; i++) mask[i] = full[i] > 0 ? 1 : 0;
  return { mask, iou: iou[best] };
}

/** Keep the connected component containing the tapped pixel; drop everything else. */
export function componentAt(mask, w, h, u, v) {
  const idx = Math.round(v) * w + Math.round(u);
  const out = new Uint8Array(w * h);
  if (!mask[idx]) {
    // The tap may be a pixel or two outside; search a small neighbourhood.
    let found = -1;
    for (let r = 1; r <= 6 && found < 0; r++) {
      for (let dy = -r; dy <= r && found < 0; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = Math.round(u) + dx, y = Math.round(v) + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (mask[y * w + x]) { found = y * w + x; break; }
        }
      }
    }
    if (found < 0) return out;
    return flood(mask, out, w, h, found);
  }
  return flood(mask, out, w, h, idx);
}

function flood(mask, out, w, h, seed) {
  const stack = [seed];
  out[seed] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (mask[j] && !out[j]) { out[j] = 1; stack.push(j); }
    }
  }
  return out;
}
