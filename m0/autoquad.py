#!/usr/bin/env python3
"""
Automatic tabletop-quad detection for M0, for the case where the owner is not present to
tap the corners.

WHY THIS EXISTS AND WHAT IT COSTS
---------------------------------
m0/region.py deliberately refuses to guess a region: a wrong region produces a confident
wrong number. This module does not repeal that principle. It writes an ordinary sidecar,
so the downstream run is identical to a hand-tapped one, and it writes a check image per
photo that must be looked at. Any photo whose four edges cannot be fitted with enough
support is EXCLUDED and named, not guessed at.

WHY A LINE FIT AND NOT A CORNER TAP
-----------------------------------
The subject tabletop has radiused corners (~40 mm). A human tapping "the corner" taps the
arc, not the ideal rectangle vertex that the vanishing-point math wants, and is biased
inward by the radius. Fitting a line to each of the four STRAIGHT edges and intersecting
consecutive lines recovers the ideal vertex to sub-pixel precision. It also still works
when a vertex falls outside the frame, provided both of its edges are partly visible --
which matters here, because on several of these ultra-wide frames the near corners are
clipped.

METHOD
------
1. Coarse mask: SlimSAM-77 (already bundled for m0/region.py) prompted with three points
   on the tabletop. Immune to the strong warm-to-neutral illumination gradient across
   this top, which defeats any global threshold.
2. Seed quad: maximum-area quadrilateral inscribed in the mask's convex hull.
3. Sub-pixel refinement at FULL resolution: along each seed edge, sample perpendicular
   intensity profiles and locate the bright(table) -> dark(background) transition to
   sub-pixel accuracy by a parabola fit on the gradient magnitude. Reject weak or
   ambiguous samples, then fit a line by robust total least squares.
4. Intersect consecutive lines for the four ideal corners.

BOW
---
Step 3 also yields, for free, the one measurement that decides whether this lens's barrel
distortion matters: the residual of a known-straight physical edge against a straight
line. `bow_px` is the sagitta of a parabola fitted to those residuals. Under a pinhole
camera it is zero; under uncorrected barrel distortion a 2000 px edge near the frame
margin bows by tens of pixels.
"""
import math
import numpy as np
from PIL import Image
from scipy import ndimage


# ---------------------------------------------------------------- coarse mask
def sam_tabletop(img, region_module):
    """SlimSAM mask of the tabletop, prompted at three points across the middle band."""
    W, H = img.size
    pts = [[0.50 * W, 0.58 * H], [0.32 * W, 0.55 * H], [0.68 * W, 0.55 * H]]
    m = region_module.sam_mask(img, pts, [1, 1, 1])
    m = ndimage.binary_opening(m, np.ones((7, 7)))
    lab, k = ndimage.label(m)
    if k == 0:
        return None
    sz = ndimage.sum(m, lab, range(1, k + 1))
    m = lab == (1 + int(np.argmax(sz)))
    return ndimage.binary_fill_holes(m)


# ---------------------------------------------------------------- seed quad
def _hull(pts):
    from scipy.spatial import ConvexHull
    return pts[ConvexHull(pts).vertices]


def _max_area_quad(hull):
    """Largest-area quadrilateral with vertices on the convex hull.

    For a fixed diagonal (i, j) the two remaining vertices are independent -- each is the
    hull point farthest from the line i-j on its own side -- so an exact O(n^2) scan over
    diagonals suffices.
    """
    n = len(hull)
    if n < 4:
        return None
    def tri(i, j, t):
        a, b, c = hull[i], hull[j], hull[t]
        return abs(np.cross(b - a, c - a)) / 2.0
    best, bestA = None, -1.0
    for i in range(n):
        for j in range(i + 2, n):
            arc1 = list(range(i + 1, j))
            arc2 = list(range(j + 1, n)) + list(range(0, i))
            if not arc1 or not arc2:
                continue
            b = max(arc1, key=lambda t: tri(i, j, t))
            d = max(arc2, key=lambda t: tri(i, j, t))
            A = tri(i, j, b) + tri(i, j, d)
            if A > bestA:
                bestA, best = A, [i, b, j, d]
    return None if best is None else hull[best]


