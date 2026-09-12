/**
 * WhatIf Cam v0.0 -- wiring.
 *
 * The order of operations is the architecture's, not a UI convenience:
 *
 *   frame -> depth (ONCE) -> RANSAC plane -> object -> launch -> 64 rollouts -> overlay
 *
 * Nothing neural runs per frame. The per-frame loop is a template tracker, a camera-motion
 * fingerprint, and canvas drawing.
 */
import * as Geo from './geometry.js';
import * as PF from './planefit.js';
import * as Dep from './depth.js';
import * as Seg from './segment.js';
import * as Obj from './object.js';
import * as Unc from './uncertainty.js';
import * as Conf from './confidence.js';
import * as R from './render.js';
import * as Src from './sources.js';
import { MotionWatch } from './motion.js';
import { Tracker } from './tracker.js';
import { gray } from './imageops.js';
import * as Anim from './anim.js';
import * as C from './constants.js';

const $ = (id) => document.getElementById(id);
const cv = $('view');
const ctx = cv.getContext('2d');

// The eleven M0 photos. They are gitignored, so on a fresh clone none of these exist and
// the app falls back to the synthetic table -- which needs no files and no model download.
const DEMO_PHOTOS = ['IMG_5359', 'IMG_5360', 'IMG_5361', 'IMG_5362', 'IMG_5357', 'IMG_5358',
  'IMG_5364', 'IMG_5365', 'IMG_5366', 'IMG_5367', 'IMG_5368'];
const PHOTO_BASE = new URL('../../photos/', import.meta.url).href;

const S = {
  source: 'photo',
  sourceObj: null,
  frame: null,
  frameName: '',
  fov: { deg: C.DEFAULT_HFOV_DEG, source: 'assumed', sigma: C.HFOV_SIGMA_ASSUMED_DEG },
  depthModel: 'int8',
  disp: null,
  lum: null,
  fit: null,
  planeSigma: C.PLANE_SIGMA_INT8_DEG,
  planeLayer: null,
  supportMask: null,
  ballMode: 'tap',
  ball: null,
  launch: null,
  pred: null,
  issues: [],
  stage: 'need-setup',
  drag: null,
  motion: new MotionWatch(),
  motionState: null,
  measure: null,
  trials: [],
  observed: null,
  running: false,
  enc: null,
  clock: null,
};

// The playhead. Redrawing on every tick of it is the only thing it does.
S.clock = new Anim.Clock(() => { paintTransport(); draw(); ensureLoop(); });

// ---------------------------------------------------------------- small helpers
function log(msg) {
  const el = $('log');
  el.textContent += (el.textContent ? '\n' : '') + msg;
  el.scrollTop = el.scrollHeight;
}
let hintBase = '';
function hint(t) { if (t != null) hintBase = t; paintHint(); }
function paintHint() {
  const n = S.issues.filter((i) => i.level === 'warn').length;
  $('hint').textContent = hintBase + (n ? ` \u00b7 ${n} caution${n > 1 ? 's' : ''} in the panel` : '');
}
function banner(kind, title, detail) {
  const b = $('banner');
  if (!kind) { b.hidden = true; return; }
  b.hidden = false; b.className = kind;
  b.innerHTML = `<b></b><span></span>`;
  b.querySelector('b').textContent = title;
  b.querySelector('span').textContent = detail || '';
}
function progress(frac, text) {
  const p = $('progress');
  if (frac == null) { p.hidden = true; return; }
  p.hidden = false;
  p.querySelector('i').style.width = `${Math.round(100 * frac)}%`;
  p.querySelector('span').textContent = text || '';
}

