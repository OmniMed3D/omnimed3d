"""Generates dummy-lungmask.onnx, a tiny (no learned weights) ONNX graph
matching the real lungmask model's I/O contract exactly
(ai-pipeline/conversion/adapters/lungmask/MODEL_SPEC.md):

  input  "input"  float32 [1, 1, 256, 256]
  output "logits" float32 [1, 3, 256, 256]

Built as a static Concat of the input tensor with itself 3 times along the
class-channel axis -- not a real segmentation model, purely for exercising
ort.InferenceSession.create()/session.run() plumbing in the Playwright e2e
test (viewer/tests/e2e/shell-mask-integration.spec.ts). Requires `pip
install onnx` once to regenerate; the committed .onnx output is what tests
actually load.
"""

from pathlib import Path

import onnx
from onnx import TensorProto, helper

INPUT_SHAPE = [1, 1, 256, 256]
OUTPUT_SHAPE = [1, 3, 256, 256]

input_tensor = helper.make_tensor_value_info("input", TensorProto.FLOAT, INPUT_SHAPE)
output_tensor = helper.make_tensor_value_info("logits", TensorProto.FLOAT, OUTPUT_SHAPE)

concat_node = helper.make_node(
    "Concat",
    inputs=["input", "input", "input"],
    outputs=["logits"],
    axis=1,
    name="dummy_concat",
)

graph = helper.make_graph(
    nodes=[concat_node],
    name="dummy-lungmask",
    inputs=[input_tensor],
    outputs=[output_tensor],
)

model = helper.make_model(graph, producer_name="dummy-lungmask-generator", opset_imports=[helper.make_opsetid("", 18)])
model.ir_version = 8
onnx.checker.check_model(model)

out_path = Path(__file__).parent / "dummy-lungmask.onnx"
onnx.save(model, out_path)
print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")
