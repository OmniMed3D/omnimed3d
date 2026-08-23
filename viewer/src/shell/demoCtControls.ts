/**
 * "Load Demo CT" button -- loads a real, de-identified LIDC-IDRI patient
 * CT series (133 slices, ~68MB) bundled with the viewer, without a file
 * dialog, so the volume renderer can be shown off with real patient-scale
 * data (unlike the single-slice `CT_small.dcm` test fixture). Served from
 * `/demo-ct/LIDC-IDRI-0001/` (Vite `public/`, populated by
 * `npm run sync-demo-ct` -- see `viewer/scripts/sync-demo-ct.mjs`), not
 * committed there directly: the source of truth is
 * `test-data/lidc_idri/LIDC-IDRI-0001/` (repo root, Git LFS -- a shared
 * resource, not engine/viewer-only, see its own README), and
 * `public/demo-ct/` is gitignored to avoid double-storing ~68MB.
 *
 * `loadVolumeFromBuffers`/`showLoadError` are passed in rather than
 * imported from main.ts's module scope, matching
 * filePicker.ts's setupFilePicker(loadVolumeFromFiles) and
 * inferenceControls.ts's setupInferenceControls(inferenceWorker) pattern
 * of passing in the one capability a module needs.
 *
 * License note: LIDC-IDRI is CC BY 3.0 (The Cancer Imaging Archive /
 * TCIA) -- the short status line below is a pointer, not the full
 * required attribution; the <details> disclosure this renders carries
 * the actual Data/Publication Citation + Required Acknowledgement text
 * TCIA's data usage policy requires wherever this data is used (copied
 * from test-data/lidc_idri/README.md -- kept in sync by hand, not fetched
 * at runtime).
 */

import { setGaugeLabel, setGaugeProgress } from "./buttonGauge.js";

const MANIFEST_URL = "/demo-ct/LIDC-IDRI-0001/manifest.json";
const DATA_BASE_URL = "/demo-ct/LIDC-IDRI-0001/";

const ATTRIBUTION_SUMMARY = "Demo data: LIDC-IDRI (TCIA), CC BY 3.0";

const ATTRIBUTION_DETAILS = `Data Citation: Armato SG 3rd, McLennan G, Bidaut L, McNitt-Gray MF, Meyer CR, Reeves AP, Zhao B, Aberle DR, Henschke CI, Hoffman EA, Kazerooni EA, MacMahon H, van Beek EJR, Yankelevitz D, et al. (2015). Data From LIDC-IDRI. The Cancer Imaging Archive. https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX

Publication Citation: Armato SG 3rd, McLennan G, Bidaut L, McNitt-Gray MF, Meyer CR, Reeves AP, Zhao B, Aberle DR, Henschke CI, Hoffman EA, Kazerooni EA, MacMahon H, van Beek EJR, Yankelevitz D, et al. (2011). The Lung Image Database Consortium (LIDC) and Image Database Resource Initiative (IDRI): A completed reference database of lung nodules on CT scans. Medical Physics, 38(2), 915-931. https://doi.org/10.1118/1.3528204

Required Acknowledgement: "The authors acknowledge the National Cancer Institute and the Foundation for the National Institutes of Health, and their critical role in the creation of the free publicly available LIDC/IDRI Database used in this study."`;

interface DemoCtManifest {
  files: string[];
}

export function setupDemoCtControls(
  loadVolumeFromBuffers: (buffers: ArrayBuffer[]) => Promise<string>,
  showLoadError: (message?: string) => void,
): void {
  const button = document.getElementById("load-demo-ct") as HTMLButtonElement | null;
  const status = document.getElementById("demo-ct-status");
  if (!button || !status) {
    console.error("demoCtControls: #load-demo-ct or #demo-ct-status not found in the DOM");
    return;
  }

  button.addEventListener("click", () => {
    void loadDemoCt(button, status, loadVolumeFromBuffers, showLoadError);
  });
}

async function loadDemoCt(
  button: HTMLButtonElement,
  status: HTMLElement,
  loadVolumeFromBuffers: (buffers: ArrayBuffer[]) => Promise<string>,
  showLoadError: (message?: string) => void,
): Promise<void> {
  button.disabled = true;
  setGaugeLabel(button, "Loading…");
  setGaugeProgress(button, 0);
  status.textContent = "";

  let manifest: DemoCtManifest;
  try {
    const manifestResponse = await fetch(MANIFEST_URL);
    if (!manifestResponse.ok) {
      throw new Error(`manifest fetch failed: ${manifestResponse.status}`);
    }
    manifest = (await manifestResponse.json()) as DemoCtManifest;
  } catch {
    showLoadError("Demo CT not available -- run npm run sync-demo-ct first.");
    button.disabled = false;
    setGaugeLabel(button, "Load Demo CT");
    setGaugeProgress(button, 0);
    return;
  }

  try {
    const total = manifest.files.length;
    let completed = 0;
    setGaugeLabel(button, `Loading demo CT... (0/${total})`);

    const buffers = await Promise.all(
      manifest.files.map(async (filename) => {
        const response = await fetch(DATA_BASE_URL + filename);
        if (!response.ok) {
          throw new Error(`${filename} fetch failed: ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        completed += 1;
        setGaugeLabel(button, `Loading demo CT... (${completed}/${total})`);
        setGaugeProgress(button, completed / total);
        return buffer;
      }),
    );

    await loadVolumeFromBuffers(buffers);

    button.disabled = true;
    setGaugeLabel(button, "Demo CT loaded");
    setGaugeProgress(button, 1);
    status.replaceChildren();
    status.append(document.createTextNode(ATTRIBUTION_SUMMARY + " "));
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Attribution";
    details.append(summary);
    const citation = document.createElement("p");
    citation.textContent = ATTRIBUTION_DETAILS;
    details.append(citation);
    status.append(details);
  } catch {
    showLoadError("Couldn't load the demo CT series -- one or more slice requests failed.");
    button.disabled = false;
    setGaugeLabel(button, "Load Demo CT");
    setGaugeProgress(button, 0);
  }
}
