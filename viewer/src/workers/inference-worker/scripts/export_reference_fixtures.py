"""Exports reference fixtures for the TS Inference Worker's test suite.

Reuses ../../quantization/preprocessing.py (load_hu_slice) and
lungmask.utils directly rather than reimplementing DICOM loading or the
reference preprocessing pipeline — this script's only job is to serialize
Python's known-correct output to a format the TS tests can diff against.

For each selected calibration slice, dumps:
  - raw HU array (float32, original resolution) — stub Parse Worker output
  - simple_bodymask's bbox (for isolating crop-region bugs from resize bugs)
  - the reference preprocessed 256x256 tensor (post 4-step pipeline)
  - the reference postprocessed mask (argmax + NN upscale) via the FP32 ONNX model

Usage:
    .venv/bin/python scripts/export_reference_fixtures.py
"""

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

REPO_ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO_ROOT / "ai-pipeline" / "quantization"))

from preprocessing import load_hu_slice  # noqa: E402
from lungmask.utils import crop_and_resize, simple_bodymask  # noqa: E402

CALIBRATION_DIR = REPO_ROOT / "ai-pipeline" / "quantization" / "calibration_data" / "selected"
ONNX_MODEL = REPO_ROOT / "ai-pipeline" / "conversion" / "adapters" / "lungmask" / "lungmask_r231.onnx"
OUT_DIR = REPO_ROOT / "ai-pipeline" / "quantization" / "calibration_data" / "inference_fixtures"
RESOLUTION = [256, 256]
NUM_FIXTURES = 5


def to_bin(path: Path, arr: np.ndarray) -> None:
    arr.astype(np.float32).tofile(path)


def main() -> None:
    dcm_files = sorted(CALIBRATION_DIR.glob("*.dcm"))[:NUM_FIXTURES]
    if not dcm_files:
        raise SystemExit(f"No calibration .dcm files found under {CALIBRATION_DIR}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    session = ort.InferenceSession(str(ONNX_MODEL), providers=["CPUExecutionProvider"])

    manifest = []
    for i, dcm_path in enumerate(dcm_files):
        hu = load_hu_slice(dcm_path)  # [H, W] float32
        height, width = hu.shape

        bmask = simple_bodymask(hu)
        bbox = _bbox_of(bmask)

        preprocessed, _ = crop_and_resize(np.clip(hu, -1024, 600), width=RESOLUTION[0], height=RESOLUTION[1])
        preprocessed = np.clip(preprocessed, None, 600)
        normalized = ((preprocessed + 1024) / 1624).astype(np.float32)

        logits = session.run(["logits"], {"input": normalized[np.newaxis, np.newaxis, :, :]})[0]
        argmax_native = np.argmax(logits[0], axis=0).astype(np.uint8)  # [256, 256]
        mask_upscaled = _nn_upscale(argmax_native, height, width)

        stem = dcm_path.stem
        to_bin(OUT_DIR / f"{stem}_hu.bin", hu)
        to_bin(OUT_DIR / f"{stem}_preprocessed.bin", normalized)
        (OUT_DIR / f"{stem}_mask.bin").write_bytes(mask_upscaled.astype(np.uint8).tobytes())

        manifest.append(
            {
                "stem": stem,
                "originalHeight": height,
                "originalWidth": width,
                "bodyMaskBbox": bbox,
                "argmaxClassCounts": {int(c): int(n) for c, n in zip(*np.unique(argmax_native, return_counts=True))},
            }
        )
        print(f"[{i + 1}/{len(dcm_files)}] {stem}: bbox={bbox}")

    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"Wrote {len(manifest)} fixtures to {OUT_DIR}")


def _bbox_of(bmask: np.ndarray) -> list:
    ys, xs = np.nonzero(bmask)
    if len(ys) == 0:
        return [0, 0, bmask.shape[0], bmask.shape[1]]
    return [int(ys.min()), int(xs.min()), int(ys.max()) + 1, int(xs.max()) + 1]


def _nn_upscale(mask: np.ndarray, out_h: int, out_w: int) -> np.ndarray:
    from scipy import ndimage

    return ndimage.zoom(mask, [out_h / mask.shape[0], out_w / mask.shape[1]], order=0)


if __name__ == "__main__":
    main()
