# ADR-0001: `SegmentationAdapter<TMeta>` protocol shape

| Field  | Value      |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-08-21 |

## Context

PRD §5.3.1/6.1 establishes that a model adapter has `preprocess`/`infer`/
`postprocess` stages, but leaves the concrete TypeScript signature
undecided — an earlier external discussion (`docs/ai-track-decisions.md`,
"미해결/충돌 #2") explicitly deferred this to Epic 4 (inference runtime),
when the Lungmask adapter would exist as a real implementation to design
against rather than a hypothetical.

That implementation surfaced a real bug (2026-08-21, "postprocess
crop-restore 버그"): `preprocess()`'s `cropAndResize()` crops each slice to
a body-mask bounding box before resizing to the model's fixed input size,
but the first version of `postprocess()` had no way to know that box — it
upscaled the model's 256×256 output directly to the full original slice,
producing an anatomically wrong (over-scaled, mis-positioned) mask. The
bug was invisible to Dice/IoU verification because the ground-truth
generation script (`ai-pipeline/quantization/scripts/export_ground_truth_masks.py`)
had the identical bug, so the pipeline was compared against an equally
wrong reference.

## Decision

```ts
export interface PreprocessResult<TMeta> {
  tensor: ort.Tensor;
  meta: TMeta;
}

export interface SegmentationAdapter<TMeta = unknown> {
  readonly modelPath: string;
  readonly numClasses: number;

  preprocess(slice: HuSlice): PreprocessResult<TMeta>;
  infer(session: ort.InferenceSession, input: ort.Tensor): Promise<ort.Tensor>;
  postprocess(logits: ort.Tensor, meta: TMeta, originalShape: { width: number; height: number }): Uint8Array;
}
```

Per-slice metadata a model's `preprocess()` step needs `postprocess()` to
see (e.g. Lungmask's crop bounding box) is threaded explicitly through
`PreprocessResult.meta` and `postprocess()`'s `meta` parameter — never
stored as mutable state on the adapter instance.

## Consequences

- `pipeline.ts`'s `runBatch()` (ADR-0002) can call `preprocess()` for
  several slices before `postprocess()`-ing any of them, each slice's
  `meta` tracked independently in a parallel array — a mutable-instance-
  state design would silently clobber one slice's metadata with another's
  the moment more than one slice is in flight per adapter instance, which
  batching does by construction.
- Any future adapter (REQ-A14 multi-class segmentation, or a second organ
  model per PRD 10.2's MONAI spleen candidate) must conform to this same
  generic signature — `TMeta` lets each adapter define whatever shape of
  side-channel data it needs (a crop box, a resampling grid, ...) without
  changing the interface itself.
- `organ_taxonomy.json`/`remap_utils.py`/`registry.json` (local-class-index
  → project-wide organ ID mapping, adapter registry) remain deliberately
  unimplemented — with exactly one adapter (Lungmask) in the codebase,
  there is no consumer for either yet (YAGNI), reconfirmed as of this ADR.
  Revisit when a second adapter is actually added.

## Alternatives Considered

- **Mutable adapter-instance state** (a field set by `preprocess()`, read
  by the next `postprocess()` call). Simpler diff at the time, but
  silently assumes `preprocess()` and `postprocess()` are always called in
  strict alternation for a single slice — false once REQ-A11 (multi-slice
  batch inference, already roadmapped when this was decided, and
  implemented shortly after in ADR-0002) needs several `preprocess()`
  calls queued before any `postprocess()` call. Rejected specifically
  because of that near-term conflict, not just in the abstract.
- **A single `run(slice)` method instead of three stages.** Would hide the
  crop-restore bug class entirely by construction (no meta to lose), but
  forecloses batching the `infer()` step across slices (ADR-0002's whole
  point) without either an adapter-specific batch API or re-deriving the
  three-stage split later anyway. Rejected as strictly less flexible for
  no simplicity gain once batching was already known to be coming.
