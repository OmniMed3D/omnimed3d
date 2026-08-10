# lungmask R231 — Model I/O Spec

Reference for the Parse Worker / Inference Worker adapter (Epic 3/4) and the
mask contract handoff (Epic 6). Verified against the JoHof/lungmask source
(`mask.py`, `utils.py`) as of this writing — re-verify if the pinned
`lungmask` version in `requirements.txt` changes.

## Input

| Field | Value |
| --- | --- |
| Shape | `[1, 1, 256, 256]` (batch, channel, H, W) — fixed by the R231 architecture, not configurable |
| Dtype | `float32` |
| Preprocessing | Per-slice, see below — **correction (2026-08-10, verified against `lungmask/utils.py` while building Epic 2's calibration reader): earlier version of this doc was incomplete/wrong.** |
| Constraint | Model operates on full 2D slices only; the slice must show the complete lung, surrounded by tissue, to segment correctly |

**Full preprocessing pipeline (`lungmask.utils.preprocess` + the normalize step `mask.py` applies after it — not a single function):**
1. Clip HU to **`[-1024, 600]`** (both bounds — not max-only as previously documented here).
2. `simple_bodymask`: threshold at −500 HU, morphological closing/hole-fill/erosion/dilation, keep the largest connected component → binary body mask.
3. `crop_and_resize`: crop the slice to that body mask's bounding box, **then** resize to `256x256` via `scipy.ndimage.zoom` (bilinear, `order=1`) — this is a crop-then-resize, not a plain resize of the full slice. Anything implementing this preprocessing outside Python (e.g. the browser Parse Worker in Epic 3/4) needs to replicate the body-crop step, not just downsample the raw slice.
4. Re-clip upper bound at 600 (redundant with step 1 in the reference implementation, kept here only for exact fidelity) and normalize: `(HU + 1024) / 1624`.

Epic 2's `../../../quantization/quantize_ptq.py` calls `lungmask.utils.preprocess` directly for its calibration data reader rather than reimplementing steps 1-3 by hand, specifically to avoid drifting from this real behavior.

## Output (raw model forward pass)

| Field | Value |
| --- | --- |
| Shape | `[1, 3, 256, 256]` (batch, class_logits, H, W) |
| Dtype | `float32` (raw logits, pre-argmax) |
| Classes | `0` = background, `1` = right lung, `2` = left lung |

## Output (after adapter postprocess — REQ-A17)

The raw `[1, 3, 256, 256]` logits are **not** what crosses the REQ-C01 contract
boundary. The adapter's postprocess stage (built in Epic 4/5, not in this
directory) must:

1. `argmax` over the class-logit dimension → `uint8` class-index mask at the
   model's native `256x256` resolution.
2. Upscale that mask to the **original DICOM slice resolution**, using
   **Nearest-Neighbor interpolation only** (never bilinear/trilinear — those
   would produce non-integer values between class indices, which are
   meaningless for a `uint8` label mask).
3. Only after this upscaling is complete does a slice enter the progressive,
   per-slice delivery flow to the rendering engine (REQ-A06). A slice that
   hasn't finished upscaling must not cross this boundary.

This mirrors the REQ-C01 mask data contract: `uint8` single-channel class
indices, delivered at the same resolution as the original input volume,
slice by slice.

## Conversion artifacts

`convert_to_onnx.py` exports the *raw* model (native `256x256` logits output,
step "Output (raw model forward pass)" above) — the argmax + NN-upscale
postprocessing described above is intentionally **not** baked into the ONNX
graph here; it belongs to the browser-side adapter's postprocess stage so it
can be implemented against the actual Inference Worker's compute constraints
(WASM vs. WebGPU, still undecided — see PRD 10.2).

**Opset version:** empirically, opset 18 is required — the model's `Resize`
op (used in the U-Net decoder's upsampling path) fails to downconvert to
opset 17 with the installed torch/onnxscript versions. Not yet verified
against the specific ONNX Runtime Web version Epic 4 (REQ-A03) will target;
re-check opset 18 op coverage there.

**Export parity:** logit-level output differs slightly between the PyTorch
and ONNX Runtime executions (max abs diff ≈ 3.4e-4 on a synthetic input) due
to differing conv/resize kernel implementations — this is normal for a
network this deep, not an export defect. Argmax class predictions (the
actual segmentation output) matched exactly (100%) on the same check. See
`check_parity.py` for the verification script and its documented tolerance
rationale.
