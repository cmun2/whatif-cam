/**
 * Where frames come from. Three sources, all producing the same thing: RGBA pixels at a
 * working resolution of at most 640 on the long side.
 *
 *   camera     getUserMedia. No EXIF, therefore no field of view. This is the real product.
 *   photo      a JPEG, which DOES carry EXIF, so the focal length is a measurement here
 *              and an assumption on the camera. The M0 photos are the demo.
 *   synthetic  probe/scene.py's tabletop, re-rendered live, with a ball that can actually
 *              be made to roll. This is how the whole path is exercised -- including the
 *              tracker and the 7-of-10 bookkeeping -- with no camera and no ball.
 *
 * 640 is not arbitrary: it is the working resolution the M0 harness measured at, so the
 * numbers the app prints are comparable to the numbers in m0/README.md.
 */
import { focalFromJpeg } from './exif.js';
import * as Synth from './synth.js';
import { resizeRGBA } from './imageops.js';

export const WORK_MAX_SIDE = 640;

function drawToWorking(bitmapOrVideo, sw, sh) {
  const s = Math.min(1, WORK_MAX_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  const cv = document.createElement('canvas');
  cv.width = sw; cv.height = sh;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmapOrVideo, 0, 0, sw, sh);
  const full = g.getImageData(0, 0, sw, sh).data;
  // Our own area-average resize rather than the canvas's, so the browser and the Node
  // tests resample identically -- see imageops.js.
  const rgba = s < 1 ? resizeRGBA(full, sw, sh, w, h) : full;
  return { rgba, w, h };
}

export async function fromImageUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  let fov = null;
  try { fov = focalFromJpeg(buf); } catch { /* not a JPEG, or no EXIF */ }
  const bmp = await createImageBitmap(new Blob([buf]));
  const fullSize = [bmp.width, bmp.height];
  const out = drawToWorking(bmp, bmp.width, bmp.height);
  bmp.close?.();
  return { ...out, fov, fullSize, name: url.split('/').pop() };
}

export async function fromFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let fov = null;
  try { fov = focalFromJpeg(buf); } catch { /* ignore */ }
  const bmp = await createImageBitmap(file);
  const fullSize = [bmp.width, bmp.height];
  const out = drawToWorking(bmp, bmp.width, bmp.height);
  bmp.close?.();
  return { ...out, fov, fullSize, name: file.name };
}

export class CameraSource {
  constructor() { this.video = null; this.stream = null; }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'This browser will not give a page the camera. If you opened this from inside ' +
        'another app (Instagram, LINE, Slack), that webview blocks getUserMedia silently. ' +
        'Open it in Safari or Chrome.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    const v = document.createElement('video');
    v.srcObject = this.stream;
    v.playsInline = true; v.muted = true;
    await v.play();
    this.video = v;
    const t = this.stream.getVideoTracks()[0];
    this.settings = t.getSettings();
    return this.settings;
  }

  grab() {
    if (!this.video || this.video.readyState < 2) return null;
    return drawToWorking(this.video, this.video.videoWidth, this.video.videoHeight);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video = null; this.stream = null;
  }
}

/**
 * The synthetic tabletop as a live source. It knows the truth -- the plane, the ball's
 * position, the friction -- and the app is never told any of it. That is the point: it is
 * the only way to watch the app be right or wrong without a real ball.
 */
export class SyntheticSource {
  constructor(opts = {}) {
    this.scene = Synth.makeScene(opts);
    this.ballR = opts.ballRadiusM ?? 0.02;
    this.p = opts.start ?? [-0.12, 0.45];
    this.v = [0, 0];
    // A friction the app is NOT given. It samples a range; this is one draw from reality.
    this.truth = { a: opts.friction ?? 0.31 };
    this.lastT = null;
    this.rolling = false;
    this.history = [];
  }

  launch(v0) { this.v = v0.slice(); this.rolling = true; this.history = []; }
  reset(p) { this.p = (p || [-0.12, 0.45]).slice(); this.v = [0, 0]; this.rolling = false; }

  step(tSec) {
    if (this.lastT == null) { this.lastT = tSec; return; }
    let dt = Math.min(0.05, tSec - this.lastT);
    this.lastT = tSec;
    if (!this.rolling) return;
    const sub = 1 / 480;
    while (dt > 0) {
      const h = Math.min(sub, dt); dt -= h;
      const s = Math.hypot(this.v[0], this.v[1]);
      if (s < 1e-4) { this.v = [0, 0]; this.rolling = false; break; }
      const dv = this.truth.a * h;
      if (dv >= s) { this.v = [0, 0]; this.rolling = false; break; }
      this.v[0] -= (this.v[0] / s) * dv;
      this.v[1] -= (this.v[1] / s) * dv;
      this.p[0] += this.v[0] * h;
      this.p[1] += this.v[1] * h;
    }
  }

  grab(tSec) {
    this.step(tSec);
    const out = Synth.renderFrame(this.scene, this.p, this.ballR);
    return { rgba: out.rgba, w: out.w, h: out.h, truth: { p: this.p.slice(), rolling: this.rolling } };
  }
}
