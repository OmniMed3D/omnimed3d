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
| LIDC-IDRI-0001_inst0034 | 0.019% | 0.000% |
| LIDC-IDRI-0001_inst0056 | 0.044% | 0.000% |
| LIDC-IDRI-0001_inst0078 | 0.053% | 0.000% |
| LIDC-IDRI-0002_inst0066 | 0.024% | 0.000% |
| LIDC-IDRI-0002_inst0109 | 0.050% | 0.001% |
| **Mean** | **0.038%** | **0.0002%** |

(Updated 2026-08-21 — see §7: numbers here shifted slightly after the
crop-restore fix, since mismatch is now computed over correctly-placed
masks rather than stretched ones. Original 2026-08-14 figures: INT8 mean
0.062%, FP16 mean 0.0004%.)

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

**Post-fix note (2026-08-21, see §7):** the numbers in this section are
unchanged by the crop-restore fix — expected, since the identical fix was
applied to both this pipeline and the ground-truth generation script it's
compared against, so their agreement stays just as high, now because both
sides are correctly geometrically aligned rather than because both shared
the same placement bug. Read as a self-consistency measure, these figures
were never false; what changed is that "the mask lands in the right
place" is now something this comparison would actually have caught, where
before it couldn't have.

## 5. Native ONNX Runtime Latency Baseline (2026-08-21)

PRD Section 4 defines an "On-Device Overhead Multiplier" — browser
(`onnxruntime-web`) inference time divided by native `onnxruntime`
inference time for the same model, target < 3x — specifically to
decouple "running in a browser" overhead from "this model is just
compute-heavy." Section 3 above only ever measured the browser side; this
section supplies the missing native-side number
(`ai-pipeline/quantization/benchmark_native_latency.py`). Computing the
actual multiplier still requires a *real-browser* infer number (Section 3
was measured under Node, not a browser — see its own caveats); Section 6
below adds that real-browser number and computes the multiplier against
this section's data.

**Methodology:** same single input slice Section 3 used
(`LIDC-IDRI-0001_inst0034`, entry 0 of the ground-truth manifest), same
iteration count (5) and same "mean of wall-clock ms, no separate warmup
excluded from the mean" approach, so the two numbers are directly
comparable rather than incidentally similar. Only the forward pass
(`session.run()`) is timed — matching what Section 3 calls "infer".
Postprocess (argmax + NN upscale) isn't reimplemented in Python here since
it's TypeScript-only in this project and Section 3 already found it
negligible (1-3ms), so its absence from this measurement doesn't affect
comparability.

**Environment:** same MacBook M1 hardware as Section 3, but native Python
`onnxruntime` 1.23.2 (via `viewer/src/workers/inference-worker/.venv`),
`CPUExecutionProvider` — **not** the `onnxruntime-web` 1.27.0 resolved in
Section 3. This is a different package and a different (though close)
version; the eventual multiplier will carry a small amount of
version-skew noise alongside the browser-vs-native difference it's meant
to isolate. Flagged here, not treated as negligible without checking.

**Results (two separate isolated runs, shown both to be transparent about
run-to-run noise — consistent with Section 3's own finding that this kind
of benchmark is noisy):**

| Run | Model | mean infer (ms) | per-iteration samples (ms) |
| --- | --- | --- | --- |
| 1 | FP32 | 597.6 | 778.0, 520.6, 668.5, 505.0, 515.9 |
| 1 | INT8 | 208.3 | 198.0, 330.8, 173.8, 170.1, 168.7 |
| 1 | FP16 | 487.2 | 546.1, 508.6, 478.9, 480.4, 421.7 |
| 2 | FP32 | 486.5 | 465.4, 465.2, 471.2, 562.7, 467.9 |
| 2 | INT8 | 155.4 | 164.3, 158.8, 145.4, 147.1, 161.3 |
| 2 | FP16 | 561.6 | 465.8, 447.5, 441.1, 792.0, 661.6 |

Preprocess (not part of the infer figure above): 62.2ms (run 1), 20.3ms
(run 2) — noisy in the same way the infer numbers are, not investigated
further here since it isn't part of the multiplier's definition.

