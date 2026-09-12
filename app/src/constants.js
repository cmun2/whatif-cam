/**
 * Every magic number in the app, with the measurement it came from.
 *
 * Rule: if a number here has no provenance line, it is a guess and must say so, because
 * the UI shows these to the user and the uncertainty band is built out of them.
 */

// ---------------------------------------------------------------- camera / FOV
//
// A browser gets NO EXIF for a live getUserMedia stream. MediaStreamTrack.getSettings()
// reports width/height/frameRate and not one thing about the lens. So the field of view
// is ASSUMED, and the app says so on screen.
//
// 68 deg is the horizontal FOV of a 26 mm-equivalent lens (an iPhone's 1x rear camera:
// 2*atan(36/(2*26)) = 69.4 deg) and sits in the middle of the 60-78 deg band that laptop
// webcams occupy. The M0 harness's own no-EXIF fallback was 65 deg; this is the same
// choice made for a camera rather than for a photo.
export const DEFAULT_HFOV_DEG = 68.0;

// How far wrong that assumption plausibly is, as a 1-sigma. Covers 52-84 deg at 2 sigma,
// which spans every webcam and phone 1x lens the app is likely to meet. It does NOT cover
// an ultra-wide (104 deg) -- the user has to say so, and the UI offers the preset.
export const HFOV_SIGMA_ASSUMED_DEG = 8.0;
// If the user picks a preset or moves the slider they are still guessing, just better.
export const HFOV_SIGMA_STATED_DEG = 4.0;
// If it came out of EXIF (photo mode) it is a measurement.
export const HFOV_SIGMA_EXIF_DEG = 1.0;

// m0/README.md section 6: "The absolute orientation moves ~2 deg per 4 deg of FOV error."
export const PLANE_TILT_PER_FOV_DEG = 0.5;

// ---------------------------------------------------------------- plane error
//
// m0-out/m0.json, 11 photos of the owner's plain white table, fp32 depth model:
//   median angle between the depth plane and the 4-tap plane = 1.9 deg (range 0.9-5.2).
//
// The browser ships the int8 model (26 MB vs 99 MB). Re-measuring the same 11 photos with
// dav2s_q.onnx gives a median of 2.9 deg (range 1.2-5.8); the int8 and fp32 planes
// themselves disagree by a median 1.3 deg. Quantisation is not free and the band says so.
export const PLANE_SIGMA_INT8_DEG = 2.9;
export const PLANE_SIGMA_FP32_DEG = 1.9;

// ---------------------------------------------------------------- tested envelope
//
// m0/README.md section 6, caveat 1: camera elevation across all eleven photos was
// 34.8-40.2 deg. ONE CONDITION MEASURED ELEVEN TIMES. Everything outside it is
// extrapolation, and the app treats it as such rather than pretending otherwise.
export const ELEV_TESTED_MIN_DEG = 34.8;
export const ELEV_TESTED_MAX_DEG = 40.2;
// Slack before the "untested angle" warning fires. The elevation the app recovers from
// depth differs by a degree or two from the elevation M0 quoted from the tapped quad, and
// without this grace every one of the eleven photos the gate PASSED on would warn.
export const ELEV_TESTED_GRACE_DEG = 2.0;
// Outside this wider band the geometry itself degrades (near-fronto-parallel at the low
// end, no perspective to fit at the high end) and the app refuses.
export const ELEV_REFUSE_MIN_DEG = 15.0;
export const ELEV_REFUSE_MAX_DEG = 70.0;
// Penalty applied to the plane sigma per degree outside the tested band. Not measured --
// it is a deliberate choice to widen rather than to stay confident where nothing is known.
export const ELEV_SIGMA_PENALTY_PER_DEG = 0.12;

// ---------------------------------------------------------------- plane fit quality
// Scatter about the fitted plane, as a percentage of the fitted region's own extent.
//
// Now that the appearance gate trims the surface to the tabletop, this is close to the
// same statistic m0.json reports over a hand-delimited region (0.159-0.284 %): measured
// through the app's own code path on the same eleven photos, 0.27-0.36 %. Before the gate
// it read 0.03-0.07 %, because the extent it normalised by included the carpet.
//
// Warn is set just under 2x the worst of those eleven, refuse at about 4x. These two
// thresholds are the numbers most likely to be wrong in someone else's kitchen: they are
// calibrated on eleven photos of ONE table and nothing else.
export const FLATNESS_WARN_PCT = 0.6;
export const FLATNESS_REFUSE_PCT = 1.5;

