#!/usr/bin/env bash
# M0 gate. One command.
#
#   ./m0/run.sh photos/        measure a directory of photos and print the verdict
#   ./m0/run.sh --selftest     check the harness against published probe numbers (~25 s)
#   ./m0/run.sh --validate     ground-truth check on the NYU frames already in probe/out
#   ./m0/run.sh --validate --fov-sweep   how much the assumed focal length moves the answer
#   ./m0/run.sh --demo         worked example on the synthetic scene, no photos needed
#   ./m0/run.sh --pick         open the corner picker in a browser
#   ./m0/run.sh --fetch        (re)download the ONNX models if any are missing
#
# Anything after the directory is passed through to m0/measure.py:
#   ./m0/run.sh photos/ --size 392 --keep-aspect --tap-sigma 1
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PY="$ROOT/.venv/bin/python"

if [ ! -x "$PY" ]; then
  echo "no .venv -- creating it"
  python3 -m venv "$ROOT/.venv"
  "$ROOT/.venv/bin/pip" -q install numpy pillow onnxruntime scipy h5py
fi

need_models() {
  for m in dav2s_fp32.onnx slimsam_enc_q.onnx slimsam_dec_q.onnx; do
    [ -f "$ROOT/models/$m" ] || return 0
  done
  return 1
}

fetch() {
  mkdir -p "$ROOT/models"
  # Same weights the research round used. Apache-2.0 (DAv2-Small) / Apache-2.0 (SlimSAM-77).
  # Nothing gated, no login, no cost. Skips anything already present.
  declare -a U=(
    "dav2s_fp32.onnx|https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx"
    "dav2s_q.onnx|https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx"
    "slimsam_enc_q.onnx|https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder_quantized.onnx"
    "slimsam_dec_q.onnx|https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx"
  )
  for e in "${U[@]}"; do
    f="${e%%|*}"; u="${e#*|}"
    if [ -f "$ROOT/models/$f" ]; then echo "have $f"; continue; fi
    echo "fetching $f"
    curl -fL --retry 3 -o "$ROOT/models/$f" "$u"
  done
}

case "${1:-}" in
  --fetch)    fetch; exit 0 ;;
  --selftest) exec "$PY" "$HERE/selftest.py" ;;
  --validate) shift; exec "$PY" "$HERE/validate_nyu.py" "$@" ;;
  --demo)     exec "$PY" "$HERE/demo.py" ;;
  --pick)     exec open "$HERE/pick.html" ;;
  ""|-h|--help)
    awk 'NR>=2 && NR<=13 {sub(/^# ?/,""); print}' "$HERE/run.sh"
    exit 0 ;;
esac

if need_models; then
  echo "some ONNX models are missing -- fetching (nothing already present is re-downloaded)"
  fetch
fi
exec "$PY" "$HERE/measure.py" "$@"
