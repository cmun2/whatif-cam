"""
Shared geometry for the M0 harness.

The plane-fit math here is lifted verbatim from `probe/real_probe.py` (the pool-hall
probe) so the numbers are directly comparable; `m0/selftest.py` re-runs it on that same
image and asserts it still reproduces the published figures.

Everything added on top of that is clearly marked NEW and exists because the near/far
metric alone turned out not to be sufficient -- see m0/README.md, "What the near/far
number can and cannot see".
"""
import json, math, os
import numpy as np
from PIL import Image, ImageOps

MEAN = np.array([.485, .456, .406], np.float32)
STD  = np.array([.229, .224, .225], np.float32)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "models")


# ---------------------------------------------------------------- image loading
def _open_any(path):
    """PIL, falling back to macOS `sips` for HEIC (what an iPhone shoots by default).
    sips carries EXIF across, so the focal length survives the conversion."""
    try:
        im = Image.open(path)
        im.load()
        return Image.open(path)
    except Exception:
        pass
    import shutil, subprocess, tempfile
    if not shutil.which("sips"):
        raise SystemExit(
            f"cannot read {path}. It is probably HEIC. Either set the phone to\n"
            f"  Settings > Camera > Formats > Most Compatible  (shoots JPEG), or convert:\n"
            f"  sips -s format jpeg in.heic --out out.jpg")
    tmp = os.path.join(tempfile.gettempdir(),
                       "m0_" + os.path.splitext(os.path.basename(path))[0] + ".jpg")
    subprocess.run(["sips", "-s", "format", "jpeg", path, "--out", tmp],
                   check=True, capture_output=True)
    return Image.open(tmp)


def load_image(path, max_side=640):
    """EXIF-rotate, downscale to max_side, and return (PIL image, scale, exif fov or None)."""
    im = _open_any(path)
    fov = fov_from_exif(im)
    im = ImageOps.exif_transpose(im).convert("RGB")
    full_w, full_h = im.size
    s = min(1.0, max_side / max(full_w, full_h))
    if s < 1.0:
        im = im.resize((max(1, round(full_w * s)), max(1, round(full_h * s))), Image.BICUBIC)
    return im, s, fov, (full_w, full_h)


def fov_from_exif(im):
    """Horizontal FOV in degrees from EXIF, or None. Phones almost always carry this."""
    try:
        ex = im.getexif()
    except Exception:
        return None
    if not ex:
        return None
    f35 = ex.get(41989)                      # FocalLengthIn35mmFilm
    try:
        if f35:
            f35 = float(f35)
            if f35 > 0:
                # 35 mm frame is 36 mm wide; the reported value is normalised to that.
                return math.degrees(2 * math.atan(36.0 / (2 * f35)))
    except Exception:
        pass
    return None


# ---------------------------------------------------------------- depth model
_SESS = {}
def depth_session(model="dav2s_fp32.onnx"):
    import onnxruntime as ort
    if model not in _SESS:
        p = os.path.join(MODELS, model)
        if not os.path.exists(p):
            raise SystemExit(f"missing model {p} -- run m0/run.sh --fetch")
        so = ort.SessionOptions(); so.log_severity_level = 3
        _SESS[model] = ort.InferenceSession(p, so, providers=["CPUExecutionProvider"])
    return _SESS[model]


def run_depth(img, size=518, keep_aspect=False, model="dav2s_fp32.onnx"):
    """Depth Anything V2 Small -> relative INVERSE depth (disparity), at the image's own size.

    Default is the square resize used by probe/real_probe.py. keep_aspect follows the
    model's own preprocessor_config (keep_aspect_ratio, ensure_multiple_of=14); measured
    on NYU it changes the answer by < 0.2 deg median, so it is off by default.
    """
    W, H = img.size
    if keep_aspect:
        sc = size / max(W, H)
        tw = max(14, int(round(W * sc / 14)) * 14)
        th = max(14, int(round(H * sc / 14)) * 14)
    else:
        tw = th = size
    s = depth_session(model)
    x = ((np.asarray(img.resize((tw, th), Image.BICUBIC), np.float32) / 255. - MEAN) / STD)
    d = np.squeeze(s.run(None, {"pixel_values": x.transpose(2, 0, 1)[None]})[0])
    return np.asarray(Image.fromarray(d.astype(np.float32)).resize((W, H), Image.BILINEAR), np.float64)


# ---------------------------------------------------------------- plane fitting
def fit(P):
    """Least-squares plane through 3D points -> (unit normal, offset n.c, RMS residual).

    Verbatim from probe/real_probe.py: 3x3 covariance eigen-decomposition, smallest
    eigenvector. (A full SVD over ~250k points would OOM.)
    """
    c = P.mean(0); Y = P - c
    w, V = np.linalg.eigh(Y.T @ Y)
    n = V[:, 0]
    n = n / np.linalg.norm(n)
    return n, float(n @ c), float(np.sqrt(((Y @ n) ** 2).mean()))


