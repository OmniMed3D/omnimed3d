"""Convert the lungmask R231 U-net model to ONNX (REQ-A01, Epic 1 / Step 1).

Loads the pretrained R231 weights via the `lungmask` package, which handles
downloading/caching `unet_r231-d5d2fc3d.pth` (Apache-2.0) through torch.hub,
then exports the underlying PyTorch nn.Module to ONNX using a dummy input.

Verified against the JoHof/lungmask source (mask.py / utils.py):
- Model: UNet, n_classes=3 (0=background, 1=right lung, 2=left lung)
- Input: [1, 1, 256, 256] float32, HU-normalized: clip(HU, max=600); (HU + 1024) / 1624
- Output: [1, 3, 256, 256] raw logits (argmax over dim=1 is done outside the model,
  see check_parity.py / MODEL_SPEC.md)
"""

import argparse
from pathlib import Path

import torch
from lungmask.mask import get_model

# Fixed by the R231 architecture/training — not a free parameter. See MODEL_SPEC.md.
INPUT_RESOLUTION = (256, 256)


def convert(output_path: Path, opset_version: int) -> None:
    model = get_model("R231")
    model.eval()

    dummy_input = torch.randn(1, 1, *INPUT_RESOLUTION, dtype=torch.float32)

    torch.onnx.export(
        model,
        dummy_input,
        str(output_path),
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=opset_version,
    )
    print(f"Exported ONNX model to {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("lungmask_r231.onnx"))
    parser.add_argument(
        "--opset-version",
        type=int,
        default=18,
        help=(
            "ONNX opset version. 18 is the minimum this model's ops (e.g. Resize) "
            "export cleanly at with the installed torch/onnxscript versions — lower "
            "values trigger a failed downconversion fallback. Not yet verified "
            "against the ONNX Runtime Web version targeted in Epic 4 (REQ-A03) — "
            "re-check compatibility there."
        ),
    )
    args = parser.parse_args()
    convert(args.output, args.opset_version)