// The near/far bend metric (m0/planefit.py plane_stats). It cannot see a global disparity
// offset -- see m0/README.md section 5 -- but a LARGE reading still means the surface is
// genuinely warped, which no single scalar rescues. M0 read 3.1-4.4 deg on the owner's
// photos; the app reads 2.4-3.7 deg on the same images, which is the closest the two code
// paths have come to agreeing.
export const NEARFAR_WARN_DEG = 6.0;
export const NEARFAR_REFUSE_DEG = 12.0;

// Fraction of sampled pixels that must land on the winning plane for it to count as a
// table rather than a lucky patch. On the owner's eleven photos the app claims 0.23-0.29
// of the frame after the appearance gate -- the table does not fill an ultra-wide shot --
// so the floor is set well below that rather than at an intuitive-sounding "half the
// frame". It also does real work: a badly warped depth map leaves a fitted region small
// enough to trip it.
export const INLIER_FRACTION_REFUSE = 0.12;

// ---------------------------------------------------------------- physics
//
// GUESSED, NOT MEASURED, and the widest term in the band. probe/scene.py used 0.30-0.42
// m/s^2 for rolling deceleration on its synthetic table. Fitting this from observation is
// v0.2 on the roadmap; until then the app samples over the range instead of picking one.
export const FRICTION_DECEL_DEFAULT = 0.35;     // m/s^2
export const FRICTION_DECEL_SIGMA_REL = 0.40;   // lognormal, 1-sigma as a fraction
//
// 40 % is wide enough to swallow almost any error: measured in tests/uncertainty.test.js,
// a table with THREE TIMES the assumed friction still lands inside the 90 % stop region.
// A band that cannot be wrong is not a measurement, so the app lets this be narrowed once
// the owner has actually measured his own table's deceleration (Measure mode prints it).
// At 10 % the same 3x error falls outside, and the 7-of-10 bar becomes a real test.
export const FRICTION_SIGMA_MEASURED = 0.10;

// ---------------------------------------------------------------- scale
// Relative depth has no metres in it (RESEARCH.md 3.4: a 2x scale error costs 219 mm at
// 2 s, so scale does not matter for the SHAPE of the path -- but friction is in m/s^2, so
// it matters for where the ball stops). Scale comes from the ball's real diameter, which
// the user types. 40 mm is a regulation table-tennis ball.
export const BALL_DIAMETER_MM_DEFAULT = 40.0;
export const BALL_DIAMETER_SIGMA_REL = 0.05;    // includes the mask's own radius error

// When there is no real object to measure -- a VIRTUAL ball dropped onto a photo of a
// bare table, which is how the demo runs on the owner's own eleven photos -- there is
// nothing in the image of known size, so the scale has to come from somewhere else. It
// comes from the camera's height above the table, which the user states. 45 cm is what
// probe/scene.py assumed and roughly what "hold the phone over the table" means. It is a
// much weaker scale than a ball of known diameter, and it is sampled much more widely.
export const CAM_HEIGHT_M_DEFAULT = 0.45;
export const CAM_HEIGHT_SIGMA_REL = 0.25;

// ---------------------------------------------------------------- interaction
// A drag is not a throw: nothing about dragging a finger measures a speed. The app maps
// drag length to speed through one assumed time constant and prints the resulting m/s so
// the user can see the assumption rather than absorb it.
export const FLICK_TIME_CONSTANT_S = 0.35;
export const FLICK_MAX_SPEED = 3.0;             // m/s, clamp

// ---------------------------------------------------------------- tracking (Measure mode)
export const OBS_WINDOW_S = 0.30;   // probe/analyze2.py's observation window
export const TRACK_SEARCH_PX = 26;
export const TRACK_WORK_WIDTH = 320;
export const REST_SPEED_PX = 0.6;   // px/frame below which the ball counts as stopped
export const REST_HOLD_S = 0.40;

// ---------------------------------------------------------------- camera motion
// Fingerprint the setup frame and watch for a global shift. Thresholds are in pixels of a
// 64-wide thumbnail, i.e. deliberately coarse: we are looking for "the phone moved", not
// for a hand passing through the frame.
export const MOTION_GRID_W = 64;
export const MOTION_SHIFT_REFUSE_PX = 1.25;
export const MOTION_RESIDUAL_REFUSE = 0.085;  // mean abs diff, 0-1, after best shift
export const MOTION_HOLD_S = 0.35;            // must persist this long before we react

// ---------------------------------------------------------------- simulation
export const SIM_DT = 1 / 240;
export const SIM_TMAX = 6.0;
export const MC_SAMPLES = 64;      // ARCHITECTURE.md says ~32; 64 costs nothing
export const BAND_Z90 = 1.6449;    // one-dimensional 90 %
export const ELLIPSE_CHI2_90 = 4.6052;  // two-dimensional 90 %