// ---------------------------------------------------------------- the numbers panel
function num(dt, dd, cls) {
  return `<dt>${dt}</dt><dd${cls ? ` class="${cls}"` : ''}>${dd}</dd>`;
}
function updateNumbers() {
  const rows = [];
  const fovCls = S.fov.source === 'exif' ? 'ok' : 'flag';
  rows.push(num('field of view',
    `<span class="${fovCls}">${S.fov.deg.toFixed(1)}&deg; ${S.fov.source}</span> &plusmn;${S.fov.sigma}&deg;`));
  rows.push(num('depth model',
    `${S.depthModel} ${Dep.DEPTH_MODELS[S.depthModel].mb} MB`));
  if (S.fit && S.fit.ok) {
    const f = S.fit;
    rows.push(num('camera elevation', `${f.elevationDeg.toFixed(1)}&deg;`,
      (f.elevationDeg < C.ELEV_TESTED_MIN_DEG - C.ELEV_TESTED_GRACE_DEG
        || f.elevationDeg > C.ELEV_TESTED_MAX_DEG + C.ELEV_TESTED_GRACE_DEG) ? 'flag' : 'ok'));
    rows.push(num('&nbsp;&nbsp;tested range', `${C.ELEV_TESTED_MIN_DEG}-${C.ELEV_TESTED_MAX_DEG}&deg;, n=11`));
    rows.push(num('plane normal',
      `[${f.plane.n.map((x) => x.toFixed(3)).join(', ')}]`));
    rows.push(num('surface flatness', `${f.flatnessPct.toFixed(3)} %`,
      f.flatnessPct > C.FLATNESS_WARN_PCT ? 'flag' : 'ok'));
    rows.push(num('near/far bend', f.nearfarDeg == null ? 'n/a' : `${f.nearfarDeg.toFixed(2)}&deg;`,
      (f.nearfarDeg ?? 0) > C.NEARFAR_WARN_DEG ? 'flag' : 'ok'));
    rows.push(num('surface coverage', `${(100 * f.inlierFraction).toFixed(0)} % of frame`,
      f.inlierFraction < C.INLIER_FRACTION_REFUSE ? 'bad' : 'ok'));
    rows.push(num('&nbsp;&nbsp;appearance gate',
      f.separated
        ? `on, dropped ${Math.max(0, Math.round(100 * (f.rawInlierFraction - f.inlierFraction)))} % of frame`
        : 'OFF - surface is geometry only',
      f.separated ? 'ok' : 'flag'));
    rows.push(num('plane error used', `&plusmn;${S.planeSigma.toFixed(1)}&deg; 1&sigma;`));
  } else {
    rows.push(num('plane', 'not fitted yet', 'flag'));
  }
  if (S.ball) {
    rows.push(num('ball', S.ball.virtual ? 'virtual' : `mask ${S.ball.maskPx} px`));
    rows.push(num('contact point',
      `${S.ball.contactPixel[0].toFixed(0)}, ${S.ball.contactPixel[1].toFixed(0)} px`));
    rows.push(num('scale source', S.ball.virtual ? 'camera height (weak)' : 'ball diameter'));
  }
  if (S.pred && S.pred.ok) {
    const p = S.pred;
    rows.push(num('initial speed', `${p.nominalSpeed.toFixed(2)} m/s`));
    if (p.hasStop) {
      rows.push(num('stop distance',
        `${(100 * p.stopDistanceM.p50).toFixed(0)} cm <span class="flag">[${(100 * p.stopDistanceM.p5).toFixed(0)}-${(100 * p.stopDistanceM.p95).toFixed(0)}]</span>`));
      rows.push(num('stop time',
        `${p.stopTimeS.p50.toFixed(2)} s <span class="flag">[${p.stopTimeS.p5.toFixed(2)}-${p.stopTimeS.p95.toFixed(2)}]</span>`));
      rows.push(num('stop region',
        `${(2 * p.stopEllipse.rx).toFixed(0)} &times; ${(2 * p.stopEllipse.ry).toFixed(0)} px, 90 %`));
    } else {
      rows.push(num('where it stops', 'unknown - leaves the measured surface', 'bad'));
      rows.push(num('path drawn to', `the edge of the fitted region, ${(100 * p.stopDistanceM.p50).toFixed(0)} cm`));
    }
    rows.push(num('1 relative unit', `${p.scaleM.toFixed(3)} m`));
  }
  if (S.motionState) {
    rows.push(num('camera drift', `${S.motionState.shiftPx.toFixed(1)} px, res ${S.motionState.residual.toFixed(3)}`,
      S.motionState.moved ? 'bad' : 'ok'));
  }
  $('numbers').innerHTML = rows.join('');
}

function showIssues(issues) {
  S.issues = issues;
  const card = $('issuesCard');
  if (!issues.length) { card.hidden = true; banner(null); paintHint(); return; }
  card.hidden = false;
  $('issues').innerHTML = issues.map((i) =>
    `<div class="${i.level}"><b>${i.level === 'refuse' ? 'REFUSED' : 'CAUTION'} &mdash; ${i.title}</b><p>${i.detail}</p></div>`
  ).join('');
  // A refusal takes over the frame, because nothing is being drawn and the user needs to
  // know why. A caution does NOT: with friction merely guessed, "the band is as wide as
  // the prediction is long" is true almost always, and a banner that is always up stops
  // being read. Cautions live in the panel, and the hint line says how many there are.
  const r = issues.find((i) => i.level === 'refuse');
  if (r) banner('refuse', `Refusing to draw: ${r.title}`, r.detail);
  else banner(null);
  paintHint();
}

// ---------------------------------------------------------------- sources
async function useSource(kind) {
  stopLoop();
  S.sourceObj?.stop?.();
  S.source = kind;
  for (const [id, k] of [['srcDemo', 'photo'], ['srcSynth', 'synthetic'], ['srcCamera', 'camera']]) {
    $(id).classList.toggle('on', k === kind);
  }
  resetScene();
  // The auto-demo leaves the app in virtual-ball mode, which is right for a photo of a
  // bare table and wrong for anything with a real ball in it.
  setBallMode(kind === 'photo' ? 'virtual' : 'tap');
  if (kind === 'photo') {
    const stem = $('photoPick').value || DEMO_PHOTOS[0];
    await loadPhoto(`${PHOTO_BASE}${stem}.JPG`);
  } else if (kind === 'synthetic') {
    // The scene's true field of view is set to the app's own default assumption, so that
    // synthetic mode isolates the depth model and the tracker instead of compounding a
    // known focal-length error. Drag the FOV slider and watch the plane move: that is the
    // sensitivity m0/README.md section 6 measured, demonstrated live.
    S.sourceObj = new Src.SyntheticSource({ pitchDeg: 37, hfovDeg: C.DEFAULT_HFOV_DEG });
    S.fov = { deg: C.DEFAULT_HFOV_DEG, source: 'assumed', sigma: C.HFOV_SIGMA_ASSUMED_DEG };
    $('srcNote').innerHTML =
      'probe/scene.py&rsquo;s tabletop, rendered live at a true elevation of <b>37&deg;</b> and a true '
      + `field of view of <b>${C.DEFAULT_HFOV_DEG}&deg;</b> (the app&rsquo;s own default, so nothing here is `
      + 'rigged either way). Its <b>rolling friction is hidden from the app</b>, so &ldquo;Measure a real '
      + 'roll&rdquo; is a genuine test. The plain surface is deliberate &mdash; it is the M0 hard case.';
    startLoop();
    hint('synthetic table - press "Set up scene"');
    updateNumbers();
  } else {
    try {
      const st = await S.sourceObj_start();
      $('srcNote').innerHTML = `camera ${st.width}&times;${st.height} @${Math.round(st.frameRate || 0)} fps. `
        + '<b>No EXIF exists for a camera stream</b>, so the field of view below is assumed. '
        + 'Keep the camera still after setup: moving it invalidates the plane, and the app watches for that.';
      startLoop();
      hint('camera live - hold still, then press "Set up scene"');
    } catch (e) {
      banner('refuse', 'No camera', e.message);
      log('camera: ' + e.message);
    }
  }
}
async function sourceObj_start() {
  S.sourceObj = new Src.CameraSource();
  return S.sourceObj.start();
}
S.sourceObj_start = sourceObj_start;

