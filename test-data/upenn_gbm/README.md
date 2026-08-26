# UPENN-GBM demo brain MR series

One real, de-identified patient brain MR series from the UPENN-GBM
collection, backing the third "Load Demo CT" button (labeled "Brain") --
`UPENN-GBM-00001/`, series 77712/59209 ("T2 SAG SPACE", Siemens TrioTim
3T, routine brain protocol): 192 slices, ~31MB.

(Briefly swapped to series 33106/17693, a clean axial T2-FLAIR
acquisition, on 2026-08-27, then reverted back to 77712/59209 the same
day per user preference -- no lasting effect beyond this note.)

Tracked via [Git LFS](../../.gitattributes) rather than a plain blob,
same reasoning as `test-data/lidc_idri/`'s own README.

Lives at the repo root (not under `engine/` or `viewer/`) for the same
"shared, cross-module resource" reason as `test-data/lidc_idri/` --
mirrors that directory's own precedent rather than introducing a new one.

- **viewer**: the "Load Demo CT" toggle
  (`viewer/src/shell/demoCtControls.ts`) loads this series for its third
  button (labeled "Brain", not "Patient 3" -- a different collection and
  modality than the other two, unlike LIDC-IDRI-0001/0002 which share
  one collection). Synced into the viewer's servable `public/` tree via
  `npm run sync-demo-ct` (`viewer/scripts/sync-demo-ct.mjs`), not
  committed there a second time.

This series is a real DICOM-load stress case, not an arbitrary choice:
it's a fully sagittal acquisition (not axial, unlike LIDC-IDRI's CT
series) with a per-slice DICOM VOI LUT window that isn't in Hounsfield
Units -- it exercises the Parse Worker's oblique/non-axial resampling
path, the "From File" window/level preset, and the MPR (Axial/Sagittal/
Coronal) + Native view modes end to end, not just axial CT loading.

Only this one series (of the several the source patient folder contains
-- other study/series subfolders hold different sequences, e.g. T1/T1GD/
FLAIR, and at least one non-spatial time-series-like acquisition) was
kept, chosen for being both non-axial and a manageable size.

## Getting this data

Same as `test-data/lidc_idri/README.md`'s own instructions -- Git LFS
must be installed *before* cloning/pulling, or these `.dcm` files stay
as small text pointer stubs instead of the real DICOM content:

```zsh
git lfs install
git lfs pull
```

See [`viewer/README.md`](../../viewer/README.md#building-and-testing)
for what to run next (`npm run sync-demo-ct`).

## License and attribution (CC BY 4.0)

Source: [UPENN-GBM](https://www.cancerimagingarchive.net/collection/upenn-gbm/)
via [The Cancer Imaging Archive](https://www.cancerimagingarchive.net/)
(TCIA), licensed under [Creative Commons Attribution 4.0 International
(CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/) -- note this
is 4.0, not the 3.0 that `test-data/lidc_idri/`'s LIDC-IDRI collection
uses; the two directories are licensed independently, not both covered
by one blanket license. Per TCIA's data usage policy, the following
citations are required wherever this data is used:

**Data Citation:**
Bakas, S., Sako, C., Akbari, H., Bilello, M., Sotiras, A., Shukla, G.,
Rudie, J. D., Flores Santamaria, N., Fathi Kazerooni, A., Pati, S.,
Rathore, S., Mamourian, E., Ha, S. M., Parker, W., Doshi, J., Baid, U.,
Bergman, M., Binder, Z. A., Verma, R., et al. (2021). Multi-parametric
magnetic resonance imaging (mpMRI) scans for de novo Glioblastoma (GBM)
patients from the University of Pennsylvania Health System (UPENN-GBM)
(Version 2) [Data set]. The Cancer Imaging Archive.
https://doi.org/10.7937/TCIA.709X-DN49

**Publication Citation:**
Bakas, S., Sako, C., Akbari, H., Bilello, M., Sotiras, A., Shukla, G.,
Rudie, J. D., Flores Santamaria, N., Fathi Kazerooni, A., Pati, S.,
Rathore, S., Mamourian, E., Ha, S. M., Parker, W., Doshi, J., Baid, U.,
Bergman, M., Binder, Z. A., Verma, R., Lustig, R., Desai, A. S., Bagley,
S. J., Mourelatos, Z., Morrissette, J., Watt, C. D., Brem, S., Wolf, R.
L., Melhem, E. R., Nasrallah, M. P., Mohan, S., O'Rourke, D. M.,
Davatzikos, C. (2022). The University of Pennsylvania glioblastoma
(UPenn-GBM) cohort: advanced MRI, clinical, genomics, & radiomics.
Scientific Data, 9(1). https://doi.org/10.1038/s41597-022-01560-7

**Acknowledgement:**
Funding support for the UPENN-GBM collection included NIH awards under
NINDS, NCI, and NCATS, and the Institute for Translational Medicine and
Therapeutics at the University of Pennsylvania (see the publication
citation above for full funding detail).
