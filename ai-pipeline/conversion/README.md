# conversion

Epic 1 / REQ-A01 — one-time (per model version) export of the pretrained
lungmask R231 segmentation model from PyTorch to ONNX, plus a parity
check confirming the export didn't change the model's behavior. Output
feeds [`../quantization/`](../quantization/README.md)'s PTQ stage
(Epic 2).

## `adapters/lungmask/`

Nested under `adapters/` rather than flat at this directory's top level
so a second organ model (PRD §10.2's MONAI spleen-segmentation candidate)
can be added later as a sibling directory without restructuring — only
lungmask exists today, and nothing beyond this one adapter is built out
(YAGNI).

| File | What it does |
| --- | --- |
| `convert_to_onnx.py` | Loads pretrained R231 weights via the `lungmask` package (torch.hub download/cache), exports the raw PyTorch `nn.Module` to ONNX — `[1, 3, 256, 256]` logits, opset 18 (see `MODEL_SPEC.md` for why that specific opset is required). |
| `check_parity.py` | Compares PyTorch vs. ONNX Runtime output on a fixed-seed synthetic input. Asserts identical argmax class predictions (the actual segmentation output) and logit closeness within an empirically-set tolerance — the naive `1e-5` default does not hold for this model; see the script's own doc comment for the observed max diff and why it's expected, not a bug. |
| `MODEL_SPEC.md` | The model's full I/O spec: shape/dtype, the exact 4-step preprocessing pipeline (crop-to-bodymask, *then* resize — not a plain resize of the full slice), and what the browser-side adapter's postprocess stage (built in Epic 4, [`viewer/src/workers/inference-worker/`](../../viewer/src/workers/inference-worker/README.md)) still has to do that isn't baked into this ONNX export. |

## Running it

```sh
cd ai-pipeline/conversion/adapters/lungmask
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python convert_to_onnx.py --output lungmask_r231.onnx
python check_parity.py --onnx-path lungmask_r231.onnx
```

Format with `black .` before committing (`CONTRIBUTING.md` #3.2). The
`.onnx`/`.onnx.data` output is gitignored (regenerated, not committed) —
see the repo root `.gitignore`'s "Generated model artifacts" section for
the specific whitelisted exceptions served to the browser.

## What's not here yet

- A held-out, non-synthetic parity check — `check_parity.py` uses a
  fixed-seed `torch.randn` input by design (no dataset-download logic
  belongs in this script, per its own doc comment). Substituting a real
  CT slice is possible now that the Step 0 dataset question is resolved
  (LIDC-IDRI, CC BY 3.0), but hasn't been done.
- A second model adapter / REQ-A14 multi-class segmentation — see the
  note on `adapters/lungmask/`'s nesting above.
