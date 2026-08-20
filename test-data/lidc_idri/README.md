# LIDC-IDRI demo CT series

`LIDC-IDRI-0001/` is one real, de-identified patient CT series (133
axial slices, 512×512) from the LIDC-IDRI collection. Tracked via [Git
LFS](../../.gitattributes) rather than a plain blob, so it doesn't
permanently bloat every clone's `.git` history the way a normal commit
of ~68MB of binary data would.

Lives at the repo root (not under `engine/`) because it's a shared,
cross-module resource, not engine-only — mirroring `dicom-parser/`'s own
"shared, one owner" precedent (see `.github/CODEOWNERS`):

- **engine/viewer**: the "Load Demo CT" button
  (`viewer/src/shell/demoCtControls.ts`) loads this series so the volume
  renderer can be shown off with real patient-scale data, which a
  synthetic or single-slice fixture (see
  `engine/tests/fixtures/CT_small.dcm`) can't do. Synced into the
  viewer's servable `public/` tree via `npm run sync-demo-ct`
  (`viewer/scripts/sync-demo-ct.mjs`), not committed there a second time.
- **ai-pipeline**: `docs/verification/inference-worker.md` already
  references specific instances from this same patient
  (`LIDC-IDRI-0001_inst00xx`) for inference-worker verification, and
  `ai-pipeline/quantization/`'s own calibration pool draws from the same
  LIDC-IDRI collection (see `ai-pipeline/quantization/README.md`) --
  this committed copy is available to reuse there too instead of
  maintaining a separate local-only download for the same patient.

Only the CT series was kept from this patient's original download — a
separate 2-image Digital X-Ray (DX modality) study also exists for this
patient in the source collection but isn't part of the CT volume and
isn't included here.

## License and attribution (CC BY 3.0)

Source: [LIDC-IDRI](https://www.cancerimagingarchive.net/collection/lidc-idri/)
via [The Cancer Imaging Archive](https://www.cancerimagingarchive.net/)
(TCIA), licensed under [Creative Commons Attribution 3.0 Unported (CC BY
3.0)](https://creativecommons.org/licenses/by/3.0/). Per TCIA's data
usage policy, the following citations are required wherever this data
is used:

**Data Citation:**
Armato SG 3rd, McLennan G, Bidaut L, McNitt-Gray MF, Meyer CR, Reeves AP,
Zhao B, Aberle DR, Henschke CI, Hoffman EA, Kazerooni EA, MacMahon H, van
Beek EJR, Yankelevitz D, et al. (2015). Data From LIDC-IDRI. The Cancer
Imaging Archive. https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX

**Publication Citation:**
Armato SG 3rd, McLennan G, Bidaut L, McNitt-Gray MF, Meyer CR, Reeves AP,
Zhao B, Aberle DR, Henschke CI, Hoffman EA, Kazerooni EA, MacMahon H, van
Beek EJR, Yankelevitz D, et al. (2011). The Lung Image Database
Consortium (LIDC) and Image Database Resource Initiative (IDRI): A
completed reference database of lung nodules on CT scans. Medical
Physics, 38(2), 915-931. https://doi.org/10.1118/1.3528204

**Required Acknowledgement:**
"The authors acknowledge the National Cancer Institute and the
Foundation for the National Institutes of Health, and their critical
role in the creation of the free publicly available LIDC/IDRI Database
used in this study."
