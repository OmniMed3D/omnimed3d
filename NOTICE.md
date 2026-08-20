# NOTICE

This document specifies the copyright notices and license information for third-party open-source software, libraries, and artificial intelligence (AI) models used and modified in the OmniMed3D project.

OmniMed3D is grateful for the contributions of the open-source projects listed below and strictly complies with the license terms of each work.

---

## 1. Engine & Viewer (C++ / Web / WASM)

The following libraries and toolchains were used to build the rendering engine core and the web frontend environment.

| Software / Library | License | Copyright / Source |
| :--- | :--- | :--- |
<!-- | **Vulkan Headers** | Apache-2.0 | Copyright (c) The Khronos Group Inc.<br>[https://github.com/KhronosGroup/Vulkan-Headers](https://github.com/KhronosGroup/Vulkan-Headers) |
| **Emscripten** | MIT / NCSA | Copyright (c) Emscripten authors<br>[https://github.com/emscripten-core/emscripten](https://github.com/emscripten-core/emscripten) |
| **WebGPU C++ Headers** | BSD-3-Clause | Copyright (c) WebGPU Native authors<br>[https://github.com/webgpu-native/webgpu-headers](https://github.com/webgpu-native/webgpu-headers) |
| **GLM** | MIT | Copyright (c) 2005 - G-Truc Creation<br>[https://github.com/g-truc/glm](https://github.com/g-truc/glm) | -->
| **[Additional library name]** | [License name] | [Copyright holder and link] |

---

## 2. AI & Infrastructure (Python / Docker)

The following open-source packages were used to build the segmentation inference and backend infrastructure.

| Software / Library | License | Copyright / Source |
| :--- | :--- | :--- |
<!-- | **PyTorch** | BSD-3-Clause | Copyright (c) PyTorch Foundation<br>[https://github.com/pytorch/pytorch](https://github.com/pytorch/pytorch) |
| **FastAPI** | MIT | Copyright (c) 2018 Sebastián Ramírez<br>[https://github.com/tiangolo/fastapi](https://github.com/tiangolo/fastapi) | -->
| **[Additional library name]** | [License name] | [Copyright holder and link] |

---

## 3. Pre-trained AI Models

The medical image analysis (segmentation) features of this project are fine-tuned from pre-trained open-weight models. The license and source of the original models are as follows.

| Model Name | License | Copyright / Source |
| :--- | :--- | :--- |
<!-- | **[Base model name used, e.g., Meta SAM]** | [License, e.g., Apache-2.0] | [Original model repository or paper link] |
| **[Additional fine-tuning dataset name]** | [Dataset license] | [Dataset source link] | -->

---

## 4. Datasets

Real medical imaging data used for demo/testing purposes is licensed and attributed as follows.

| Dataset | License | Copyright / Source |
| :--- | :--- | :--- |
| **LIDC-IDRI** (`test-data/lidc_idri/LIDC-IDRI-0001/`) | CC BY 3.0 | Armato SG 3rd, McLennan G, Bidaut L, McNitt-Gray MF, Meyer CR, Reeves AP, Zhao B, Aberle DR, Henschke CI, Hoffman EA, Kazerooni EA, MacMahon H, van Beek EJR, Yankelevitz D, et al. (2015). Data From LIDC-IDRI. The Cancer Imaging Archive.<br>[https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX](https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX)<br>See `test-data/lidc_idri/README.md` for the full required citations (Data Citation, Publication Citation, and Required Acknowledgement) and where in the product this data is used. |

---

If you discover any omissions in this notice or potential license violations, please report them to the project maintainers via an Issue.
