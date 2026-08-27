// Copies each demo CT/MR series into viewer/src/shell/public/demo-ct/
// <series-id>/, Vite's convention for pre-built assets served as-is (not
// bundled). Copies rather than symlinks for Windows/Mac portability,
// mirroring sync-engine-wasm.mjs's own approach. Source is
// test-data/<collection>/<series-id>/*.dcm (repo root, not under engine/
// -- a shared/cross-module resource, see each collection's own README),
// tracked via Git LFS -- NOT committed a second time under public/, the
// same "gitignored, script-regenerated" pattern sync-engine-wasm.mjs uses
// for engine/build_wasm/, chosen specifically to avoid double-storing
// that much LFS data across every series.
//
// Also writes a manifest.json alongside each series' copied files: the
// source filenames are UUIDs (TCIA/IDC bulk-download convention), not a
// predictable sequential pattern, so the browser can't just template slice
// URLs -- it fetches this manifest first to know what to fetch. Slice
// ORDER doesn't need to be meaningful here (the Parse Worker's
// assembleSeries() re-sorts by DICOM geometry, not array/fetch order), but
// each manifest's file list is still sorted for a reproducible, diffable
// output across runs.
//
// Series can come from different TCIA collections (each with its own
// directory/README/license under test-data/), so COLLECTIONS below maps
// each series to its own source collection directory.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDataRoot = join(__dirname, "..", "..", "test-data");
const destRoot = join(__dirname, "..", "src", "shell", "public", "demo-ct");

// demoCtControls.ts's toggle buttons (index.html's [data-demo-ct-id]) --
// keep this list in sync with that markup. Each entry's `collection` is
// the test-data/<collection>/ directory its series lives under.
const SERIES = [
  { seriesId: "LIDC-IDRI-0001", collection: "lidc_idri" },
  { seriesId: "LIDC-IDRI-0002", collection: "lidc_idri" },
  { seriesId: "UPENN-GBM-00001", collection: "upenn_gbm" },
];

// A real slice is several hundred KB; an un-pulled Git LFS pointer stub is
// ~130 bytes. This guards against silently copying pointer stubs (which the
// DICOM parser would then reject one-by-one with confusing errors) when
// `git lfs pull` hasn't actually run yet.
const MIN_REAL_FILE_BYTES = 10 * 1024;

for (const { seriesId, collection } of SERIES) {
  const sourceDir = join(testDataRoot, collection, seriesId);
  const destDir = join(destRoot, seriesId);

  if (!existsSync(sourceDir)) {
    console.error(
      `sync-demo-ct: ${sourceDir} not found. This should already be committed via Git LFS -- ` +
        `check the repo checkout is complete.`,
    );
    process.exit(1);
  }

  const filenames = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".dcm"))
    .sort();

  if (filenames.length === 0) {
    console.error(`sync-demo-ct: no .dcm files found in ${sourceDir}.`);
    process.exit(1);
  }

  for (const name of filenames) {
    const size = statSync(join(sourceDir, name)).size;
    if (size < MIN_REAL_FILE_BYTES) {
      console.error(
        `sync-demo-ct: ${seriesId}/${name} is only ${size} bytes -- looks like an un-pulled Git LFS ` +
          `pointer stub, not real DICOM data. Run "git lfs pull" first.`,
      );
      process.exit(1);
    }
  }

  mkdirSync(destDir, { recursive: true });
  for (const name of filenames) {
    copyFileSync(join(sourceDir, name), join(destDir, name));
  }
  writeFileSync(join(destDir, "manifest.json"), JSON.stringify({ files: filenames }, null, 2));

  console.log(`sync-demo-ct: copied ${filenames.length} files -> ${destDir}`);
  console.log(`sync-demo-ct: wrote ${seriesId}/manifest.json (${filenames.length} entries)`);
}
