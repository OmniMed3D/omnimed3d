"""INT8 static PTQ quantization of the lungmask R231 ONNX model (REQ-A02, Epic 2 / Step 1).

Uses ONNX Runtime's quantize_static with a CalibrationDataReader built from
calibration_data/selected/ (real LIDC-IDRI CT slices — see README.md for
provenance). Does not hardcode an accuracy pass/fail threshold; see
check_quantized_parity.py for the sanity comparison against the FP32
baseline.
"""

import argparse
from pathlib import Path

from onnxruntime.quantization import (
    CalibrationDataReader,
    QuantFormat,
    QuantType,
    quantize_static,
)

from preprocessing import load_and_preprocess

DEFAULT_CALIBRATION_DIR = Path(__file__).parent / "calibration_data" / "selected"


class LungCTCalibrationDataReader(CalibrationDataReader):
    def __init__(self, calibration_dir: Path, input_name: str = "input"):
        paths = sorted(calibration_dir.glob("*.dcm"))
        if not paths:
            raise FileNotFoundError(
                f"No .dcm files in {calibration_dir} — see README.md for how to populate it"
            )
        tensors = load_and_preprocess(paths)
        self._iter = iter({input_name: tensors[i : i + 1]} for i in range(len(tensors)))

    def get_next(self):
        return next(self._iter, None)


def quantize(model_input: Path, model_output: Path, calibration_dir: Path) -> None:
    # ORT recommends running quant_pre_process (shape inference) before
    # static quantization, but symbolic shape inference fails on this graph
    # (a gap for some op patterns from torch's dynamo-based exporter) and
    # re-loading external-data models from a temp directory has its own
    # issue. quantize_static runs cleanly without it (just an advisory
    # warning), and check_quantized_parity.py empirically confirms the
    # result (99.95% argmax agreement with FP32 on real CT slices), so this
    # skips quant_pre_process rather than fighting the external-data path.
    reader = LungCTCalibrationDataReader(calibration_dir)
    quantize_static(
        model_input=str(model_input),
        model_output=str(model_output),
        calibration_data_reader=reader,
        quant_format=QuantFormat.QDQ,
        weight_type=QuantType.QInt8,
        activation_type=QuantType.QInt8,
    )
    print(f"Wrote INT8 model to {model_output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    conv_dir = Path(__file__).parent.parent / "conversion" / "adapters" / "lungmask"
    parser.add_argument(
        "--model-input", type=Path, default=conv_dir / "lungmask_r231.onnx"
    )
    parser.add_argument(
        "--model-output", type=Path, default=Path("lungmask_r231_int8.onnx")
    )
    parser.add_argument("--calibration-dir", type=Path, default=DEFAULT_CALIBRATION_DIR)
    args = parser.parse_args()
    quantize(args.model_input, args.model_output, args.calibration_dir)
