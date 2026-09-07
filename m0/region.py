"""
Region selection with no UI.

Priority, per image `photos/table1.jpg`:
  1. sidecar `photos/table1.json`  (or a single `photos/regions.json` keyed by filename)
  2. `--click X,Y` on the command line (applies to every image -- only useful for one)
  3. nothing -> the image is SKIPPED, loudly. There is no silent auto-guess: an
     accidentally-wrong region is worse than a missing one, because it produces a
     number that looks real.

Sidecar keys (all coordinates in FULL-RESOLUTION pixels of the EXIF-uprighted image;
the harness rescales them for you):

  {"quad": [[x,y],[x,y],[x,y],[x,y]]}        <- the usual case. Four corners of the
                                                tabletop in order TL, TR, BR, BL
                                                (clockwise from the far-left corner).
                                                Gives BOTH the measurement region and
                                                the 4-tap baseline. Nothing else needed.

  {"click": [x,y]}                           <- SlimSAM segments the surface you clicked.
  {"clicks": [[x,y],...], "neg": [[x,y],...]}   several positive / negative points.
  {"polygon": [[x,y],...]}                   <- explicit outline, any number of points.

  Optional extras:
  {"fov": 68.0}      override the horizontal field of view for this photo
  {"note": "..."}    free text, copied into the JSON output

A `quad` can be combined with `click`/`polygon`: the click/polygon then defines the
measured region and the quad is used only for the 4-tap baseline.

`m0/pick.html` is a zero-dependency helper for reading off corner coordinates: open it,
drag a photo onto it, click the four corners, copy the JSON it prints. It is a
convenience, not a dependency -- any coordinates from any source work.
"""
import json, os
import numpy as np
from PIL import Image
import planefit as PF


def load_sidecar(img_path, photo_dir):
    stem = os.path.splitext(os.path.basename(img_path))[0]
    p = os.path.join(photo_dir, stem + ".json")
    if os.path.exists(p):
        return json.load(open(p))
    shared = os.path.join(photo_dir, "regions.json")
    if os.path.exists(shared):
        d = json.load(open(shared))
        for k in (os.path.basename(img_path), stem):
            if k in d:
                return d[k]
    return None


# ---------------------------------------------------------------- SlimSAM
_SAM = {}
def _sam():
    import onnxruntime as ort
    if not _SAM:
        so = ort.SessionOptions(); so.log_severity_level = 3
        for tag, f in (("enc", "slimsam_enc_q.onnx"), ("dec", "slimsam_dec_q.onnx")):
            path = os.path.join(PF.MODELS, f)
            if not os.path.exists(path):
                raise SystemExit(f"missing model {path} -- run m0/run.sh --fetch")
            _SAM[tag] = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    return _SAM["enc"], _SAM["dec"]


def sam_mask(img, points, labels):
    """SlimSAM-77. Preprocessing per the model's own config: longest edge -> 1024,
    zero-pad to 1024x1024. Returns a boolean mask at the image's own size."""
    enc, dec = _sam()
    W, H = img.size
    s = 1024.0 / max(W, H)
    rw, rh = int(round(W * s)), int(round(H * s))
    canvas = np.zeros((1024, 1024, 3), np.float32)
    canvas[:rh, :rw] = np.asarray(img.resize((rw, rh), Image.BILINEAR), np.float32) / 255.
    x = ((canvas - PF.MEAN) / PF.STD).transpose(2, 0, 1)[None]
    emb, pos = enc.run(None, {"pixel_values": x})
    pts = np.array([[[[p[0] * s, p[1] * s] for p in points]]], np.float32)
    lbl = np.array([[list(labels)]], np.int64)
    iou, masks = dec.run(None, {"input_points": pts, "input_labels": lbl,
                                "image_embeddings": emb, "image_positional_embeddings": pos})
    best = int(np.argmax(iou[0, 0]))
    m = masks[0, 0, best]                                   # 256x256 over the padded frame
    m = np.asarray(Image.fromarray(m.astype(np.float32)).resize((1024, 1024), Image.BILINEAR))
    m = m[:rh, :rw] > 0
    return np.asarray(Image.fromarray(m.astype(np.uint8) * 255).resize((W, H), Image.NEAREST)) > 127


# ---------------------------------------------------------------- entry point
def region_for(img, spec, scale, cli_click=None):
    """-> (mask, quad_or_None, how_string). Coordinates in `spec` are full-resolution."""
    W, H = img.size

    def sc(pts):
        return [[p[0] * scale, p[1] * scale] for p in pts]

    quad = None
    if spec and "quad" in spec:
        quad = np.asarray(sc(spec["quad"]), float)

    if spec and "polygon" in spec:
        return PF.polygon_mask(sc(spec["polygon"]), W, H), quad, "polygon"

    clicks, neg = None, []
    if spec and "clicks" in spec:
        clicks = sc(spec["clicks"]); neg = sc(spec.get("neg", []))
    elif spec and "click" in spec:
        clicks = sc([spec["click"]]); neg = sc(spec.get("neg", []))
    elif cli_click is not None:
        clicks = [[cli_click[0] * scale, cli_click[1] * scale]]

    if clicks:
        pts = list(clicks) + list(neg)
        lbl = [1] * len(clicks) + [0] * len(neg)
        m = sam_mask(img, pts, lbl)
        m = PF.largest_component(m, erode=7)
        return m, quad, f"slimsam({len(clicks)}+{len(neg)})"

    if quad is not None:
        return PF.polygon_mask(quad, W, H), quad, "quad"

    return None, None, "none"


def overlay(img, mask, quad, path):
    """Write a PNG showing exactly which pixels were measured. Look at these."""
    a = np.asarray(img, np.float32).copy()
    a[mask] = a[mask] * 0.45 + np.array([255., 60., 60.]) * 0.55
    out = Image.fromarray(a.astype(np.uint8))
    if quad is not None:
        from PIL import ImageDraw
        d = ImageDraw.Draw(out)
        q = [tuple(p) for p in np.asarray(quad, float)]
        d.line(q + [q[0]], fill=(60, 255, 60), width=3)
        for i, p in enumerate(q):
            d.ellipse([p[0] - 6, p[1] - 6, p[0] + 6, p[1] + 6], outline=(60, 255, 60), width=3)
            d.text((p[0] + 8, p[1] + 4), "TL TR BR BL".split()[i], fill=(60, 255, 60))
    out.save(path)
