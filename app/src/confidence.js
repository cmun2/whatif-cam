/**
 * When to refuse.
 *
 * ROADMAP.md and ARCHITECTURE.md both say a prediction must never be presented as the
 * real future. The strongest form of that is not a label -- it is drawing nothing.
 * Every condition under which this app declines to draw a path lives in this one file so
 * that it can be read in one sitting and tested without a camera.
 *
 * Each check returns {level, code, title, detail}. level is 'refuse' or 'warn'.
 * 'refuse' means no ghost path is drawn at all.
 */
import * as C from './constants.js';

const R = (code, title, detail) => ({ level: 'refuse', code, title, detail });
const W = (code, title, detail) => ({ level: 'warn', code, title, detail });

/**
 * Checks on the scene the moment the plane is fitted.
 * @param {object} fit output of planefit.fitSupportPlane
 */
export function checkPlane(fit) {
  const out = [];
  if (!fit || !fit.ok) {
    out.push(R('no-plane', 'No flat surface found',
      'Nothing in this frame back-projected to a plane at an angle a table could be at: '
      + ((fit && fit.reason) || 'the depth map did not contain one')
      + '. Point the camera at a table so that it fills most of the view, from somewhere '
      + 'above it rather than level with it.'));
    return out;
  }

  if (fit.inlierFraction < C.INLIER_FRACTION_REFUSE) {
    out.push(R('small-surface', 'The surface found is too small to trust',
      `Only ${(100 * fit.inlierFraction).toFixed(0)} % of the frame lies on the fitted plane ` +
      `(needs ${(100 * C.INLIER_FRACTION_REFUSE).toFixed(0)} %). Fill more of the view with the table.`));
  }

  if (fit.flatnessPct > C.FLATNESS_REFUSE_PCT) {
    out.push(R('not-flat', 'This surface is not flat enough to be a plane',
      `Scatter about the best-fit plane is ${fit.flatnessPct.toFixed(3)} % of the region's size. ` +
      `The eleven M0 photos run 0.27-0.36 % through this same code; past ${C.FLATNESS_REFUSE_PCT} % a plane is the wrong model of what is there.`));
  } else if (fit.flatnessPct > C.FLATNESS_WARN_PCT) {
    out.push(W('flatness', 'The depth map is noisy over this surface',
      `Flatness ${fit.flatnessPct.toFixed(3)} % against 0.27-0.36 % on the M0 photos. The band is widened to match.`));
  }

  if (fit.nearfarDeg != null) {
    if (fit.nearfarDeg > C.NEARFAR_REFUSE_DEG) {
      out.push(R('bent', 'The recovered surface is bent, not flat',
        `The near half and the far half of the surface disagree by ${fit.nearfarDeg.toFixed(1)} deg. ` +
        `That is the depth map being warped, and no plane fit fixes it.`));
    } else if (fit.nearfarDeg > C.NEARFAR_WARN_DEG) {
      out.push(W('bend', 'The surface bends between its near and far halves',
        `${fit.nearfarDeg.toFixed(1)} deg of bend, against 2.4-3.7 deg on the M0 photos.`));
    }
  }

  if (fit.separated === false) {
    out.push(W('unseparated', 'The fitted surface may include more than the table',
      (fit.separationNote || 'the surface could not be separated from its surroundings by appearance')
      + ' Everything coplanar with your table -- a floor, a carpet, a partition behind it -- can '
      + 'land on the same plane, and geometry alone cannot tell them apart.'));
  }

  const e = fit.elevationDeg;
  if (e < C.ELEV_REFUSE_MIN_DEG) {
    out.push(R('too-shallow', 'The camera is almost level with the table',
      `Elevation ${e.toFixed(0)} deg. Below ${C.ELEV_REFUSE_MIN_DEG} deg the surface is too foreshortened ` +
      `for the prediction to mean anything on screen. Raise the camera.`));
  } else if (e > C.ELEV_REFUSE_MAX_DEG) {
    out.push(R('too-steep', 'The camera is almost straight down',
      `Elevation ${e.toFixed(0)} deg. Above ${C.ELEV_REFUSE_MAX_DEG} deg there is too little perspective ` +
      `left to recover the plane reliably. Lower the camera.`));
  } else if (e < C.ELEV_TESTED_MIN_DEG - C.ELEV_TESTED_GRACE_DEG
             || e > C.ELEV_TESTED_MAX_DEG + C.ELEV_TESTED_GRACE_DEG) {
    out.push(W('untested-angle', 'This camera angle has never been tested',
      `Elevation ${e.toFixed(0)} deg. Everything that has been measured about this app was shot ` +
      `between ${C.ELEV_TESTED_MIN_DEG} and ${C.ELEV_TESTED_MAX_DEG} deg -- one condition, eleven times. ` +
      `Outside it the error bar is a guess, so the band is widened.`));
  }
  return out;
}

