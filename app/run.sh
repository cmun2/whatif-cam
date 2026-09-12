#!/usr/bin/env bash
# WhatIf Cam v0.0. One command.
#
#   ./app/run.sh          serve the app and open it
#   ./app/run.sh --test   run the headless test suite instead (no browser, no camera)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" = "--test" ]; then exec node "$ROOT/tests/run.js"; fi

missing=0
for f in "$ROOT/app/vendor/ort/ort.webgpu.bundle.min.mjs" \
         "$ROOT/app/vendor/ort/ort-wasm-simd-threaded.jsep.wasm" \
         "$ROOT/models/dav2s_q.onnx" "$ROOT/models/slimsam_enc_q.onnx" \
         "$ROOT/models/slimsam_dec_q.onnx"; do
  [ -f "$f" ] || missing=1
done
if [ "$missing" = 1 ]; then
  echo "some dependencies are missing (they are gitignored -- a clone does not have them)"
  "$ROOT/app/fetch-deps.sh"
fi

exec python3 "$ROOT/app/serve.py" "${1:-8017}"
