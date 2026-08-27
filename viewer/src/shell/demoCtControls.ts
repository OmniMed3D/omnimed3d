/**
 * "Load Demo CT" toggle -- lets the user pick one of three bundled, real,
 * de-identified patient series to load without a file dialog. A 3-way
 * toggle reusing the .preset-buttons active-state pattern
 * (backgroundControls.ts/qualityControls.ts) -- clicking a series makes
 * it .active, and re-clicking an already-loaded series reloads it fresh.
 * Each button gets its own gauge overlay (buttonGauge.ts) so its own
 * fetch progress is independently visible, and every other series button
 * is disabled while one is in flight to avoid overlapping fetches.
 *
 * Two of the three (LIDC-IDRI-0001/0002) are lung CT from the same
 * LIDC-IDRI collection; the third (UPENN-GBM-00001) is a brain MR series
 * from a different collection -- deliberately so, since it's also this
 * app's real-world stress case for oblique/non-axial resampling, the
 * "From File" window/level preset, and MPR/Native view modes (see
 * test-data/upenn_gbm/README.md), not just another axial CT demo.
 *
 * Each series is served from `/demo-ct/<series-id>/` (Vite `public/`,
 * populated by `npm run sync-demo-ct` -- see
 * `viewer/scripts/sync-demo-ct.mjs`), not committed there directly: the
 * source of truth is `test-data/<collection>/<series-id>/` (repo root,
 * Git LFS -- a shared resource, not engine/viewer-only, see each
 * collection's own README), and `public/demo-ct/` is gitignored to avoid
 * double-storing that data.
 *
 * `loadVolumeFromBuffers`/`showLoadError` are passed in rather than
 * imported from main.ts's module scope, matching filePicker.ts's
 * setupFilePicker(loadVolumeFromFiles) and inferenceControls.ts's
 * setupInferenceControls(inferenceWorker) pattern of passing in the one
 * capability a module needs.
 *
 * License note: LIDC-IDRI is CC BY 3.0, UPENN-GBM is CC BY 4.0 (both The
 * Cancer Imaging Archive / TCIA, but two different collections under two
 * different license *versions* -- not interchangeable) -- the short
 * status line below is a pointer, not the full required attribution; the
 * <details> disclosure this renders carries the actual Data/Publication
 * Citation + Required Acknowledgement text TCIA's data usage policy
 * requires wherever this data is used (copied from
 * test-data/lidc_idri/README.md and test-data/upenn_gbm/README.md --
 * kept in sync by hand, not fetched at runtime). ATTRIBUTIONS below is
 * keyed by seriesId because the three demo buttons no longer all share
 * one collection/citation.
 */

import { setGaugeLabel, setGaugeProgress } from "./buttonGauge.js";

interface Attribution {
  summary: string;
  details: string;
}

const LIDC_IDRI_ATTRIBUTION: Attribution = {
  summary: "Demo data: LIDC-IDRI (TCIA), CC BY 3.0",
  details: `Data Citation: Armato SG 3rd, McLennan G, Bidaut L, McNitt-Gray MF, Meyer CR, Reeves AP, Zhao B, Aberle DR, Henschke CI, Hoffman EA, Kazerooni EA, MacMahon H, van Beek EJR, Yankelevitz D, et al. (2015). Data From LIDC-IDRI. The Cancer Imaging Archive. https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX

Publication Citation: Armato SG 3rd, McLennan G, Bidaut L, McNitt-Gray MF, Meyer CR, Reeves AP, Zhao B, Aberle DR, Henschke CI, Hoffman EA, Kazerooni EA, MacMahon H, van Beek EJR, Yankelevitz D, et al. (2011). The Lung Image Database Consortium (LIDC) and Image Database Resource Initiative (IDRI): A completed reference database of lung nodules on CT scans. Medical Physics, 38(2), 915-931. https://doi.org/10.1118/1.3528204

Required Acknowledgement: "The authors acknowledge the National Cancer Institute and the Foundation for the National Institutes of Health, and their critical role in the creation of the free publicly available LIDC/IDRI Database used in this study."`,
};

const UPENN_GBM_ATTRIBUTION: Attribution = {
  summary: "Demo data: UPENN-GBM (TCIA), CC BY 4.0",
  details: `Data Citation: Bakas S, Sako C, Akbari H, Bilello M, Sotiras A, Shukla G, Rudie JD, Flores Santamaria N, Fathi Kazerooni A, Pati S, Rathore S, Mamourian E, Ha SM, Parker W, Doshi J, Baid U, Bergman M, Binder ZA, Verma R, et al. (2021). Multi-parametric magnetic resonance imaging (mpMRI) scans for de novo Glioblastoma (GBM) patients from the University of Pennsylvania Health System (UPENN-GBM) (Version 2) [Data set]. The Cancer Imaging Archive. https://doi.org/10.7937/TCIA.709X-DN49

Publication Citation: Bakas S, Sako C, Akbari H, Bilello M, Sotiras A, Shukla G, Rudie JD, Flores Santamaria N, Fathi Kazerooni A, Pati S, Rathore S, Mamourian E, Ha SM, Parker W, Doshi J, Baid U, Bergman M, Binder ZA, Verma R, Lustig R, Desai AS, Bagley SJ, Mourelatos Z, Morrissette J, Watt CD, Brem S, Wolf RL, Melhem ER, Nasrallah MP, Mohan S, O'Rourke DM, Davatzikos C. (2022). The University of Pennsylvania glioblastoma (UPenn-GBM) cohort: advanced MRI, clinical, genomics, & radiomics. Scientific Data, 9(1). https://doi.org/10.1038/s41597-022-01560-7`,
};

