"""Benchmark Depth Anything V2 Small (ONNX) and dump the predicted depth map."""
import sys, time, json, os
import numpy as np, onnxruntime as ort
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "..", "models")
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD  = np.array([0.229, 0.224, 0.225], np.float32)
SIZE = 518

def preprocess(img):
    im = img.convert("RGB").resize((SIZE, SIZE), Image.BICUBIC)
    a = (np.asarray(im, np.float32) / 255.0 - MEAN) / STD
    return a.transpose(2, 0, 1)[None].astype(np.float32)

def bench(model_path, img, provider, runs=10):
    so = ort.SessionOptions(); so.log_severity_level = 3
    sess = ort.InferenceSession(model_path, so, providers=[provider])
    iname = sess.get_inputs()[0].name
    x = preprocess(img)
    sess.run(None, {iname: x})                     # warm-up
    ts = []
    for _ in range(runs):
        t0 = time.perf_counter(); out = sess.run(None, {iname: x}); ts.append((time.perf_counter()-t0)*1000)
    ts = np.array(ts)
    return dict(p50=float(np.percentile(ts,50)), mean=float(ts.mean()), min=float(ts.min()),
                max=float(ts.max()), fps=float(1000/np.percentile(ts,50))), out[0]

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "out", "scene.png")
    img = Image.open(src)
    results = {}
    pred_keep = None
    for tag, path in [("dav2s-int8-quant", "dav2s_q.onnx"), ("dav2s-fp32", "dav2s_fp32.onnx")]:
        for prov in ["CPUExecutionProvider", "CoreMLExecutionProvider"]:
            try:
                st, out = bench(os.path.join(MODELS, path), img, prov)
                results[f"{tag}/{prov.replace('ExecutionProvider','')}"] = st
                print(f"{tag:18s} {prov.replace('ExecutionProvider',''):8s} "
                      f"p50={st['p50']:7.1f}ms  ({st['fps']:5.2f} fps)  min={st['min']:.0f} max={st['max']:.0f}")
                if tag == "dav2s-fp32" and prov == "CPUExecutionProvider":
                    pred_keep = np.squeeze(out)
            except Exception as e:
                print(f"{tag} {prov}: FAILED {type(e).__name__}: {str(e)[:120]}")
    if pred_keep is not None:
        # model emits RELATIVE INVERSE depth (disparity) at 518x518; resize to image size
        d = Image.fromarray(pred_keep.astype(np.float32), mode="F").resize(img.size, Image.BILINEAR)
        np.save(os.path.join(HERE, "out", "pred_disp.npy"), np.asarray(d, np.float32))
        print(f"\nsaved pred_disp.npy  shape={img.size[::-1]}  raw range {pred_keep.min():.3f}..{pred_keep.max():.3f}")
    json.dump(results, open(os.path.join(HERE, "out", "depth_bench.json"), "w"), indent=2)
