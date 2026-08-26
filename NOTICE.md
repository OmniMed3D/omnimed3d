# NOTICE

This document specifies the copyright notices and license information for third-party open-source software, libraries, and artificial intelligence (AI) models used and modified in the OmniMed3D project.

OmniMed3D is grateful for the contributions of the open-source projects listed below and strictly complies with the license terms of each work.

---

## 1. Engine & Viewer (C++ / Web / WASM)

The following libraries and toolchains were used to build the rendering engine core and the web frontend environment.

| Software / Library | License | Copyright / Source |
| :--- | :--- | :--- |
| **GLM** | MIT | Copyright (c) 2005 - G-Truc Creation<br>[https://github.com/g-truc/glm](https://github.com/g-truc/glm)<br>Used by the WebGPU rendering backend (`engine/src/rhi/backends/webgpu/`) for camera/projection math; fetched at build time (`FetchContent`, pinned to `1.0.1`), compiled into the engine's WASM output. |
| **Emscripten** | MIT / NCSA | Copyright (c) Emscripten authors<br>[https://github.com/emscripten-core/emscripten](https://github.com/emscripten-core/emscripten)<br>Compiler toolchain used to build the engine's WebGPU/WASM target; its runtime support code is linked into the resulting `.wasm` output. |

---

## 2. AI & Infrastructure (Python / Docker)

The following open-source packages were used to build the segmentation inference and backend infrastructure.

| Software / Library | License | Copyright / Source |
| :--- | :--- | :--- |
| **ONNX Runtime Web** | MIT | Copyright (c) Microsoft Corporation<br>[https://github.com/microsoft/onnxruntime](https://github.com/microsoft/onnxruntime)<br>Runs AI segmentation inference in-browser (Inference Worker, `onnxruntime-web` npm package) — the only third-party runtime dependency actually shipped to end users. |

---

## 3. Pre-trained AI Models

The medical image analysis (segmentation) features of this project are fine-tuned from pre-trained open-weight models. The license and source of the original models are as follows.

| Model Name | License | Copyright / Source |
| :--- | :--- | :--- |
| **lungmask R231** (U-Net, lung segmentation) | Apache-2.0 | Hofmanninger et al.<br>[https://github.com/JoHof/lungmask](https://github.com/JoHof/lungmask)<br>Pretrained weights (`unet_r231-d5d2fc3d.pth`) converted to ONNX and quantized (PTQ, INT8/FP16) for in-browser inference — see `ai-pipeline/conversion/adapters/lungmask/` and `ai-pipeline/quantization/`. Not fine-tuned; used as-is. |

---

## 4. Datasets

Real medical imaging data used for demo/testing purposes is licensed and attributed as follows.

| Dataset | License | Copyright / Source |
| :--- | :--- | :--- |
| **LIDC-IDRI** (`test-data/lidc_idri/`) | CC BY 3.0 | Armato SG 3rd, McLennan G, Bidaut L, McNitt-Gray MF, Meyer CR, Reeves AP, Zhao B, Aberle DR, Henschke CI, Hoffman EA, Kazerooni EA, MacMahon H, van Beek EJR, Yankelevitz D, et al. (2015). Data From LIDC-IDRI. The Cancer Imaging Archive.<br>[https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX](https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX)<br>See `test-data/lidc_idri/README.md` for the full required citations and where in the product this data is used (the "Lung1"/"Lung2" demo buttons). |
| **UPENN-GBM** (`test-data/upenn_gbm/`) | CC BY 4.0 | Bakas S, Sako C, Akbari H, et al. (2021). Multi-parametric magnetic resonance imaging (mpMRI) scans for de novo Glioblastoma (GBM) patients from the University of Pennsylvania Health System (UPENN-GBM) (Version 2) [Data set]. The Cancer Imaging Archive.<br>[https://doi.org/10.7937/TCIA.709X-DN49](https://doi.org/10.7937/TCIA.709X-DN49)<br>See `test-data/upenn_gbm/README.md` for the full required citations (this is CC BY 4.0, not the 3.0 that LIDC-IDRI uses) and where in the product this data is used (the "Brain" demo button). |

---

If you discover any omissions in this notice or potential license violations, please report them to the project maintainers via an Issue.