def _order_quad(q):
    """-> TL, TR, BR, BL == far-left, far-right, near-right, near-left, as m0 wants."""
    q = np.asarray(q, float)
    c = q.mean(0)
    q = q[np.argsort(np.arctan2(q[:, 1] - c[1], q[:, 0] - c[0]))]   # clockwise on screen
    return np.roll(q, -int(np.argmin(q[:, 0] + q[:, 1])), axis=0)


def seed_quad(mask):
    yy, xx = np.nonzero(mask & ~ndimage.binary_erosion(mask, np.ones((3, 3))))
    P = np.stack([xx, yy], 1).astype(float)
    if len(P) < 100:
        return None
    h = _hull(P)
    if len(h) > 80:
        h = h[:: int(np.ceil(len(h) / 80))]
    q = _max_area_quad(h)
    return None if q is None else _order_quad(q)


# ---------------------------------------------------------------- sub-pixel edges
def _bilinear(g, x, y):
    H, W = g.shape
    x = np.clip(x, 0, W - 1.001); y = np.clip(y, 0, H - 1.001)
    x0 = x.astype(int); y0 = y.astype(int)
    fx = x - x0; fy = y - y0
    return (g[y0, x0] * (1 - fx) * (1 - fy) + g[y0, x0 + 1] * fx * (1 - fy) +
            g[y0 + 1, x0] * (1 - fx) * fy + g[y0 + 1, x0 + 1] * fx * fy)


def _robust_line(pts, w=None, iters=6, k=2.5):
    """Total-least-squares line with MAD rejection -> ((a,b,c), inliers, rms)."""
    keep = np.ones(len(pts), bool)
    l = None
    for _ in range(iters):
        p = pts[keep]
        if len(p) < 12:
            return None, keep, np.inf
        c = p.mean(0)
        _, _, vt = np.linalg.svd(p - c)
        d = vt[0]
        n = np.array([-d[1], d[0]])
        l = np.array([n[0], n[1], -n @ c])
        r = pts @ l[:2] + l[2]
        s = 1.4826 * np.median(np.abs(r[keep] - np.median(r[keep]))) + 1e-6
        new = np.abs(r) < k * s
        if new.sum() < 12 or (new == keep).all():
            keep = new if new.sum() >= 12 else keep
            break
        keep = new
    r = pts[keep] @ l[:2] + l[2]
    return l, keep, float(np.sqrt((r ** 2).mean()))


