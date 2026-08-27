"""Exports ground-truth masks for Dice/IoU validation (REQ-A10).

Ground truth = the raw, unmodified PyTorch lungmask R231 model (not our
ONNX/TS pipeline) run independently: load -> lungmask.utils.preprocess ->
model.forward() -> argmax -> Nearest-Neighbor upscale to original
resolution. This deliberately does NOT go through ONNX at all, so it's an
independent re-derivation of the whole chain rather than reusing anything
already parity-checked in Epic 1/2/4 -- it answers "does our end-to-end
pipeline still agree with the actual reference model" as one composite
check, not "does ONNX Runtime agree with itself."

Deliberately excludes lungmask.utils.postprocessing() (the connected-
component cleanup / hole-filling lungmask normally applies) -- our own
postprocess.ts doesn't implement that step either (only argmax + NN
upscale, per REQ-A17's scope), so comparing against the un-cleaned raw
argmax output is the apples-to-apples ground truth for what our pipeline
actually claims to do, not the "best possible" official output.

Usage:
    .venv/bin/python scripts/export_ground_truth_masks.py
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch
from scipy import ndimage

REPO_ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO_ROOT / "ai-pipeline" / "quantization"))

from preprocessing import load_hu_slice  # noqa: E402
from lungmask.mask import get_model  # noqa: E402
from lungmask.utils import preprocess as lungmask_preprocess  # noqa: E402

CALIBRATION_DIR = (
    REPO_ROOT / "ai-pipeline" / "quantization" / "calibration_data" / "selected"
)
OUT_DIR = (
    REPO_ROOT
    / "ai-pipeline"
    / "quantization"
    / "calibration_data"
    / "ground_truth_fixtures"
)
RESOLUTION = [256, 256]


def main() -> None:
    dcm_files = sorted(CALIBRATION_DIR.glob("*.dcm"))
    if not dcm_files:
        raise SystemExit(f"No calibration .dcm files found under {CALIBRATION_DIR}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    model = get_model("R231")
    model.eval()

    manifest = []
    for i, dcm_path in enumerate(dcm_files):
        hu = load_hu_slice(dcm_path)
        height, width = hu.shape

        # lungmask_preprocess expects a volume-shaped [N, H, W] array (it
        # iterates per slice internally) -- wrap this single slice as N=1.
        # Its second return value is the per-slice body-mask crop bounding
        # box ((min_row, min_col, max_row, max_col), skimage regionprops
        # convention), needed below to restore the crop before upscaling to
        # full resolution.
        preprocessed, bboxes = lungmask_preprocess(
            np.clip(hu, -1024, 600)[np.newaxis, :, :], resolution=RESOLUTION
        )
        bbox = bboxes[0]
        preprocessed = np.clip(preprocessed, None, 600)
        normalized = ((preprocessed + 1024) / 1624).astype(
            np.float32
        )  # shape [1, 256, 256]

        with torch.inference_mode():
            input_tensor = torch.from_numpy(normalized[np.newaxis, :, :, :]).float()
            logits = model(input_tensor)
            argmax_native = torch.argmax(logits, dim=1)[0].numpy().astype(np.uint8)

        # Upscale to the crop bbox's own size (not the full slice), then
        # paste into a zero-initialized (background) full-resolution
        # canvas at the bbox's offset -- mirrors postprocess.ts's own
        # upscaling logic.
        min_row, min_col, max_row, max_col = bbox
        crop_h, crop_w = max_row - min_row, max_col - min_col
        upscaled_crop = ndimage.zoom(
            argmax_native,
            [crop_h / argmax_native.shape[0], crop_w / argmax_native.shape[1]],
            order=0,
        ).astype(np.uint8)
        mask_upscaled = np.zeros((height, width), dtype=np.uint8)
        mask_upscaled[min_row:max_row, min_col:max_col] = upscaled_crop

        stem = dcm_path.stem
        hu.astype(np.float32).tofile(OUT_DIR / f"{stem}_hu.bin")
        (OUT_DIR / f"{stem}_groundtruth.bin").write_bytes(mask_upscaled.tobytes())

        manifest.append(
            {"stem": stem, "originalHeight": height, "originalWidth": width}
        )
        print(f"[{i + 1}/{len(dcm_files)}] {stem}")

    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"Wrote {len(manifest)} ground-truth fixtures to {OUT_DIR}")


if __name__ == "__main__":
    main()
