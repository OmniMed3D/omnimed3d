# Inference Worker — Verification Report

## Context (for anyone unfamiliar with this project)

This project runs an open-source lung segmentation model (`lungmask`,
variant "R231") entirely in the browser: given a CT scan slice, it
outputs a per-pixel label — background, right lung, or left lung — drawn
as a colored overlay on the 3D CT volume. The original PyTorch model was
converted to ONNX and additionally quantized into smaller INT8 and FP16
variants (three model files total: FP32, INT8, FP16). The in-browser
inference code lives at `viewer/src/workers/inference-worker/` and runs
via `onnxruntime-web`.

This report covers everything measured about that pipeline so far: does
it produce correct output, how fast is it, and how good is the
segmentation itself. It's split out of the team's internal working notes
so it can be shared directly — it's git-tracked, unlike the rest of that
log. Updated in place as new verification work lands; see each section's
date.

## Test Environment

MacBook, Apple M1 (8 cores / 16GB RAM), macOS 15.6, Node v20.19.0,
`onnxruntime-web` 1.27.0 (resolved; `package.json` pins `^1.19.2`) — run
as a Node process against the WASM (CPU) backend, not in a browser. All
results below are scoped to this environment and are not a substitute for
measurements on representative target hardware or a real browser.

## 1. Correctness Tests (2026-08-13, INT8/FP16 added 2026-08-14)

**Methodology:** `scripts/export_reference_fixtures.py` calls this
project's existing Python conversion/quantization code (reuses
`lungmask`'s own preprocessing function rather than reimplementing it) to
dump, for 5 sample CT slices: the raw pixel data (converted to Hounsfield
Units, the standard CT intensity scale), the preprocessed model input
tensor, and the resulting mask (from the FP32 ONNX model). The
TypeScript/browser implementation is tested by diffing its output
directly against these Python-computed values.

| Test file | Target | What it checks | Result |
| --- | --- | --- | --- |
| `preprocess.test.ts` | FP32 pipeline | Body-region bounding box — 5 sample slices | 5/5 exact match (bit-exact) |
| `preprocess.test.ts` | FP32 pipeline | Normalized 256×256 model input tensor vs. Python reference | max-abs-diff < 1e-3 (effectively bit-exact after fixing the zoom coordinate-mapping bug, see below) |
| `postprocess.test.ts` | Postprocess logic | Upscaling correctness + valid class-index range, on synthetic data | Pass |
| `pipeline.test.ts` | FP32 end-to-end | 5 sample slices, predicted mask vs. Python reference | < 1% pixel mismatch (overall); output message matches the documented delivery format exactly |
| `quantized-models.test.ts` | INT8/FP16 end-to-end | Loads and runs successfully via `onnxruntime-web`'s WASM backend | 10/10 passing (see §2 below) |

Typechecking is clean; the full test suite is **32/32 passing** (as of
2026-08-14, includes the latency benchmark).

**Known scope limitation:** `onnxruntime-web` can't auto-locate the
external weights file the FP32 model ships as (`.onnx.data`) when run
under Node, so tests read that file explicitly and pass it in (see
`test/pipeline.test.ts`) — whether real browser (fetch-based) loading
behaves the same way is unconfirmed.

