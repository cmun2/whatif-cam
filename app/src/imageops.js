/**
 * Image resampling, written out by hand rather than delegated to canvas drawImage.
 *
 * Reason: the same code has to run in Node for the tests, where there is no canvas, and
 * the depth model's answer depends on how the frame was resampled. A resize that differs
 * between the test and the browser would make the tests lie.
 *
 * Downscaling is area-averaged (what PIL does with BICUBIC + antialias, near enough);
 * upscaling is bilinear.
 */

/** RGBA -> RGBA resize. src/dst are Uint8ClampedArray-like of length w*h*4. */
export function resizeRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  if (xr >= 1 || yr >= 1) {
    // area average
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor(y * yr), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * yr));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor(x * xr), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * xr));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = y0; yy < y1 && yy < sh; yy++) {
          for (let xx = x0; xx < x1 && xx < sw; xx++) {
            const k = (yy * sw + xx) * 4;
            r += src[k]; g += src[k + 1]; b += src[k + 2]; a += src[k + 3]; n++;
          }
        }
        const k = (y * dw + x) * 4;
        out[k] = r / n; out[k + 1] = g / n; out[k + 2] = b / n; out[k + 3] = a / n;
      }
    }
    return out;
  }
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yr - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xr - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
      const k = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(y0 * sw + x0) * 4 + c], p01 = src[(y0 * sw + x1) * 4 + c];
        const p10 = src[(y1 * sw + x0) * 4 + c], p11 = src[(y1 * sw + x1) * 4 + c];
        out[k + c] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy;
      }
    }
  }
  return out;
}

/** RGBA -> normalised CHW float tensor, ImageNet mean/std (what both ONNX models want). */
export const IMAGENET_MEAN = [0.485, 0.456, 0.406];
export const IMAGENET_STD = [0.229, 0.224, 0.225];

export function toTensorCHW(rgba, w, h, mean = IMAGENET_MEAN, std = IMAGENET_STD) {
  const out = new Float32Array(3 * w * h);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    out[i] = (rgba[4 * i] / 255 - mean[0]) / std[0];
    out[n + i] = (rgba[4 * i + 1] / 255 - mean[1]) / std[1];
    out[2 * n + i] = (rgba[4 * i + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

/** Bilinear resample of a single-channel Float32 map. Used to bring depth back to frame size. */
export function resizeFloat(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yr - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xr - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
      const p00 = src[y0 * sw + x0], p01 = src[y0 * sw + x1];
      const p10 = src[y1 * sw + x0], p11 = src[y1 * sw + x1];
      out[y * dw + x] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy;
    }
  }
  return out;
}

/** RGBA -> luminance in 0..1, at a reduced size. The camera-motion fingerprint. */
export function grayThumb(rgba, w, h, tw, th) {
  const small = resizeRGBA(rgba, w, h, tw, th);
  const g = new Float32Array(tw * th);
  for (let i = 0; i < tw * th; i++) {
    g[i] = (0.299 * small[4 * i] + 0.587 * small[4 * i + 1] + 0.114 * small[4 * i + 2]) / 255;
  }
  return g;
}

/** RGBA -> full-size luminance in 0..1. Used by the tracker. */
export function gray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = (0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2]) / 255;
  }
  return g;
}