async function loadPhoto(url) {
  try {
    const f = await Src.fromImageUrl(url);
    S.sourceObj = null;
    S.frame = f; S.frameName = f.name;
    if (f.fov) {
      S.fov = { deg: f.fov.hfovDeg, source: 'exif', sigma: C.HFOV_SIGMA_EXIF_DEG };
      $('srcNote').innerHTML = `${f.name} &mdash; ${f.fullSize[0]}&times;${f.fullSize[1]}, working at `
        + `${f.w}&times;${f.h}. EXIF <code>FocalLengthIn35mmFilm</code> = ${f.fov.f35} mm, so the field of view is `
        + `<b>measured at ${f.fov.hfovDeg.toFixed(1)}&deg;</b>, not assumed. `
        + '(That tag lives in the Exif sub-IFD, not IFD0 &mdash; the bug M0 found.)';
    } else {
      S.fov = { deg: C.DEFAULT_HFOV_DEG, source: 'assumed', sigma: C.HFOV_SIGMA_ASSUMED_DEG };
      $('srcNote').innerHTML = `${f.name} &mdash; no EXIF focal length in this file, so the field of `
        + 'view below is a <b>guess</b>. Set it if you know it.';
    }
    syncFovUI();
    cv.width = f.w; cv.height = f.h;
    draw();
    hint('photo loaded - press "Set up scene"');
    updateNumbers();
  } catch (e) {
    log('photo: ' + e.message);
    banner('info', 'No demo photos in this clone',
      'photos/ is gitignored, so a fresh clone has none. Falling back to the synthetic table, '
      + 'which needs no files at all.');
    await useSource('synthetic');
  }
}

// ---------------------------------------------------------------- setup
function resetScene() {
  S.disp = null; S.lum = null; S.fit = null; S.planeLayer = null; S.supportMask = null;
  S.ball = null; S.launch = null; S.pred = null; S.enc = null;
  S.observed = null; S.measure = null; S.motionState = null;
  S.stage = 'need-setup';
  S.clock.pause();
  showTransport(false);
  showIssues([]);
  banner(null);
  updateNumbers();
  draw();
}

async function setupScene() {
  if (!S.frame) { log('no frame'); return; }
  $('btnSetup').disabled = true;
  banner('info', 'Setting up', 'One depth pass, then one plane fit. This is the only time a neural network runs.');
  try {
    progress(0, `loading depth model (${Dep.DEPTH_MODELS[S.depthModel].mb} MB, from disk)`);
    const t0 = performance.now();
    const sess = await Dep.loadDepth(S.depthModel, (f) => progress(f * 0.5, 'depth weights'));
    progress(0.5, `running depth on ${sess.ep.toUpperCase()}`);
    const d = await Dep.runDepth(sess, S.frame.rgba, S.frame.w, S.frame.h);
    S.disp = d.disp;
    log(`depth: ${sess.ep}, ${d.ms.toFixed(0)} ms, ${(sess.bytes / 1e6).toFixed(1)} MB`);

    progress(0.8, 'fitting the support plane');
    const K = Geo.intrinsics(S.fov.deg, S.frame.w, S.frame.h);
    // The luminance image goes in with the depth map. Geometry alone cannot tell the
    // tabletop from a carpet that happens to be coplanar with it -- see planefit.js.
    S.lum = gray(S.frame.rgba, S.frame.w, S.frame.h);
    const fit = PF.fitSupportPlane(S.disp, S.frame.w, S.frame.h, K, { step: 3, lum: S.lum });
    S.fit = fit;
    const issues = Conf.checkPlane(fit);
    S.planeSigma = Conf.planeSigmaFor(fit, Dep.DEPTH_MODELS[S.depthModel].planeSigmaDeg);

    if (fit.ok) {
      S.planeLayer = R.makePlaneLayer(fit, S.frame.w, S.frame.h);
      S.supportMask = PF.supportMaskFrom(fit, S.frame.w, S.frame.h);
      log(`plane: elev ${fit.elevationDeg.toFixed(1)} deg, flat ${fit.flatnessPct.toFixed(3)} %, `
        + `bend ${(fit.nearfarDeg ?? -1).toFixed(2)} deg, ${(100 * fit.inlierFraction).toFixed(0)} % of frame`
        + (fit.separated ? ` (${(100 * fit.rawInlierFraction).toFixed(0)} % before the appearance gate)` : ' [NOT separated]')
        + `, ${(performance.now() - t0).toFixed(0)} ms total`);
      S.motion.setReference(S.frame.rgba, S.frame.w, S.frame.h);
    }
    progress(null);
    showIssues(issues);
    updateNumbers();
    if (Conf.worst(issues) === 'refuse') {
      S.stage = 'need-setup';
      hint('refused - see the panel');
    } else {
      S.stage = 'need-ball';
      if (Conf.worst(issues) === 'ok') banner(null);
      hint(S.ballMode === 'tap' ? 'tap the ball' : 'tap where to drop a virtual ball');
      if (S.ballMode === 'tap') await ensureSegmenter();
    }
    draw();
  } catch (e) {
    progress(null);
    banner('refuse', 'Setup failed', e.message);
    log('setup: ' + e.message);
    console.error(e);
  } finally {
    $('btnSetup').disabled = false;
  }
}