/** Extra plane-tilt sigma, in degrees, earned by being outside the tested envelope. */
export function planeSigmaFor(fit, baseSigmaDeg) {
  let s = baseSigmaDeg;
  if (!fit || !fit.ok) return s;
  const e = fit.elevationDeg;
  let outside = 0;
  if (e < C.ELEV_TESTED_MIN_DEG) outside = C.ELEV_TESTED_MIN_DEG - e;
  else if (e > C.ELEV_TESTED_MAX_DEG) outside = e - C.ELEV_TESTED_MAX_DEG;
  s += outside * C.ELEV_SIGMA_PENALTY_PER_DEG;
  // Noise in the fit itself, above what the M0 photos showed, is real extra error.
  if (fit.flatnessPct > C.FLATNESS_WARN_PCT) {
    s += (fit.flatnessPct - C.FLATNESS_WARN_PCT) * 6.0;
  }
  if (fit.nearfarDeg != null && fit.nearfarDeg > C.NEARFAR_WARN_DEG) {
    s += (fit.nearfarDeg - C.NEARFAR_WARN_DEG) * 0.5;
  }
  return s;
}

/**
 * Checks on the tap: is the thing the user tapped actually an object sitting on the plane
 * we fitted, in a part of the depth map that is behaving?
 */
export function checkTap(tap) {
  const out = [];
  if (!tap || !tap.ok) {
    out.push(R('no-mask', 'Nothing segmented there',
      (tap && tap.reason) || 'The segmenter returned no usable mask for that tap.'));
    return out;
  }
  if (tap.areaFraction > 0.35) {
    out.push(R('mask-too-big', 'That selected most of the frame, not an object',
      `The mask covers ${(100 * tap.areaFraction).toFixed(0)} % of the view. Tap the ball, not the table.`));
  }
  if (tap.maskPx < 60) {
    out.push(R('mask-too-small', 'That object is too small to measure',
      `Only ${tap.maskPx} pixels. Move the camera closer or use a larger ball.`));
  }
  if (tap.touchesEdge) {
    out.push(R('mask-edge', 'The object runs off the edge of the frame',
      'Its contact point with the table cannot be located, so its position on the plane is unknown.'));
  }
  if (tap.contactOffPlane != null && tap.contactOffPlane > 3.0) {
    out.push(R('off-plane', 'That object is not resting on the surface that was fitted',
      `Its base sits ${tap.contactOffPlane.toFixed(1)} ball-radii off the fitted plane. ` +
      `Either it is not on the table, or the plane is wrong.`));
  }
  if (tap.localNoise != null && tap.localNoise > 2.5) {
    out.push(R('noisy-tap', 'The depth map is unreliable right where you tapped',
      `Scatter around the contact point is ${tap.localNoise.toFixed(1)}x the surface's own. ` +
      `Drawing a path from here would be guessing.`));
  } else if (tap.localNoise != null && tap.localNoise > 1.6) {
    out.push(W('noisy-tap-warn', 'The depth map is noisier than usual around the object',
      'Shadow, specular highlight, or a low-contrast edge. The band is widened.'));
  }
  return out;
}

/** Checks on the prediction after it is computed. */
export function checkPrediction(pred, scene) {
  const out = [];
  if (!pred || !pred.ok) {
    out.push(R('no-prediction', 'The prediction did not resolve',
      (pred && pred.reason) || 'unknown'));
    return out;
  }
  if (pred.timedOutFraction > 0.25) {
    out.push(W('still-rolling', 'The ball has not stopped by the end of the prediction',
      `${(100 * pred.timedOutFraction).toFixed(0)} % of the sampled futures are still moving at ` +
      `${C.SIM_TMAX} s. The end of the drawn path is the horizon, NOT a resting place -- ` +
      `do not read the stop region as where it comes to rest. Either the flick is too hard or ` +
      `the assumed friction is too low for this surface.`));
  }
  if (pred.leftSurfaceFraction > 0.5) {
    out.push(W('off-table', 'The ball rolls off the measured surface',
      `${(100 * pred.leftSurfaceFraction).toFixed(0)} % of the sampled futures leave the region the ` +
      `plane was fitted to. Past the edge of that region nothing has been measured, so the path stops there.`));
  }
  if (pred.stopEllipse) {
    const r = Math.max(pred.stopEllipse.rx, pred.stopEllipse.ry);
    const span = pred.stopDistanceM.p95 - pred.stopDistanceM.p5;
    if (span > 0.9 * pred.stopDistanceM.p50) {
      out.push(W('band-huge', 'The band is as wide as the prediction is long',
        `Stop distance is somewhere between ${(100 * pred.stopDistanceM.p5).toFixed(0)} and ` +
        `${(100 * pred.stopDistanceM.p95).toFixed(0)} cm. Friction is assumed, not measured ` +
        `(that is v0.2), and it dominates this. Treat the direction as the useful part and the distance as barely a claim.`));
    }
  }
  return out;
}

/** Camera motion: the failure ROADMAP.md risk 5 says must be detected, not disclaimed. */
export function checkMotion(m) {
  if (!m) return [];
  if (m.moved) {
    return [R('camera-moved', 'The camera has moved since the scene was set up',
      `Global shift ${m.shiftPx.toFixed(1)} px, residual ${m.residual.toFixed(3)}. ` +
      `The plane was measured from one frame; moving the camera invalidates it silently, ` +
      `so the prediction is withdrawn rather than left on screen drifting.`)];
  }
  return [];
}

export const worst = (issues) => (issues.some((i) => i.level === 'refuse') ? 'refuse'
  : issues.length ? 'warn' : 'ok');