**Notable bug caught during implementation — image-resizing coordinate
mapping:** the first implementation of the nearest-neighbor/bilinear
resize logic assumed a "half-pixel-center" coordinate convention (common
in image libraries like PIL/OpenCV/TensorFlow), which made every
body-region bounding box disagree with the Python reference. The Python
library actually used (`scipy`) defaults to a different convention
("align-corners") — found by comparing intermediate computation stages
one at a time against the Python reference until the exact point of
disagreement was found. Every stage of the pipeline is now bit-exact
against Python. Documented in the code (`ndimage.ts`'s `srcCoord()`) so
future work on this project doesn't repeat the mistake.

## 2. INT8/FP16 Fidelity — Per-Slice Detail (2026-08-14)

Pixel-level mismatch rate vs. the FP32 reference mask (Python, original
resolution):

| Slice | INT8 mismatch | FP16 mismatch |
| --- | --- | --- |
| LIDC-IDRI-0001_inst0034 | 0.029% | 0.000% |
| LIDC-IDRI-0001_inst0056 | 0.072% | 0.000% |
| LIDC-IDRI-0001_inst0078 | 0.095% | 0.000% |
| LIDC-IDRI-0002_inst0066 | 0.047% | 0.000% |
| LIDC-IDRI-0002_inst0109 | 0.069% | 0.002% |
| **Mean** | **0.062%** | **0.0004%** |

Matches earlier Python-only quantization measurements (INT8 99.95% / FP16
100% agreement with the FP32 model) at the same level — fidelity holds up
when the runtime changes from Python's `onnxruntime` to the browser's
`onnxruntime-web`.

## 3. Latency (2026-08-14)

This project's target is under 500ms per CT slice, measured as the time
from the start of the model's forward pass through producing the final
upscaled mask (i.e., `infer()` + `postprocess()` — preprocessing time is
tracked separately and isn't counted against this target).
`onnxruntime-web`'s thread-count/SIMD settings are left at their library
defaults (not configured explicitly anywhere in this codebase yet).

**Isolated run** (benchmark run alone — more trustworthy for absolute
numbers than the table below):

| Model | Preprocess (ms) | Infer (ms) | Postprocess (ms) | **Target-scoped time (ms)** | Total wall-clock (ms) | Under 500ms? |
| --- | --- | --- | --- | --- | --- | --- |
| FP32 | 55.9 | 792.4 | 1.8 | **794.2** | 850.1 | No |
| INT8 | 39.1 | 722.1 | 1.4 | **723.5** | 762.6 | No |
| FP16 | 40.0 | 813.0 | 1.4 | **814.4** | 854.4 | No |

**Concurrent run** (benchmark run at the same time as the rest of the
test suite, competing for machine resources):

| Model | Preprocess (ms) | Infer (ms) | Postprocess (ms) | **Target-scoped time (ms)** | Total wall-clock (ms) | Under 500ms? |
| --- | --- | --- | --- | --- | --- | --- |
| FP32 | 106.5 | 2255.0 | 2.8 | **2257.7** | 2364.2 | No |
| INT8 | 56.3 | 1234.2 | 2.2 | **1236.4** | 1292.7 | No |
| FP16 | 43.2 | 821.3 | 1.4 | **822.7** | 865.9 | No |

The gap between these two conditions (FP32: 794ms isolated vs. 2258ms
concurrent, ~3x) is itself a methodological finding — this benchmark
setup isn't stable enough for trustworthy absolute numbers under resource
contention; treat it as a relative comparison tool (across models, or
before/after a future optimization), and always run the benchmark in
isolation for an absolute reading.

**What the breakdown shows:** postprocessing is negligible (1-3ms), not
worth optimizing. Preprocessing is real but not dominant (40-110ms).
**Over 90% of total time is the model's forward pass itself** — that's
where any optimization effort belongs.

**Why the FP32 model isn't beaten by the FP16 model here — confirmed, not
assumed:** inspecting the underlying ONNX computation graphs directly:
- FP32: 72 computation nodes total (convolutions, activations, normalization layers), 0 data-type-conversion ("Cast") nodes
- FP16: **the exact same computation nodes as FP32**, plus 14 added Cast nodes → 86 nodes total
- INT8: same core convolution nodes, plus 190 quantize/dequantize nodes → 244 nodes total — far more nodes, yet still faster in practice

The FP16 conversion didn't reduce actual computation — it added
data-conversion overhead around unchanged FP32-precision math (this WASM
backend has no native FP16 compute; FP16's real speed benefit normally
comes from memory bandwidth or GPU-specific hardware, neither of which
apply to CPU/WASM execution). INT8 pays a much larger node-count overhead
but comes out ahead because the 8-bit integer math itself is genuinely
faster (inferred from the graph structure — not separately confirmed
with detailed per-operation timing).

**Thread-count experiment:** explicitly configured `onnxruntime-web` to
use 1, 4, and 8 threads and timed the INT8 model's forward pass at each
setting (synthetic input, 5 repeated measurements each):

| Thread count | 5 measurements (ms) | Mean (ms) |
| --- | --- | --- |
| 1 | 2629.96, 2460.14, 2467.42, 2462.63, 2456.29 | 2495.3 |
| 4 | 2469.14, 2459.04, 2457.77, 2469.38, 2459.49 | 2463.0 |
| 8 | 2471.10, 2468.23, 2475.27, 2470.74, 2490.77 | 2475.2 |

**No meaningful difference** (~30ms spread between the means, smaller
than the isolated-vs-concurrent noise mentioned above). Whether this is
because threading was already maxed out, or because this setting simply
isn't taking effect in this environment, can't be distinguished from this
experiment alone — worth re-checking in a real browser (thread support
depends on browser security headers that don't apply under Node). Don't
over-generalize this into "multithreading doesn't help" — that's not
what was actually shown.

**Remaining CPU-side speed-up options, not yet tried:** confirming which
underlying WASM binary variant (with/without SIMD vector instructions)
actually gets loaded, and checking the ONNX Runtime's graph-optimization
setting. GPU-accelerated inference isn't testable in this Node-based test
setup at all (no GPU access available); the natural time to add it is
once this project has a real browser-based build/test setup, since
testing the worker's real browser message-passing needs that
infrastructure anyway.

## 4. Segmentation Quality — Dice/IoU vs. Ground Truth (2026-08-16)

Everything above checks whether this pipeline's output agrees with
*something else in the same pipeline family* (a Python reference, a
less-quantized version of the same model). None of it checks whether the
output is actually correct segmentation. This section is the first
attempt at that.

**Methodology:** the CT dataset used for testing (LIDC-IDRI, a public
dataset) doesn't ship ground-truth lung-field masks — its annotations
mark tumor locations, not lung boundaries. Rather than sourcing a new
dataset, ground truth here is **the original, unmodified PyTorch
`lungmask` model's own output** (`scripts/export_ground_truth_masks.py`),
computed independently from scratch (a direct PyTorch forward pass, not
reusing the ONNX/browser pipeline's computation at all). This
intentionally excludes an extra cleanup step (`lungmask`'s own
connected-component/hole-filling postprocessing) that this project's
browser pipeline doesn't implement either — so the comparison is
apples-to-apples with what the browser pipeline actually claims to
produce.

**What this does and does not measure:** this is a **pipeline fidelity**
metric — "does the on-device pipeline (browser port, ONNX conversion,
INT8/FP16 quantization) reproduce what the original PyTorch model itself
outputs." It does **not** measure accuracy against real anatomy — if the
original model itself were wrong on some slice, a perfectly faithful
pipeline would still score a perfect match against it. Actual
clinical/anatomical accuracy would require comparing against
expert-annotated ground truth, which doesn't exist for this dataset;
that remains a genuinely open question, not something this section
answers. **For the same reason, these numbers are not comparable to the
`lungmask` model's own published accuracy score** (Hofmanninger et al.
2020, *"Automatic lung segmentation in routine imaging is primarily a
data diversity problem, not a methodology problem,"*
[DOI](https://doi.org/10.1186/s41747-020-00173-2)) — that published
number measures agreement with expert annotations on a completely
different dataset; it's cited here only as background on the model's
known quality tier, not as something these results are validated
against.

Dice and IoU are the two standard metrics for how well a predicted mask
overlaps a reference mask (0 = no overlap, 1 = identical). All 30 sample
CT slices (previous sections above used 5), per class:

| Model | Class | Dice mean | Dice min | IoU mean | IoU min |
| --- | --- | --- | --- | --- | --- |
| FP32 | right lung | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| FP32 | left lung | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| INT8 | right lung | 0.9985 | 0.9932 | 0.9971 | 0.9864 |
| INT8 | left lung | 0.9991 | 0.9982 | 0.9982 | 0.9964 |
| FP16 | right lung | 1.0000 | 0.9999 | 1.0000 | 0.9997 |
| FP16 | left lung | 1.0000 | 0.9999 | 1.0000 | 0.9998 |

**The FP32 model matches the reference exactly on all 30 slices** — the
browser-based inference pipeline makes identical pixel-classification
decisions to the original native Python pipeline on every slice tested.
This is consistent with (not independent proof beyond) two earlier,
narrower checks that had already found each individual step of this
chain to be extremely close: the ONNX conversion step (essentially
perfect agreement with the original PyTorch model) and the browser port's
preprocessing step (bit-exact vs. the Python version, see §1) — those
margins are small enough that they never changed a single pixel's
classification on this 30-slice set.

**Limitations:** (1) this only measures fidelity to the reference model
on 30 slices from one dataset — it says nothing about whether the
underlying model itself generalizes well to new or more diverse data
(the source paper's own title is literally about this problem:
*"primarily a data diversity problem"*). (2) The test dataset differs
from the model's original training data, so this incidentally exercises
some amount of "different data than it was trained on," but it isn't a
rigorous test of that specifically. (3) Actual accuracy against real
expert-annotated ground truth remains unmeasured — revisit if/when an
annotated lung-segmentation dataset becomes available.

**Practical takeaway:** the browser pipeline (including INT8/FP16
quantization) faithfully reproduces the original model's decisions — the
porting and quantization work introduces no meaningful fidelity loss.
Whether the original model's decisions are themselves clinically accurate
is a separate, still-open question.