async function ensureSegmenter() {
  if (S.enc) return;
  progress(0, 'loading SlimSAM (13 MB, from disk)');
  await Seg.loadSegmenter((f) => progress(f, 'slimsam weights'));
  progress(0.9, 'encoding the frame (once)');
  S.enc = await Seg.encode(S.frame.rgba, S.frame.w, S.frame.h);
  log(`slimsam encode: ${S.enc.ms.toFixed(0)} ms (once per scene)`);
  progress(null);
}

// ---------------------------------------------------------------- ball
async function placeBall(u, v) {
  if (!S.fit?.ok) return;
  const K = Geo.intrinsics(S.fov.deg, S.frame.w, S.frame.h);
  let ball;
  if (S.ballMode === 'virtual') {
    const X = Geo.rayPlane(K, S.fit.plane, u, v);
    if (!X) {
      showIssues([...Conf.checkPlane(S.fit), {
        level: 'refuse', code: 'off-plane-tap', title: 'That point is not on the table',
        detail: 'The ray through that pixel does not meet the fitted plane in front of the camera.',
      }]);
      return;
    }
    const rM = (Number($('ballDia').value) / 1000) / 2;
    const scaleM = (Number($('camH').value) / 100) / Math.abs(S.fit.plane.d);
    const rRel = rM / scaleM;
    ball = {
      virtual: true, contactPixel: [u, v], contactCam: X,
      radiusPx: (rRel * K.fx) / X[2], radiusRel: rRel, radiusM: rM, maskPx: 0,
    };
  } else {
    await ensureSegmenter();
    const raw = await Seg.decode(S.enc, [[u, v]], [1]);
    const mask = Seg.componentAt(raw.mask, S.frame.w, S.frame.h, u, v);
    const a = Obj.analyseMask(mask, S.frame.w, S.frame.h, K, S.fit.plane, S.disp,
      S.fit.flatnessPct > 0 ? (S.fit.flatnessPct / 100) * S.fit.extent : 1e-6, S.fit.extent);
    const tapIssues = Conf.checkTap(a);
    if (Conf.worst(tapIssues) === 'refuse') {
      showIssues([...Conf.checkPlane(S.fit), ...tapIssues]);
      updateNumbers(); draw();
      return;
    }
    ball = {
      ...a, virtual: false, mask,
      maskOutline: R.maskOutline(mask, S.frame.w, S.frame.h),
      radiusM: (Number($('ballDia').value) / 1000) / 2,
      extraIssues: tapIssues,
    };
    log(`tap: mask ${a.maskPx} px, r=${a.radiusPx.toFixed(1)} px, `
      + `local noise ${a.localNoise?.toFixed(2)}x, base offset ${a.contactOffPlane?.toFixed(2)} radii`);
  }
  S.ball = ball;
  S.pred = null; S.launch = null; S.observed = null;
  S.stage = 'ready';
  showIssues([...Conf.checkPlane(S.fit), ...(ball.extraIssues || [])]);
  hint('drag from the ball to flick it');
  updateNumbers();
  draw();
}

// ---------------------------------------------------------------- prediction
function buildScene() {
  return {
    W: S.frame.w, H: S.frame.h,
    hfovDeg: S.fov.deg, hfovSigmaDeg: S.fov.sigma,
    plane: S.fit.plane,
    planeSigmaDeg: S.planeSigma,
    ballPixel: S.ball.contactPixel,
    ballRadiusPx: S.ball.radiusPx,
    ballRadiusM: S.ball.radiusM,
    camHeightM: Number($('camH').value) / 100,
    scaleMode: S.ball.virtual ? 'height' : 'ball',
    frictionA: Number($('friction').value),
    supportMask: S.supportMask,
  };
}

function updatePrediction(opts = {}) {
  if (!S.ball || !S.launch || !S.fit?.ok) { S.pred = null; showTransport(false); return; }
  const pred = Unc.predict(buildScene(), S.launch);
  if (!pred.ok) log('prediction: ' + pred.reason);
  S.pred = pred;
  const issues = [
    ...Conf.checkPlane(S.fit),
    ...(S.ball.extraIssues || []),
    ...Conf.checkPrediction(pred, buildScene()),
    ...Conf.checkMotion(S.motionState),
  ];
  showIssues(issues);
  if (Conf.worst(issues) === 'refuse') S.pred = null;

  if (S.pred && S.pred.ok) {
    const duration = S.pred.times[S.pred.times.length - 1];
    if (opts.animate) {
      S.clock.reset(duration, true);
      ensureLoop();
    } else {
      // Mid-drag: show the whole prediction at rest rather than restarting the playback on
      // every pointer move.
      S.clock.setDuration(duration);
      S.clock.t = duration;
      S.clock.playing = false;
    }
    showTransport(true);
  } else {
    showTransport(false);
  }
  paintTransport();
  updateNumbers();
}

// ---------------------------------------------------------------- transport
function showTransport(on) {
  $('transport').hidden = !on;
  $('motionNote').hidden = !(on && S.clock.reducedMotion);
}
function paintTransport() {
  const d = S.clock.duration, t = S.clock.t;
  $('btnPlay').innerHTML = S.clock.playing ? '&#10073;&#10073;&nbsp;pause' : '&#9654;&nbsp;play';
  $('scrub').value = d > 0 ? Math.round((1000 * t) / d) : 0;
  const off = S.pred && S.pred.ok && t > (S.pred.nominalLeftAt ?? Infinity);
  $('timeRead').textContent = `${t.toFixed(2)} / ${d.toFixed(2)} s` + (off ? '  off-surface' : '');
}