def refine_edge(gray, a, b, inward, n_samples=160, corner_frac=0.14,
                search=None, min_grad=6.0):
    """Locate the bright->dark table silhouette along the seed edge a->b, sub-pixel.

    `inward` is a unit vector pointing into the tabletop; the wanted transition is bright
    on the inward side. Returns (line, points, stats) or (None, None, why).
    """
    a = np.asarray(a, float); b = np.asarray(b, float)
    L = float(np.linalg.norm(b - a))
    if L < 50:
        return None, None, {"reason": "seed edge too short"}
    d = (b - a) / L
    nrm = np.array([-d[1], d[0]])
    if nrm @ inward < 0:
        nrm = -nrm                                  # nrm now points INTO the table
    R = search if search is not None else float(np.clip(0.035 * L, 14, 90))
    t = np.linspace(corner_frac * L, (1 - corner_frac) * L, n_samples)
    base = a[None, :] + t[:, None] * d[None, :]
    off = np.arange(-R, R + 1, 0.5)                 # + is inward (bright side)
    P = base[:, None, :] + off[None, :, None] * nrm[None, None, :]
    prof = _bilinear(gray, P[..., 0], P[..., 1])    # (n_samples, n_off)
    prof = ndimage.gaussian_filter1d(prof, 1.5, axis=1)
    g = np.gradient(prof, off, axis=1)              # d(intensity)/d(inward offset)
    # transition we want: intensity RISES as we move inward -> positive gradient peak
    i = np.argmax(g, axis=1)
    peak = g[np.arange(len(i)), i]
    ok = (peak > min_grad) & (i > 1) & (i < len(off) - 2)
    # parabola vertex on the gradient magnitude
    y0 = g[np.arange(len(i)), np.clip(i - 1, 0, None)]
    y1 = peak
    y2 = g[np.arange(len(i)), np.clip(i + 1, None, len(off) - 1)]
    den = (y0 - 2 * y1 + y2)
    sub = np.where(np.abs(den) > 1e-9, 0.5 * (y0 - y2) / np.where(np.abs(den) > 1e-9, den, 1), 0.0)
    sub = np.clip(sub, -1, 1)
    toff = off[i] + sub * (off[1] - off[0])
    # reject ambiguous profiles: a second comparable rise elsewhere
    g2 = g.copy()
    for j in range(len(i)):
        g2[j, max(0, i[j] - 8):i[j] + 9] = -np.inf
    second = g2.max(1)
    ok &= second < 0.6 * peak
    if ok.sum() < 30:
        return None, None, {"reason": f"only {int(ok.sum())}/{n_samples} usable edge profiles"}
    pts = base[ok] + toff[ok][:, None] * nrm[None, :]
    line, keep, rms = _robust_line(pts)
    if line is None or keep.sum() < 25:
        return None, None, {"reason": "edge line fit lost support"}
    p = pts[keep]
    # bow: sagitta of a parabola in the along-edge coordinate, fitted to the residuals
    s = (p - p.mean(0)) @ d
    r = p @ line[:2] + line[2]
    A = np.c_[s ** 2, s, np.ones_like(s)]
    coef, *_ = np.linalg.lstsq(A, r, rcond=None)
    span = s.max() - s.min()
    bow = abs(coef[0]) * (span ** 2) / 8.0
    return line, p, {"n": int(keep.sum()), "n_tried": n_samples, "rms_px": rms,
                     "bow_px": float(bow), "span_px": float(span),
                     "quad_coef": float(coef[0])}


def _inter(l1, l2):
    p = np.cross(l1, l2)
    return None if abs(p[2]) < 1e-12 else p[:2] / p[2]


def fit_quad(gray, seed, border_margin=4, iters=3):
    """seed: 4x2 TL,TR,BR,BL at the SAME resolution as `gray`. -> (quad, info)."""
    H, W = gray.shape
    q = np.asarray(seed, float)
    info = {"edges": []}
    for it in range(iters):
        c = q.mean(0)
        lines, stats = [], []
        for i in range(4):
            a, b = q[i], q[(i + 1) % 4]
            mid = (a + b) / 2
            inward = c - mid
            nrm_i = np.linalg.norm(inward)
            if nrm_i < 1e-6:
                return None, {"reason": "degenerate seed"}
            l, p, st = refine_edge(gray, a, b, inward / nrm_i)
            if l is None:
                return None, {"reason": f"edge {i} ({'far right near left'.split()[i] if False else i}): {st['reason']}"}
            lines.append(l); stats.append(st)
        nq = []
        for i in range(4):
            pt = _inter(lines[(i - 1) % 4], lines[i])
            if pt is None or not np.all(np.isfinite(pt)) or np.max(np.abs(pt)) > 20 * max(W, H):
                return None, {"reason": f"corner {i} ill-conditioned (near-parallel edges)"}
            nq.append(pt)
        q = np.asarray(nq, float)
        info["edges"] = stats
    info["corners_outside_frame"] = [bool(x < 0 or x >= W or y < 0 or y >= H) for x, y in q]
    info["max_bow_px"] = max(s["bow_px"] for s in info["edges"])
    info["max_rms_px"] = max(s["rms_px"] for s in info["edges"])
    info["min_support"] = min(s["n"] for s in info["edges"])
    return q, info