**What this shows:**
- **INT8 is fastest in both runs** (155-208ms) — qualitatively consistent
  with Section 3's browser-side finding that INT8 came out fastest there
  too, despite having far more graph nodes (190 added quantize/dequantize
  nodes per Section 3's graph inspection).
- **FP16 is not reliably faster than FP32 here, and is noisier** (its run-2
  samples span 441-792ms) — consistent with Section 3's explanation that
  FP16 conversion on this backend only adds data-conversion (Cast) nodes
  around unchanged FP32-precision compute, with no native FP16 execution
  path on CPU. The same qualitative pattern showing up independently on
  the native side (different runtime, different language) is a second,
  independent data point for that explanation rather than a WASM-specific
  quirk.
- FP32 mean infer: 481-598ms across the two runs.

**Still open (resolved in Section 6):** the actual overhead multiplier
(browser / native) isn't computed in this section — it needed a
real-browser (not Node) infer number for the numerator, which didn't
exist yet at the time this section was written. Section 6 below adds that
number and computes it.

## 6. Real-Browser Latency Benchmark (2026-08-21)

Section 3's latency numbers were all measured under Node (vitest), not a
real browser — flagged there as an open gap. This section closes it via a
new standalone harness: `bench/` + `e2e/latency-browser.spec.ts` (own
`vite.config.ts`/`playwright.config.ts`, scoped entirely inside
`inference-worker/` rather than the Shell's shared e2e suite, since this
only needs the Inference Worker itself — see that spec file's module doc
comment for the full rationale). `bench.ts` calls the same
`LungmaskAdapter`/`ort.InferenceSession` directly on the page's main
thread — same as Section 3's `measure()` — rather than through the
Worker's postMessage protocol, so this measures the same thing
(preprocess/infer/postprocess wall-clock time) without also mixing in
message-passing overhead. Same methodology as Section 3 throughout: same
single slice (`LIDC-IDRI-0001_inst0034`), same 5 iterations, same "mean of
wall-clock ms, no separate warmup excluded from the mean."

**Environment:** MacBook M1 (same hardware as Section 3), real Chromium
(Playwright's bundled `chrome-headless-shell`, headless), `onnxruntime-web`
1.27.0 (same resolved version Section 3 used) — this time actually
running in a browser JS engine, not Node's.

**Two real bugs found and fixed getting this running** (both in
`inference-worker/`'s own scope, not benchmark-harness quirks):

1. **FP32's external-data loading was broken in the browser, not just
   Node.** Section 1 already knew Node needed a manual `readFileSync`
   workaround for the FP32 model's external-data file
   (`lungmask_r231.onnx.data`); whether a real browser needed the same
   workaround was open. It does — worse, `worker.ts`'s `init` handler had
   no external-data handling at all, so **loading the real FP32 model in
   the actual production Inference Worker was silently broken in every
   browser**, never caught because the Shell's own e2e tests only ever
   exercised a dummy no-external-data model
   (`viewer/tests/fixtures/dummy-lungmask.onnx`). Fixed in `worker.ts`:
   `InitMessage` gained an optional `externalDataPath`; when set, the
   worker fetches those bytes itself and passes them via
   `ort.InferenceSession.create()`'s `externalData` option, rather than
   relying on `onnxruntime-web` to resolve a same-directory URL on its own
   (it doesn't — the failure was `Module.MountedFiles is not available`,
   an Emscripten Node-mount mechanism, not a browser fetch).
2. **Playwright's `page.route().fulfill()` can't serve files over 100MB.**
   Routing the 116MB `.onnx.data` file through Playwright crashed the
   whole browser process before the page even loaded
   (`Too large read data is pending: capacity=104857600 ... Connection
   closed, not enough capacity` — Chromium's CDP pipe has a hard 100MB
   cap). Not a `worker.ts` bug — a benchmark-harness-only issue, fixed by
   serving that one file through Vite's own `/@fs/` static-file path
   instead (a real HTTP response, never touching the CDP pipe). See
   `vite.config.ts`'s `server.fs.allow` comment.

**Results (isolated run):**

| Model | Preprocess (ms) | Infer (ms) | Postprocess (ms) | Budget: infer+postprocess (ms) | Under 500ms? |
| --- | --- | --- | --- | --- | --- |
| FP32 | 69.4 | 2957.0 | 2.4 | 2959.4 | No |
| INT8 | 59.8 | 2886.0 | 3.9 | 2889.9 | No |
| FP16 | 61.0 | 2891.8 | 2.4 | 2894.2 | No |

**This is a genuinely surprising result, flagged rather than smoothed
over:** every model is roughly 3.5-4x slower here than the corresponding
Node number in Section 3 (FP32 792ms, INT8 723ms, FP16 813ms) — expected
directionally (Node's WASM environment isn't the same as a browser's), but
not by this much. More strikingly, **INT8's advantage disappears**: Section
3 and the native-baseline benchmark both found INT8 clearly fastest; here
all three models cluster within ~70ms of each other. That specific pattern
change (not just "everything got slower") suggests execution is going
through a materially different path here, not just a slower version of the
same one.

**Leading (unconfirmed) hypothesis:** `onnxruntime-web`'s multi-threaded
WASM backend needs `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`
headers (for `SharedArrayBuffer`) to use real threads; this benchmark's
minimal `vite.config.ts` sets neither. If the threaded WASM binary silently
falls back to a slower single-threaded path without erroring, that could
explain both the across-the-board slowdown and INT8 losing its edge
(INT8's speed advantage over FP32/FP16, per Section 3's graph-node
analysis, comes from doing genuinely less/cheaper compute per thread — a
single-thread bottleneck could plausibly flatten that gap). **Not verified
— no COOP/COEP experiment has actually been run yet.** Tracked as an open
follow-up, not resolved here.

**Still open:** the actual On-Device Overhead Multiplier (browser ÷
native, PRD Section 4) can now be computed using this section's numbers
against `ai-pipeline/quantization/benchmark_native_latency.py`'s (native:
FP32 481-598ms, INT8 155-208ms, FP16 454-562ms across two runs) — every
model is well over the <3x target using these browser numbers (FP32
~5-6x, INT8 ~14-19x, FP16 ~5-6x) — but given the COOP/COEP question above
is unresolved, this multiplier may currently be measuring "browser +
possibly-degraded threading" rather than "browser" cleanly. Worth
re-computing once that's investigated rather than treating today's ratio
as final.

## 7. Postprocess Crop-Restore Bug: Found and Fixed (2026-08-21)

**Found via real visual inspection, not automated testing:** after wiring
the real model into the Shell UI, the mask overlay appeared oversized and
displaced relative to actual lung/rib anatomy — extending past where the
body outline actually is.

**Root cause:** `preprocess.ts`'s `cropAndResize()` crops each slice to
the body-mask's bounding box *before* resizing to the model's native
256x256 (matching the real `lungmask.utils.preprocess`, see
`ai-pipeline/conversion/adapters/lungmask/MODEL_SPEC.md`) — the model's
256x256 output therefore only ever describes that cropped sub-region of
the slice, never the full frame. `postprocess.ts`'s
`lungmaskPostprocess()` didn't know about that crop at all: it upscaled
the 256x256 argmax mask directly to the *full* original slice resolution,
stretching a smaller-than-full-frame region to fill the entire frame —
both over-magnifying and mis-positioning the mask (no offset applied
either). This is a REQ-C01/REQ-A17 compliance bug, not a cosmetic one —
the mask contract requires 1:1 alignment with the original volume.

**Why nothing in Sections 1/2/4 above caught this:** both Python
fixture-generation scripts (`scripts/export_reference_fixtures.py`, used
by §1/§2, and `scripts/export_ground_truth_masks.py`, used by §4) had the
*identical* bug — a naive `ndimage.zoom` straight to full resolution,
either discarding or never computing the crop bounding box. The browser
pipeline was being validated against Python references that shared its
exact mistake, so they agreed with each other while both were wrong
relative to true anatomical placement — a textbook case of a reference
implementation and the thing being tested sharing one bug.

**Fix:** `SegmentationAdapter`'s `preprocess()`/`postprocess()` now
explicitly thread the crop bounding box between them as an ordinary
return value/parameter, rather than storing it as mutable state on the
adapter instance. Instance state was considered and rejected: REQ-A11
(multi-slice batched inference) is an actual planned P1 item, and a
single mutable bbox field would get silently clobbered across slices the
moment batching preprocesses several slices before postprocessing any of
them. `postprocess()` now upscales the native 256x256 argmax to the
*crop's own size* first, then pastes that into a zero-initialized
(background) full-resolution canvas at the crop's original offset. Both
Python fixture-generation scripts got the identical fix —
`export_ground_truth_masks.py`'s fix was one line once found: it was
discarding a bounding box `lungmask.utils.preprocess` already computed and
returned (`preprocessed, _ = lungmask_preprocess(...)`).

**Re-verification after the fix:**
- A new regression test (`postprocess.test.ts`, "restores a non-full-frame
  crop at its original offset/size, background elsewhere") directly
  asserts pixels outside the crop bbox are background and pixels inside
  are placed at the exact expected offset — this specific class of bug
  can't pass silently again.
- Section 2's per-slice mismatch numbers shifted slightly (mismatch is
  now computed over correctly-placed masks rather than stretched ones):
  INT8 mean 0.062% → 0.038%, FP16 mean 0.0004% → 0.0002%.
- Section 4's Dice/IoU numbers are **unchanged** (FP32 1.0000/1.0000,
  INT8 ~0.9985-0.9991, FP16 ~0.9998-1.0000) — expected, not a bug in this
  re-verification: the identical fix was applied to both the pipeline and
  the ground-truth reference it's compared against, so their agreement
  stays just as high, now because both sides are correctly geometrically
  aligned rather than because both shared the same placement bug. The old
  1.0000 figures were never false as *self-consistency* claims — what
  changed is that this comparison would now actually catch a placement
  regression, where before it structurally couldn't have.
- Full test suite (36/36) passing with regenerated fixtures.
- Visually re-confirmed in a real browser (Shell + real INT8 model + real
  LIDC-IDRI patient CT): the mask overlay now sits correctly within the
  body outline instead of spilling past it.
