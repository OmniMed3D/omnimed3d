"""Sanity comparison: FP32 baseline vs. INT8 and FP16 quantized models
(REQ-A02, Epic 2 / Step 3).

NOT the formal REQ-A10 Dice/IoU verification (P1, separately scoped) — this
is a lightweight regression check using the calibration slices themselves
(no separate held-out set at this prototype stage, given only 30 slices
total). Reports argmax class-prediction agreement % against the FP32
baseline; does not assert a pass/fail threshold, since PRD 10.2 leaves the
acceptable accuracy degradation threshold undecided as an open team
question.
"""

import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort

from preprocessing import load_and_preprocess

DEFAULT_CALIBRATION_DIR = Path(__file__).parent / "calibration_data" / "selected"


def run_model(model_path: Path, tensors: np.ndarray) -> np.ndarray:
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    outputs = [
        session.run(None, {"input": tensors[i : i + 1]})[0] for i in range(len(tensors))
    ]
    return np.concatenate(outputs, axis=0)


def agreement(a: np.ndarray, b: np.ndarray) -> float:
    return float((a.argmax(axis=1) == b.argmax(axis=1)).mean())


def main(
    fp32_path: Path, int8_path: Path, fp16_path: Path, calibration_dir: Path
) -> None:
    paths = sorted(calibration_dir.glob("*.dcm"))
    if not paths:
        raise FileNotFoundError(f"No .dcm files in {calibration_dir}")
    tensors = load_and_preprocess(paths)
    print(f"Evaluating on {len(paths)} slices from {calibration_dir}")

    fp32_out = run_model(fp32_path, tensors)

    if int8_path.exists():
        int8_out = run_model(int8_path, tensors)
        print(
            f"INT8 vs FP32 argmax agreement: {agreement(fp32_out, int8_out) * 100:.2f}%"
        )
    else:
        print(f"Skipping INT8 ({int8_path} not found)")

    if fp16_path.exists():
        fp16_out = run_model(fp16_path, tensors)
        print(
            f"FP16 vs FP32 argmax agreement: {agreement(fp32_out, fp16_out) * 100:.2f}%"
        )
    else:
        print(f"Skipping FP16 ({fp16_path} not found)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    conv_dir = Path(__file__).parent.parent / "conversion" / "adapters" / "lungmask"
    parser.add_argument(
        "--fp32-path", type=Path, default=conv_dir / "lungmask_r231.onnx"
    )
    parser.add_argument(
        "--int8-path", type=Path, default=Path("lungmask_r231_int8.onnx")
    )
    parser.add_argument(
        "--fp16-path", type=Path, default=Path("lungmask_r231_fp16.onnx")
    )
    parser.add_argument("--calibration-dir", type=Path, default=DEFAULT_CALIBRATION_DIR)
    args = parser.parse_args()
    main(args.fp32_path, args.int8_path, args.fp16_path, args.calibration_dir)
