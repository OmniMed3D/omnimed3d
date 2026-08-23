# Quantization (Epic 2 / REQ-A02)

PTQ (Post-Training Quantization) of the lungmask R231 ONNX model produced by
`../conversion/adapters/lungmask/convert_to_onnx.py`. Two independent
paths: INT8 (static, calibration-based) and FP16 (no calibration needed).

## `calibration_data/`

Gitignored — never commit raw CT data here. INT8 static quantization needs
a small set of representative real inputs to calibrate activation ranges;
synthetic random tensors (used for Epic 1's export parity check) are not
representative enough.

**Source:** LIDC-IDRI (CC BY 3.0; see `docs/ai-track-decisions.md`), CT
modality series only — pulled via the NCI Imaging Data Commons portal
(https://portal.imaging.datacommons.cancer.gov/explore/filters//?collection_id=lidc_idri),
filtering Modality = Computed Tomography and excluding the
"DICOM-LIDC-IDRI-Nodules" analysis-results collection (that's SEG/SR
annotation objects, not images — a first download attempt grabbed those by
mistake; they don't contain pixel data).

**Layout:**
- `lidc_idri/` — raw bulk download, 10 patients' full CT series (~1850
  slices, 933MB). Kept as-is (not committed — gitignored) as a pool to draw
  more calibration slices from later if needed; not used directly for
  quantization.
- `selected/` — the actual calibration set used by `quantize_ptq.py`: 30
  slices (3 per patient, all 10 patients from `lidc_idri/`), picked via
  `select_calibration_data.py`. Middle 50% of each patient's series by
  `InstanceNumber`, evenly spaced — avoids apex/base slices where the full
  lung isn't visible (lungmask requires the complete lung silhouette,
  surrounded by tissue, per the model's own constraints).

To regenerate `selected/` (e.g. with a different count or after adding more
raw series to `lidc_idri/`):
```
python select_calibration_data.py --src calibration_data/lidc_idri \
    --dst calibration_data/selected --per-patient 3
```

Preprocessing (HU clip at 600, normalize by `(HU + 1024) / 1624`, resize to
256x256) happens in `quantize_ptq.py`'s CalibrationDataReader, matching
`../conversion/adapters/lungmask/MODEL_SPEC.md` — not baked into the files
in `selected/`, which stay as raw DICOM.

- `inference_fixtures/`, `ground_truth_fixtures/` — derived (not raw DICOM)
  reference fixtures generated from `selected/` by
  `../../viewer/src/workers/inference-worker/scripts/export_reference_fixtures.py`
  and `export_ground_truth_masks.py` respectively: float32 HU/preprocessed
  tensors and expected mask outputs, consumed by inference-worker's
  vitest/Playwright suites (`viewer/src/workers/inference-worker/test/`,
  `e2e/`). **Exception to "gitignored — never commit raw CT data" above:**
  a 5-stem subset (the same 5 stems in both directories) is committed via
  Git LFS so those suites can actually run in CI, same "never commit raw
  medical imaging data, except one deliberately attributed subset" pattern
  as `test-data/lidc_idri/` (see that directory's README). The remaining
  locally-regenerated slices in both directories stay gitignored as
  before. License/attribution: CC BY 3.0 via TCIA — see
  `test-data/lidc_idri/README.md`'s "License and attribution" section for
  the required citations, which apply here too (same source collection).