// ---------------------------------------------------------------- drawing
function draw() {
  if (!S.frame) return;
  if (cv.width !== S.frame.w || cv.height !== S.frame.h) {
    cv.width = S.frame.w; cv.height = S.frame.h;
  }
  R.drawFrame(ctx, S.frame);
  R.drawPlaneLayer(ctx, S.planeLayer, $('showPlane').checked);
  if (S.measure?.track?.length) R.drawTrack(ctx, S.measure.track);
  R.drawBall(ctx, S.ball);
  if (S.drag) R.drawDrag(ctx, S.ball?.contactPixel, S.drag);
  if (S.pred) {
    R.drawPrediction(ctx, S.pred, { showSamples: $('showSamples').checked });
    if (!$('transport').hidden) R.drawPlayhead(ctx, S.pred, S.clock.t, Anim);
  }
  if (S.observed) R.drawObserved(ctx, S.observed.px, S.observed.inside);
}

// ---------------------------------------------------------------- live loop
let rafId = null;
function startLoop() { ensureLoop(); }
function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }

/** One rAF loop, shared by the live sources and the playhead. It stops when neither needs it. */
function ensureLoop() {
  const needed = !!S.sourceObj?.grab || S.clock.playing;
  if (needed && !rafId) rafId = requestAnimationFrame(tick);
  if (!needed && rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function tick(ts) {
  rafId = null;
  const tSec = ts / 1000;
  const advanced = S.clock.advance(ts);
  const f = S.sourceObj?.grab?.(tSec);
  if (!f) {
    if (advanced) { paintTransport(); draw(); }
    ensureLoop();
    return;
  }
  S.frame = f;

  if (S.fit?.ok) {
    const m = S.motion.update(f.rgba, f.w, f.h, tSec);
    if (m) {
      const was = S.motionState?.moved;
      S.motionState = m;
      if (m.moved && !was) {
        S.pred = null; S.observed = null; S.measure = null;
        showIssues([...Conf.checkPlane(S.fit), ...Conf.checkMotion(m)]);
        hint('camera moved - set up the scene again');
        updateNumbers();
      }
    }
  }

  if (S.measure) stepMeasure(f, tSec);
  if (advanced) paintTransport();
  draw();
  ensureLoop();
}

// ---------------------------------------------------------------- Measure mode
/**
 * The only way the 7-of-10 bar can be measured.
 *
 * A drag sets a velocity the user invented. A real roll has a velocity only the camera can
 * know, so for a trial the app watches the first 0.30 s of the actual roll (the observation
 * window probe/analyze2.py used), fits a straight line to the ball's position ON THE PLANE,
 * freezes the prediction at that instant, and then keeps tracking until the ball stops so
 * that "did it land in the band" is a measurement rather than a judgement call.
 */
function startMeasure() {
  if (!S.ball || !S.fit?.ok) { log('measure: set up a scene and place a ball first'); return; }
  if (S.source === 'photo') {
    banner('info', 'Measure mode needs live frames',
      'A photograph has no roll in it. Use the camera, or the synthetic table.');
    return;
  }
  if (S.source === 'synthetic') {
    // Put the ball back where it was tapped before each trial, so ten trials in a row are
    // ten trials rather than one trial and nine balls already off the table.
    S.sourceObj.reset();
    const f = S.sourceObj.grab(performance.now() / 1000);
    if (f) S.frame = f;
  }
  const g = gray(S.frame.rgba, S.frame.w, S.frame.h);
  const centre = ballCentrePixel();
  if (!centre) { log('measure: the ball is not on the fitted plane'); return; }
  S.measure = {
    phase: 'arming', t0: null, track: [], samples: [], tracker: new Tracker(
      g, S.frame.w, S.frame.h, centre[0], centre[1], S.ball.radiusPx),
    rest: null, restSince: null, startPx: centre.slice(),
  };
  S.observed = null; S.pred = null;
  $('trialsCard').hidden = false;
  hint('armed - roll the ball now');
  banner('info', 'Armed', 'Roll the ball. The first 0.30 s of the real motion sets the prediction; '
    + 'everything after that is the test.');
  if (S.source === 'synthetic') {
    // The synthetic table can roll its own ball, with a velocity and a friction the app is
    // not told. That is the self-test.
    const sp = 0.26 + Math.random() * 0.26;
    const ang = -1.9 + (Math.random() - 0.5) * 1.0;
    setTimeout(() => S.sourceObj?.launch?.([sp * Math.cos(ang), -sp * Math.sin(ang)]), 450);
  }
}

function stepMeasure(f, tSec) {
  const M = S.measure;
  const g = gray(f.rgba, f.w, f.h);
  const p = M.tracker.update(g);
  if (!p) {
    if (M.phase !== 'arming') {
      banner('warn', 'Lost the ball', 'The tracker could not follow it. Trial discarded.');
      S.measure = null;
    }
    return;
  }
  M.track.push({ t: tSec, u: p.u, v: p.v });
  if (M.track.length > 600) M.track.shift();

  const K = Geo.intrinsics(S.fov.deg, f.w, f.h);
  const frame = Geo.planeFrame(S.fit.plane);

  if (M.phase === 'arming') {
    const d = Math.hypot(p.u - M.startPx[0], p.v - M.startPx[1]);
    if (d > 3.5) { M.phase = 'observing'; M.t0 = tSec; M.samples = []; hint('observing the roll'); }
    return;
  }

  if (M.phase === 'observing') {
    M.samples.push({ t: tSec - M.t0, u: p.u, v: p.v });
    if (tSec - M.t0 >= C.OBS_WINDOW_S && M.samples.length >= 5) {
      // The samples are silhouette CENTRES; uncertainty.js intersects the plane offset by
      // one radius to turn each into a contact point, so nothing is fudged here.
      S.launch = { mode: 'track', samples: M.samples.map((s) => ({ ...s })), pixelSigma: 1.0 };
      updatePrediction({ animate: true });
      M.phase = 'settling';
      M.predAt = tSec;
      hint('predicted - waiting for the ball to stop');
      banner(null);
      log(`measure: ${M.samples.length} frames over ${C.OBS_WINDOW_S}s -> v0 = `
        + `${S.pred ? S.pred.nominalSpeed.toFixed(3) : '?'} m/s`);
    }
    return;
  }

  if (M.phase === 'settling') {
    const n = M.track.length;
    const prev = M.track[Math.max(0, n - 4)];
    const speedPx = Math.hypot(p.u - prev.u, p.v - prev.v) / Math.max(1, n - 1 - Math.max(0, n - 4));
    if (speedPx < C.REST_SPEED_PX) {
      if (M.restSince == null) M.restSince = tSec;
      if (tSec - M.restSince >= C.REST_HOLD_S) finishTrial(p, K, frame);
    } else {
      M.restSince = null;
    }
    if (tSec - M.predAt > 12) { banner('warn', 'Trial timed out', 'The ball never came to rest.'); S.measure = null; }
  }
}

function finishTrial(p, K, frame) {
  const M = S.measure;
  const pred = S.pred;
  // Where the ball really stopped, as a contact point on the plane -- same construction
  // as the prediction used, so the comparison is like for like.
  const restCentre = [p.u, p.v];
  const restPx = contactPixelFromCentre(restCentre, K, frame);
  if (!restPx) { banner('warn', 'Trial discarded', 'the resting ball is not on the fitted plane'); S.measure = null; return; }
  const inside = pred && pred.ok ? Unc.insideEllipse(pred.stopEllipse, restPx[0], restPx[1]) : false;
  S.observed = { px: restPx, inside };

  // How far did it actually go, and what deceleration does that imply? Not fed back into
  // the model -- fitting friction is v0.2 -- but it is the number that tells the owner what
  // to set the slider to, and whether the guess was anywhere near.
  let travelM = null, impliedA = null;
  if (pred && pred.ok) {
    const scene = buildScene();
    const start = pred.nominalPlane[0];
    const sM = pred.scaleM;
    const q = Geo.pixelToPlane(K, S.fit.plane, frame, restPx[0], restPx[1]);
    if (q) {
      const endM = [q[0] * sM, q[1] * sM];
      travelM = Math.hypot(endM[0] - start[0], endM[1] - start[1]);
      if (travelM > 1e-4) impliedA = (pred.nominalSpeed ** 2) / (2 * travelM);
    }
    void scene;
  }

  const trial = {
    n: S.trials.length + 1,
    v0: pred?.nominalSpeed ?? null,
    predictedM: pred?.stopDistanceM?.p50 ?? null,
    actualM: travelM,
    bandCm: pred ? 100 * (pred.stopDistanceM.p95 - pred.stopDistanceM.p5) : null,
    impliedA,
    inside,
    frictionAssumed: Number($('friction').value),
    fovDeg: S.fov.deg, fovSource: S.fov.source,
    planeSigmaDeg: S.planeSigma,
    elevationDeg: S.fit.elevationDeg,
    source: S.source,
    time: new Date().toISOString(),
  };
  if (S.source === 'synthetic') {
    trial.truthFrictionA = S.sourceObj.truth.a;
  }
  S.trials.push(trial);
  renderTrials();
  S.measure = null;
  hint(inside ? 'inside the band' : 'outside the band');
  banner(inside ? 'info' : 'warn',
    inside ? `Trial ${trial.n}: inside the band` : `Trial ${trial.n}: OUTSIDE the band`,
    `predicted ${(100 * (trial.predictedM ?? 0)).toFixed(0)} cm, actual ${(100 * (trial.actualM ?? 0)).toFixed(0)} cm, `
    + `band width ${(trial.bandCm ?? 0).toFixed(0)} cm`
    + (trial.impliedA ? `. Your surface's actual deceleration was ${trial.impliedA.toFixed(2)} m/s2 ` +
      `against the ${trial.frictionAssumed.toFixed(2)} assumed.` : ''));
}

/** Contact point -> silhouette centre pixel: one ball radius up the plane normal. */
function ballCentrePixel() {
  const K = Geo.intrinsics(S.fov.deg, S.frame.w, S.frame.h);
  const X = S.ball.contactCam;
  const rRel = S.ball.radiusRel;
  if (!X || !(rRel > 0)) return null;
  const C = Geo.add(X, Geo.scale3(S.fit.plane.n, rRel));
  return C[2] > 1e-6 ? Geo.project(K, C) : null;
}

/** Silhouette centre pixel -> contact pixel, via the plane offset by one ball radius. */
function contactPixelFromCentre(px, K, frame) {
  const plane = S.fit.plane;
  const rRel = S.ball.radiusRel ?? ((S.ball.radiusPx * (S.ball.contactCam?.[2] ?? 1)) / K.fx);
  const r = Geo.ray(K, px[0], px[1]);
  const den = Geo.dot(r, plane.n);
  if (Math.abs(den) < 1e-9) return null;
  const t = (plane.d + rRel) / den;
  if (!(t > 0)) return null;
  const X = Geo.sub(Geo.scale3(r, t), Geo.scale3(plane.n, rRel));
  if (!(X[2] > 1e-6)) return null;
  return Geo.project(K, X);
}

function renderTrials() {
  const tb = $('trials').querySelector('tbody');
  tb.innerHTML = S.trials.map((t) => `<tr>
    <td>${t.n}</td>
    <td>${t.v0 != null ? t.v0.toFixed(2) : '-'}</td>
    <td>${t.predictedM != null ? (100 * t.predictedM).toFixed(0) : '-'}</td>
    <td>${t.actualM != null ? (100 * t.actualM).toFixed(0) : '-'}</td>
    <td>${t.bandCm != null ? t.bandCm.toFixed(0) : '-'}</td>
    <td>${t.impliedA != null ? t.impliedA.toFixed(2) : '-'}</td>
    <td class="v ${t.inside ? 'in' : 'out'}">${t.inside ? 'in' : 'out'}</td></tr>`).join('');
  const hits = S.trials.filter((t) => t.inside).length;
  const n = S.trials.length;
  const widths = S.trials.map((t) => t.bandCm).filter((x) => x != null).sort((a, b) => a - b);
  const medW = widths.length ? widths[widths.length >> 1] : null;
  $('trialSummary').innerHTML = n === 0 ? 'no trials yet'
    : `<span class="${hits >= Math.ceil(0.7 * n) ? 'pass' : 'fail'}">${hits} / ${n}</span> inside the band`
      + (n >= 10 ? (hits >= 7 ? ' &mdash; bar met' : ' &mdash; bar NOT met') : ` &mdash; ${Math.max(0, 10 - n)} to go`)
      + (medW != null ? `<div class="note">median band width ${medW.toFixed(0)} cm. A pass with a band `
        + 'wider than the roll is not a pass worth having; that number is in the export.</div>' : '');
}

// ---------------------------------------------------------------- pointer
function toCanvas(ev) {
  const r = cv.getBoundingClientRect();
  return [((ev.clientX - r.left) / r.width) * cv.width, ((ev.clientY - r.top) / r.height) * cv.height];
}
cv.addEventListener('pointerdown', async (ev) => {
  const [u, v] = toCanvas(ev);
  if (S.stage === 'need-setup') { hint('press "Set up scene" first'); return; }
  if (S.stage === 'need-ball' || ev.shiftKey) { await placeBall(u, v); return; }
  try { cv.setPointerCapture(ev.pointerId); } catch { /* not all pointers can be captured */ }
  S.drag = [u, v];
  draw();
});
cv.addEventListener('pointermove', (ev) => {
  if (!S.drag) return;
  S.drag = toCanvas(ev);
  S.launch = { mode: 'flick', releasePixel: S.drag.slice(), pixelSigma: 2 };
  updatePrediction();
  draw();
});
cv.addEventListener('pointerup', () => {
  if (!S.drag) return;
  S.drag = null;
  // The flick is committed: now play it.
  updatePrediction({ animate: true });
  draw();
});

// ---------------------------------------------------------------- UI wiring
function syncFovUI() {
  $('fovSlider').value = S.fov.deg;
  $('fovVal').innerHTML = `${S.fov.deg.toFixed(1)}&deg; <small>${S.fov.source}</small>`;
}
$('fovSlider').addEventListener('input', (e) => {
  S.fov = { deg: Number(e.target.value), source: 'stated', sigma: C.HFOV_SIGMA_STATED_DEG };
  syncFovUI(); refit();
});
document.querySelectorAll('[data-fov]').forEach((b) => b.addEventListener('click', () => {
  S.fov = { deg: Number(b.dataset.fov), source: 'stated', sigma: C.HFOV_SIGMA_STATED_DEG };
  syncFovUI(); refit();
}));
function refit() {
  // The plane depends on the assumed focal length, so changing it re-fits rather than
  // silently leaving a plane that was computed under a different camera.
  if (S.disp && S.frame) {
    const K = Geo.intrinsics(S.fov.deg, S.frame.w, S.frame.h);
    S.fit = PF.fitSupportPlane(S.disp, S.frame.w, S.frame.h, K, { step: 3, lum: S.lum });
    if (S.fit.ok) {
      S.planeLayer = R.makePlaneLayer(S.fit, S.frame.w, S.frame.h);
      S.supportMask = PF.supportMaskFrom(S.fit, S.frame.w, S.frame.h);
      S.planeSigma = Conf.planeSigmaFor(S.fit, Dep.DEPTH_MODELS[S.depthModel].planeSigmaDeg);
    }
    updatePrediction();
  }
  updateNumbers(); draw();
}
for (const [id, fmt, cb] of [
  ['ballDia', (v) => `${v} mm`, () => { if (S.ball) { S.ball.radiusM = Number($('ballDia').value) / 2000; updatePrediction(); draw(); } }],
  ['camH', (v) => `${v} cm`, () => { updatePrediction(); draw(); }],
  ['friction', (v) => `${Number(v).toFixed(2)} m/s<sup>2</sup>`, () => { updatePrediction(); draw(); }],
]) {
  const el = $(id), out = $(id + 'Val');
  const upd = () => { out.innerHTML = fmt(el.value); cb(); };
  el.addEventListener('input', upd);
  out.innerHTML = fmt(el.value);
}
$('btnPlay').addEventListener('click', () => { S.clock.toggle(); paintTransport(); ensureLoop(); });
$('btnReplay').addEventListener('click', () => { S.clock.replay(); paintTransport(); ensureLoop(); });
$('scrub').addEventListener('input', (e) => {
  S.clock.seek((Number(e.target.value) / 1000) * S.clock.duration);
  paintTransport();
});
$('showPlane').addEventListener('change', draw);
$('showSamples').addEventListener('change', draw);
$('btnSetup').addEventListener('click', setupScene);
$('btnReset').addEventListener('click', resetScene);
$('btnMeasure').addEventListener('click', startMeasure);
$('srcDemo').addEventListener('click', () => useSource('photo'));
$('srcSynth').addEventListener('click', () => useSource('synthetic'));
$('srcCamera').addEventListener('click', () => useSource('camera'));
$('photoPick').addEventListener('change', () => useSource('photo'));
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  stopLoop(); S.sourceObj?.stop?.(); S.sourceObj = null; S.source = 'photo';
  resetScene();
  const img = await Src.fromFile(f);
  S.frame = img; S.frameName = img.name;
  S.fov = img.fov
    ? { deg: img.fov.hfovDeg, source: 'exif', sigma: C.HFOV_SIGMA_EXIF_DEG }
    : { deg: C.DEFAULT_HFOV_DEG, source: 'assumed', sigma: C.HFOV_SIGMA_ASSUMED_DEG };
  $('srcNote').textContent = `${img.name} - ${img.w}x${img.h} working, FOV ${S.fov.source}`;
  syncFovUI(); cv.width = img.w; cv.height = img.h; draw(); updateNumbers();
  hint('press "Set up scene"');
});
function setBallMode(mode) {
    S.ballMode = mode;
    $('modeTap').classList.toggle('on', mode === 'tap');
    $('modeVirtual').classList.toggle('on', mode === 'virtual');
    $('camHCtl').hidden = mode !== 'virtual';
    $('ballNote').innerHTML = mode === 'tap'
      ? 'Tap the ball in the frame, then drag from it. SlimSAM segments it; the contact point is '
        + 'taken from the mask&rsquo;s <b>lower edge</b>, not its centroid &mdash; a centroid is biased by '
        + 'about one ball radius, and no amount of good depth fixes that.'
      : 'Tap anywhere on the fitted surface to drop a <b>virtual</b> 40&nbsp;mm ball there, then drag. '
        + 'Nothing is segmented, so the scale comes from the stated camera height instead of from a '
        + 'measured object &mdash; weaker, and the band shows it.';
    if (S.stage === 'ready' || S.stage === 'need-ball') { S.ball = null; S.pred = null; S.stage = 'need-ball'; }
    draw();
}
$('modeTap').addEventListener('click', () => setBallMode('tap'));
$('modeVirtual').addEventListener('click', () => setBallMode('virtual'));
$('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({
    milestone: 'v0.0 Ghost Ball -- ROADMAP.md: real ball inside the band on >= 7 of 10 trials',
    trials: S.trials,
    passed: S.trials.filter((t) => t.inside).length,
    n: S.trials.length,
    constants: { ...C },
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'whatif-trials.json';
  a.click();
});
$('btnClearTrials').addEventListener('click', () => { S.trials = []; renderTrials(); });