def angle_between(a, b):
    return float(np.degrees(np.arccos(np.clip(abs(np.dot(a, b)), -1, 1))))


def backproject(disp, mask, fov_deg, shift=0.0):
    """Inverse depth -> 3D points, exactly as probe/real_probe.py does (depth = 1/disp).

    `shift` is the assumed additive disparity offset. It is 0 by default because that is
    what the existing probe assumes; it is exposed because the plane orientation depends
    on it strongly and nothing in the image determines it (see plane_report).
    """
    H, W = disp.shape
    fx = fy = (W / 2) / math.tan(math.radians(fov_deg) / 2)
    cx, cy = W / 2, H / 2
    dep = 1.0 / np.maximum(disp + shift, 1e-3)
    v, u = np.nonzero(mask)
    rays = np.stack([(u - cx) / fx, (v - cy) / fy, np.ones_like(u, float)], -1)
    return rays * dep[v, u][:, None], u, v


def plane_stats(disp, fov_deg, mask, shift=0.0):
    """probe/real_probe.py's plane_stats, plus a left/right split.

    - rms_over_extent_pct : scatter of the surface about its own best-fit plane
    - half_tilt_disagreement_deg : angle between planes fitted to the near and far halves
    """
    X, u, v = backproject(disp, mask, fov_deg, shift)
    n, d, rms = fit(X)
    if n[1] > 0:
        n = -n                                  # point the normal "up" (camera y is down)
    extent = float(np.linalg.norm(X.max(0) - X.min(0)))
    med = np.median(v); near, far = v > med, v <= med      # image rows: lower = nearer
    n1, _, _ = fit(X[near]); n2, _, _ = fit(X[far])
    mu = np.median(u)
    n3, _, _ = fit(X[u > mu]); n4, _, _ = fit(X[u <= mu])
    return dict(normal=n,
                rms_over_extent_pct=100 * rms / extent,
                half_tilt_disagreement_deg=angle_between(n1, n2),
                lr_tilt_disagreement_deg=angle_between(n3, n4),
                n_points=int(len(X)))


# ---------------------------------------------------------------- NEW: block bootstrap
def nearfar_bootstrap(disp, fov_deg, mask, shift=0.0, trials=48, block=24, seed=0):
    """90% interval on the near/far number, resampling 24x24 px BLOCKS.

    Depth-map error is spatially smooth, so a per-pixel bootstrap would be far too
    optimistic. Blocks keep the correlation. Without this a single photo's near/far
    reading is easy to over-read: on small regions it is a high-variance statistic.
    """
    rng = np.random.default_rng(seed)
    X, u, v = backproject(disp, mask, fov_deg, shift)
    bid = (v // block).astype(np.int64) * 100000 + (u // block).astype(np.int64)
    blocks = np.unique(bid)
    if len(blocks) < 8:
        return None
    med = np.median(v)
    out = []
    for _ in range(trials):
        pick = rng.choice(blocks, len(blocks), replace=True)
        sel = np.concatenate([np.nonzero(bid == b)[0] for b in np.unique(pick)])
        vv = v[sel]
        a, b = vv > med, vv <= med
        if a.sum() < 50 or b.sum() < 50:
            continue
        n1, _, _ = fit(X[sel][a]); n2, _, _ = fit(X[sel][b])
        out.append(angle_between(n1, n2))
    if len(out) < 8:
        return None
    return [float(np.percentile(out, 5)), float(np.percentile(out, 95))]


# ---------------------------------------------------------------- NEW: 4-tap plane
def K_from_fov(fov_deg, W, H):
    f = (W / 2) / math.tan(math.radians(fov_deg) / 2)
    return np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.]])


