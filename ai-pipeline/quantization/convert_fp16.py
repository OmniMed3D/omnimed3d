"""FP16 conversion of the lungmask R231 ONNX model (REQ-A02, Epic 2 / Step 2).

No calibration data needed, unlike the INT8 path in quantize_ptq.py — FP16
is a direct weight/activation cast, not a calibrated range quantization.
"""

import argparse
from pathlib import Path

import onnx
from onnxconverter_common import float16


def convert(model_input: Path, model_output: Path) -> None:
    model = onnx.load(str(model_input))
    # keep_io_types=True: external input/output stay float32 (Cast nodes
    # inserted at the boundary) so callers don't need FP16-specific
    # handling — matches how the FP32/INT8 models are fed in
    # check_quantized_parity.py.
    model_fp16 = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(model_fp16, str(model_output))
    print(f"Wrote FP16 model to {model_output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    conv_dir = Path(__file__).parent.parent / "conversion" / "adapters" / "lungmask"
    parser.add_argument(
        "--model-input", type=Path, default=conv_dir / "lungmask_r231.onnx"
    )
    parser.add_argument(
        "--model-output", type=Path, default=Path("lungmask_r231_fp16.onnx")
    )
    args = parser.parse_args()
    convert(args.model_input, args.model_output)
