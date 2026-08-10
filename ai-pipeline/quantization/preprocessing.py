"""Shared DICOM -> model-input-tensor preprocessing, used by both
quantize_ptq.py's calibration reader and check_quantized_parity.py.

Reuses lungmask.utils.preprocess (HU clip + crop-to-body + resize) instead
of reimplementing it, then applies the same final normalize step
lungmask/mask.py applies after that call — this mirrors the full pipeline
documented in ../conversion/adapters/lungmask/MODEL_SPEC.md exactly, rather
than risking drift from a hand-rolled reimplementation.
"""

from pathlib import Path

import numpy as np
import pydicom
from lungmask.utils import preprocess as lungmask_preprocess

# Must match conversion/adapters/lungmask/convert_to_onnx.py INPUT_RESOLUTION
RESOLUTION = [256, 256]


def load_hu_slice(path: Path) -> np.ndarray:
    d = pydicom.dcmread(path)
    return d.pixel_array.astype(np.float32) * float(d.RescaleSlope) + float(
        d.RescaleIntercept
    )


def load_and_preprocess(paths: list[Path]) -> np.ndarray:
    """Returns a [N, 1, 256, 256] float32 array, one model-ready tensor per input DICOM file."""
    volume = np.stack([load_hu_slice(p) for p in paths], axis=0)
    tvolslices, _ = lungmask_preprocess(volume, resolution=RESOLUTION)
    tvolslices[tvolslices > 600] = 600
    normalized = np.divide(tvolslices + 1024, 1624).astype(np.float32)
    return normalized[:, np.newaxis, :, :]
