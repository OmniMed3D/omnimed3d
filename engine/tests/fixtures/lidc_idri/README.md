# LIDC-IDRI demo CT series

`LIDC-IDRI-0001/` is one real, de-identified patient CT series (133
axial slices, 512×512) from the LIDC-IDRI collection, used as a demo
dataset for the volume renderer — real patient-scale data shows off the
engine in a way a synthetic or single-slice fixture (see
`engine/tests/fixtures/CT_small.dcm`) can't. Tracked via [Git
LFS](../../../../.gitattributes) rather than a plain blob, so it doesn't
permanently bloat every clone's `.git` history the way a normal commit
of ~68MB of binary data would.

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