// ---------------------------------------------------------------- boot
// Everything the app knows, reachable from the console. The brief asks for the numbers
// that decide the answer to be visible to a curious person; the panel is the first
// answer and this is the second.
window.whatif = { state: S, Geo, PF, Unc, Conf, Obj, C };
(async function boot() {
  $('photoPick').innerHTML = DEMO_PHOTOS.map((p) => `<option value="${p}">${p}.JPG</option>`).join('');
  $('camHCtl').hidden = true;
  log('WhatIf Cam v0.0 - everything local, no backend, no build step.');
  await useSource('photo');

  // The first ten seconds, with nothing in the owner's hands: his own table, the plane the
  // depth model found in it, a virtual ball, and a flick -- run automatically.
  if (S.frame && S.source === 'photo') {
    S.ballMode = 'virtual';
    $('modeVirtual').classList.add('on'); $('modeTap').classList.remove('on');
    $('camHCtl').hidden = false;
    await setupScene();
    if (S.fit?.ok && Conf.worst(Conf.checkPlane(S.fit)) !== 'refuse') {
      // Drop the ball in the middle of the surface that was actually fitted.
      let su = 0, sv = 0;
      for (const [u, v] of S.fit.inlierPixels) { su += u; sv += v; }
      const n = S.fit.inlierPixels.length;
      await placeBall(su / n, sv / n);
      if (S.ball) {
        const K = Geo.intrinsics(S.fov.deg, S.frame.w, S.frame.h);
        const fr = Geo.planeFrame(S.fit.plane);
        const p0 = Geo.pixelToPlane(K, S.fit.plane, fr, S.ball.contactPixel[0], S.ball.contactPixel[1]);
        const scaleM = (Number($('camH').value) / 100) / Math.abs(S.fit.plane.d);
        // A gentle nudge of about 12 cm, aimed across the table rather than off the far
        // edge. Chosen so the first thing on screen is an ordinary prediction: hard enough
        // that the band is visible, soft enough that the ball stops on the surface that
        // was actually measured.
        const target = [p0[0] + 0.165 / scaleM, p0[1] + 0.05 / scaleM];
        const px = Geo.planeToPixel(K, fr, target);
        if (px) {
          S.launch = { mode: 'flick', releasePixel: px, pixelSigma: 2 };
          updatePrediction({ animate: true });
          draw();
          hint('simulated flick - drag on the image to try your own');
          log('demo: virtual ball + simulated flick on the owner\'s own table.');
        }
      }
    }
  }
})();
