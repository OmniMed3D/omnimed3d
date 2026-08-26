# LIDC-IDRI demo CT series

Three real, de-identified patient CT series from the LIDC-IDRI
collection, one per `LIDC-IDRI-000{1,2,3}/` subdirectory:

| Series | Slices | Size |
| --- | --- | --- |
| `LIDC-IDRI-0001/` | 133 | ~68MB |
| `LIDC-IDRI-0002/` | 261 | ~132MB |
| `LIDC-IDRI-0003/` | 140 | ~71MB |

(~271MB total). Tracked via [Git LFS](../../.gitattributes) rather than
a plain blob, so it doesn't permanently bloat every clone's `.git`
history the way a normal commit of that much binary data would.

Lives at the repo root (not under `engine/`) because it's a shared,
cross-module resource, not engine-only — mirroring `dicom-parser/`'s own
"shared, one owner" precedent (see `.github/CODEOWNERS`):

- **engine/viewer**: the "Load Demo CT" toggle
  (`viewer/src/shell/demoCtControls.ts`) loads one of these three series
  (one button each) so the volume renderer can be shown off with real
  patient-scale data, which a synthetic or single-slice fixture (see
  `engine/tests/fixtures/CT_small.dcm`) can't do. Synced into the
  viewer's servable `public/` tree via `npm run sync-demo-ct`
  (`viewer/scripts/sync-demo-ct.mjs`), not committed there a second time.
- **ai-pipeline**: `docs/verification/inference-worker.md` already
  references specific instances from `LIDC-IDRI-0001`
  (`LIDC-IDRI-0001_inst00xx`) for inference-worker verification, and
  `ai-pipeline/quantization/`'s own calibration pool draws from the same
  LIDC-IDRI collection (see `ai-pipeline/quantization/README.md`) --
  these committed copies are available to reuse there too instead of
  maintaining separate local-only downloads for the same patients.

Only the CT series was kept from each patient's original download — a
separate secondary study (Digital X-Ray/DX modality for 0001 and 0002,
a small 5-image study for 0003) also exists for each patient in the
source collection but isn't part of the CT volume and isn't included
here. Disambiguated by reading each candidate series' DICOM Modality tag
(0008,0060) directly rather than assuming folder order or slice count
alone (0002's non-CT study happens to be a single file, easy to
mistake for a truncated series otherwise).

## Getting this data

The `.dcm` files here are real content, not placeholders — but Git LFS
only delivers that content automatically if `git-lfs` is installed
*before* you clone/pull. Without it, `git` still succeeds, silently
leaving small text pointer files (~130 bytes each) in place of the real
~516KB-per-slice DICOM data. If you already cloned without it:

```zsh
# Install once per machine: https://git-lfs.com
git lfs install
git lfs pull
```

See [`viewer/README.md`](../../viewer/README.md#building-and-testing)
for what to run next to actually use this data (`npm run sync-demo-ct`).

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