def normal_from_quad(quad, K):
    """Plane normal from four tapped corners of a rectangle on that plane.

    Opposite edges of a rectangle are parallel in 3D, so each pair meets at a vanishing
    point; the line through the two vanishing points is the plane's horizon l, and
    n = K^T l. No assumption about the rectangle's aspect ratio or size is needed, and
    -- unlike the depth path -- nothing here depends on an unknown disparity shift.

    Returns (unit normal, conditioning) where conditioning is the distance from the
    principal point to the nearest vanishing point in units of image width. Small values
    mean the view is close to fronto-parallel and the estimate is ill-conditioned.
    """
    q = np.asarray(quad, float)
    if q.shape != (4, 2):
        return None, 0.0
    def line(a, b):
        return np.cross(np.r_[a, 1.], np.r_[b, 1.])
    v1 = np.cross(line(q[0], q[1]), line(q[3], q[2]))     # top edge x bottom edge
    v2 = np.cross(line(q[0], q[3]), line(q[1], q[2]))     # left edge x right edge
    l = np.cross(v1, v2)
    n = K.T @ l
    nn = np.linalg.norm(n)
    if not np.isfinite(nn) or nn < 1e-12:
        return None, 0.0
    n = n / nn
    if n[1] > 0:
        n = -n
    pp = np.array([K[0, 2], K[1, 2]])
    def vpd(v):
        if abs(v[2]) < 1e-12:
            return np.inf
        return float(np.linalg.norm(v[:2] / v[2] - pp) / (2 * K[0, 2]))
    return n, min(vpd(v1), vpd(v2))


def quad_tap_noise(quad, K, sigma_px=2.0, trials=400, seed=0):
    """How much a 4-tap plane moves when the taps are off by sigma_px. This is the
    fallback's own error bar -- the number the depth model has to beat."""
    rng = np.random.default_rng(seed)
    n0, _ = normal_from_quad(quad, K)
    if n0 is None:
        return None
    errs = []
    for _ in range(trials):
        n, _ = normal_from_quad(np.asarray(quad, float) + rng.normal(0, sigma_px, (4, 2)), K)
        if n is not None:
            errs.append(angle_between(n, n0))
    if not errs:
        return None
    return dict(median_deg=float(np.median(errs)), p90_deg=float(np.percentile(errs, 90)))


# ---------------------------------------------------------------- NEW: shift sensitivity
def shift_sensitivity(disp, fov_deg, mask, span=1.0):
    """How far the depth-derived plane normal swings when the (unknowable) additive
    disparity offset is varied by +/- span, expressed in units of the region's own
    disparity range. This is orientation error the near/far number cannot see."""
    X, u, v = backproject(disp, mask, fov_deg, 0.0)
    d = disp[mask]
    rng_disp = float(d.max() - d.min())
    if rng_disp <= 0:
        return None
    n0, _, _ = fit(X)
    out = []
    for k in (-span, span):
        s = k * rng_disp
        if (d.min() + s) <= 1e-3:
            continue
        Xs, _, _ = backproject(disp, mask, fov_deg, s)
        ns, _, _ = fit(Xs)
        out.append(angle_between(ns, n0))
    if not out:
        return None
    return dict(deg_per_disp_range=float(np.mean(out)), disp_range=rng_disp)


# ---------------------------------------------------------------- misc
def polygon_mask(poly, W, H, shrink=0.04):
    """Boolean mask of a polygon, shrunk toward its centroid to keep table edges out."""
    from PIL import ImageDraw
    p = np.asarray(poly, float)
    c = p.mean(0)
    p = c + (p - c) * (1.0 - shrink)
    im = Image.new("L", (W, H), 0)
    ImageDraw.Draw(im).polygon([tuple(x) for x in p], fill=255)
    return np.asarray(im) > 127


def largest_component(mask, erode=5):
    from scipy import ndimage
    m = ndimage.binary_opening(mask, np.ones((5, 5)))
    lab, k = ndimage.label(m)
    if k == 0:
        return mask
    sz = ndimage.sum(m, lab, range(1, k + 1))
    m = lab == (1 + int(np.argmax(sz)))
    if erode:
        m = ndimage.binary_erosion(m, np.ones((erode, erode)))
    return m


# ---------------------------------------------------------------- NEW: shift solved against a reference
def best_shift_to_reference(disp, mask, fov_deg, n_ref, n_samples=241):
    """Find the additive disparity offset that best aligns the depth-derived plane with a
    reference normal, and report the residual angle after it.

    This separates two very different failure modes that the raw number conflates:
      - residual small  -> the depth map's SHAPE is right and the whole error is one
                           unknown scalar. That has fixes other than abandoning depth.
      - residual large  -> the depth map is genuinely warped over this surface and no
                           single scalar rescues it.
    The reference is the 4-tap plane, so this is not a way to certify depth on its own --
    it is a diagnosis of *why* depth disagrees.
    """
    d = disp[mask]
    lo = -float(d.min()) + 1e-3
    span = float(d.max() - d.min())
    hi = lo + 6 * span + 1e-3
    ss = np.linspace(lo, hi, n_samples)
    best = None
    for s in ss:
        X, _, _ = backproject(disp, mask, fov_deg, s)
        n, _, _ = fit(X)
        if n[1] > 0:
            n = -n
        a = angle_between(n, n_ref)
        if best is None or a < best[0]:
            best = (a, float(s))
    return dict(residual_deg=float(best[0]), shift=best[1], disp_range=span)
