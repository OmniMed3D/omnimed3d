"""Native ONNX Runtime latency baseline for the On-Device Overhead
Multiplier metric (PRD Section 4: browser (onnxruntime-web) time / native
time, target < 3x). This produces the denominator; see the paired
browser-side latency issue for the numerator.

Reuses the exact same single input slice as the browser benchmark
(viewer/src/workers/inference-worker/test/latency-benchmark.test.ts,
which times entry[0] of the ground-truth manifest -- LIDC-IDRI-0001_inst0034)
and the same methodology (5 iterations, mean of wall-clock ms, no separate
warmup run excluded from the mean) so the two numbers are directly
comparable rather than incidentally similar.

Times only the forward pass (session.run()), matching what the browser
side calls "infer". This project's postprocess step (argmax + NN
upscale) is TypeScript-only and already confirmed negligible (1-3ms, see
docs/verification/inference-worker.md Section 3), so it isn't
reimplemented here. Preprocessing is timed too for visibility but, per
the PRD's scoping (Section 4 / CLAUDE.md "Success Metrics Owned"), isn't
part of the infer+postprocess budget the multiplier is defined against.
"""

import argparse
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

from preprocessing import load_and_preprocess

HERE = Path(__file__).parent
DEFAULT_SLICE = HERE / "calibration_data" / "selected" / "LIDC-IDRI-0001_inst0034.dcm"
ITERATIONS = 5


def measure_infer(model_path: Path, tensor: np.ndarray) -> list[float]:
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    infer_ms = []
    for _ in range(ITERATIONS):
        t0 = time.perf_counter()
        session.run(None, {"input": tensor})
        infer_ms.append((time.perf_counter() - t0) * 1000)
    return infer_ms


def main(fp32_path: Path, int8_path: Path, fp16_path: Path, slice_path: Path) -> None:
    t0 = time.perf_counter()
    tensor = load_and_preprocess([slice_path])
    preprocess_ms = (time.perf_counter() - t0) * 1000
    print(f"Slice: {slice_path.name}")
    print(f"Preprocess: {preprocess_ms:.1f}ms (not part of the infer budget)\n")

    rows: list[tuple[str, float, list[float]]] = []
    for label, path in [("FP32", fp32_path), ("INT8", int8_path), ("FP16", fp16_path)]:
        if not path.exists():
            print(f"Skipping {label} ({path} not found)")
            continue
        infer_ms = measure_infer(path, tensor)
        rows.append((label, sum(infer_ms) / len(infer_ms), infer_ms))

    print(f"{'Model':<6} {'mean infer (ms)':>16}   per-iteration (ms)")
    for label, mean_infer, infer_ms in rows:
        samples = ", ".join(f"{v:.1f}" for v in infer_ms)
        print(f"{label:<6} {mean_infer:>16.1f}   [{samples}]")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    conv_dir = HERE.parent / "conversion" / "adapters" / "lungmask"
    parser.add_argument(
        "--fp32-path", type=Path, default=conv_dir / "lungmask_r231.onnx"
    )
    parser.add_argument(
        "--int8-path", type=Path, default=HERE / "lungmask_r231_int8.onnx"
    )
    parser.add_argument(
        "--fp16-path", type=Path, default=HERE / "lungmask_r231_fp16.onnx"
    )
    parser.add_argument("--slice-path", type=Path, default=DEFAULT_SLICE)
    args = parser.parse_args()
    main(args.fp32_path, args.int8_path, args.fp16_path, args.slice_path)
