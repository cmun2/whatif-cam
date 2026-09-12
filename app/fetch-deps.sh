#!/usr/bin/env bash
# Everything the app needs that is too big to keep in git.
#
#   ./app/fetch-deps.sh
#
# Two kinds of thing, both free, both open-weight, no account and no key:
#   - the ONNX Runtime Web build (~24 MB, MIT) into app/vendor/ort/
#   - the model weights (~39 MB shippable + 99 MB fp32 reference) into models/
#
# Anything already present is left alone. After this the app runs with the network off.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORT_VERSION="1.23.0"

mkdir -p "$ROOT/app/vendor/ort" "$ROOT/models"

echo "onnxruntime-web ${ORT_VERSION} (MIT)"
# The webgpu bundle needs BOTH wasm builds: jsep for the WebGPU path, asyncify for the
# CPU fallback. Ship only jsep and a browser without WebGPU 404s and dies with
# "no available backend found" -- which is what happened the first time.
for f in ort.webgpu.bundle.min.mjs \
         ort-wasm-simd-threaded.jsep.mjs ort-wasm-simd-threaded.jsep.wasm \
         ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm; do
  if [ -f "$ROOT/app/vendor/ort/$f" ]; then echo "  have $f"; continue; fi
  echo "  fetching $f"
  curl -fL --retry 3 -o "$ROOT/app/vendor/ort/$f" \
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/$f"
done

# The same weights and the same URLs as m0/run.sh --fetch, so the app and the gate are
# demonstrably running the same models.
echo "model weights"
declare -a U=(
  "dav2s_q.onnx|https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx"
  "slimsam_enc_q.onnx|https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder_quantized.onnx"
  "slimsam_dec_q.onnx|https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx"
  "dav2s_fp32.onnx|https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx"
)
for e in "${U[@]}"; do
  f="${e%%|*}"; u="${e#*|}"
  if [ -f "$ROOT/models/$f" ]; then echo "  have $f"; continue; fi
  echo "  fetching $f"
  curl -fL --retry 3 -o "$ROOT/models/$f" "$u"
done

echo
echo "done. run:  ./app/run.sh"