const ATTRIBUTIONS: Record<string, Attribution> = {
  "LIDC-IDRI-0001": LIDC_IDRI_ATTRIBUTION,
  "LIDC-IDRI-0002": LIDC_IDRI_ATTRIBUTION,
  "UPENN-GBM-00001": UPENN_GBM_ATTRIBUTION,
};

interface DemoCtManifest {
  files: string[];
}

export function setupDemoCtControls(
  loadVolumeFromBuffers: (buffers: ArrayBuffer[]) => Promise<string>,
  showLoadError: (message?: string) => void,
  setReloadAction: (action: (() => void) | null) => void,
): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-demo-ct-id]"));
  const status = document.getElementById("demo-ct-status");
  if (buttons.length === 0 || !status) {
    console.error("demoCtControls: [data-demo-ct-id] buttons or #demo-ct-status not found in the DOM");
    return;
  }

  buttons.forEach((button) => {
    const seriesId = button.dataset["demoCtId"];
    if (!seriesId) {
      return;
    }
    button.addEventListener("click", () => {
      void loadDemoCt(seriesId, button, buttons, status, loadVolumeFromBuffers, showLoadError, setReloadAction);
    });
  });
}

async function loadDemoCt(
  seriesId: string,
  button: HTMLButtonElement,
  allButtons: HTMLButtonElement[],
  status: HTMLElement,
  loadVolumeFromBuffers: (buffers: ArrayBuffer[]) => Promise<string>,
  showLoadError: (message?: string) => void,
  setReloadAction: (action: (() => void) | null) => void,
): Promise<void> {
  // The button's own rest-state label (e.g. "Lung1") -- restored once
  // loading finishes or fails, rather than left showing transient progress
  // text, since this button stays clickable/re-selectable afterward.
  const restLabel = button.querySelector(".gauge-label")?.textContent ?? seriesId;

  allButtons.forEach((b) => {
    b.disabled = true;
  });
  setGaugeProgress(button, 0);
  status.textContent = "";
  // Registered up front, matching main.ts's loadVolumeFromFiles -- "Reload
  // Volume" (reloadVolumeControl.ts) redoes this same fetch sequence from
  // scratch, cheap since it's a fresh fetch() either way, not a retained
  // in-memory copy.
  setReloadAction(() => {
    void loadDemoCt(seriesId, button, allButtons, status, loadVolumeFromBuffers, showLoadError, setReloadAction);
  });

  let manifest: DemoCtManifest;
  try {
    const manifestResponse = await fetch(`/demo-ct/${seriesId}/manifest.json`);
    if (!manifestResponse.ok) {
      throw new Error(`manifest fetch failed: ${manifestResponse.status}`);
    }
    manifest = (await manifestResponse.json()) as DemoCtManifest;
  } catch {
    showLoadError("Demo CT not available -- run npm run sync-demo-ct first.");
    allButtons.forEach((b) => {
      b.disabled = false;
    });
    setGaugeLabel(button, restLabel);
    setGaugeProgress(button, 0);
    return;
  }

  try {
    const total = manifest.files.length;
    let completed = 0;
    setGaugeLabel(button, `Loading… (0/${total})`);

    const buffers = await Promise.all(
      manifest.files.map(async (filename) => {
        const response = await fetch(`/demo-ct/${seriesId}/${filename}`);
        if (!response.ok) {
          throw new Error(`${filename} fetch failed: ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        completed += 1;
        setGaugeLabel(button, `Loading… (${completed}/${total})`);
        setGaugeProgress(button, completed / total);
        return buffer;
      }),
    );

    await loadVolumeFromBuffers(buffers);

    allButtons.forEach((b) => {
      b.disabled = false;
      b.classList.toggle("active", b === button);
    });
    setGaugeLabel(button, restLabel);
    setGaugeProgress(button, 0);
    status.replaceChildren();
    const attribution = ATTRIBUTIONS[seriesId];
    if (attribution) {
      status.append(document.createTextNode(`${attribution.summary} (${seriesId}) `));
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Attribution";
      details.append(summary);
      const citation = document.createElement("p");
      citation.textContent = attribution.details;
      details.append(citation);
      status.append(details);
    } else {
      console.error(`demoCtControls: no attribution entry for seriesId=${seriesId}, showing nothing`);
    }
  } catch {
    showLoadError("Couldn't load the demo CT series -- one or more slice requests failed.");
    allButtons.forEach((b) => {
      b.disabled = false;
    });
    setGaugeLabel(button, restLabel);
    setGaugeProgress(button, 0);
  }
}
