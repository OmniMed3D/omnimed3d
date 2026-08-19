/**
 * Real file-picker UI (issue #34, REQ-R06) -- two entry points, matching
 * Mini-Engine-reference's validated UX pattern (docs/current/medical-
 * volume/VIEWERS.md, referenced from PRD Appendix A's "referencing
 * Mini-Engine-reference's UI patterns" instruction): a `webkitdirectory`
 * folder picker as the primary, convenient way to select a whole series
 * at once, and a plain multi-file picker as a fallback for
 * browsers/situations where folder selection isn't available or wanted.
 * Both call the same `loadVolumeFromFiles` (main.ts) that
 * `omnimed3dTestHooks`-driven flows already use by hand -- same Worker
 * instance, same volumeId bookkeeping.
 *
 * Unlike Mini-Engine-reference's native-filesystem (MEMFS) staging
 * approach, this project's Parse Worker does the actual DICOM decoding
 * off the main thread -- this module only ever reads File objects into
 * ArrayBuffers and hands them off; it never touches DICOM bytes itself.
 */

export type LoadVolumeFromFiles = (files: File[]) => Promise<string>;

// Follow-up (critique heuristic #5, Error Prevention): #dicom-folder-input
// has no `accept` filter at all, and even where `accept` is set
// (#dicom-files-input), it's browser-advisory, not enforced. A real DICOM
// file conventionally has NO extension at all (common in real-world
// datasets), so an allow-list requiring ".dcm" would wrongly reject valid
// files -- this is a deny-list of common non-DICOM junk instead
// (folder-picker noise: OS metadata files, readmes, or the DICOMDIR
// index file itself, which is a real DICOM-adjacent file but not a pixel
// dataset dicom-parser can decode).
const IGNORED_FILENAMES = new Set(["Thumbs.db", ".DS_Store", "DICOMDIR"]);
const IGNORED_EXTENSIONS = [".txt", ".json", ".xml", ".pdf", ".jpg", ".jpeg", ".png", ".zip"];

function isLikelyNonDicom(file: File): boolean {
  const name = file.name.split(/[/\\]/).pop() ?? file.name;
  if (IGNORED_FILENAMES.has(name)) {
    return true;
  }
  return IGNORED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

function wireFileInput(inputId: string, loadVolumeFromFiles: LoadVolumeFromFiles): void {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  if (!input) {
    console.error(`filePicker: #${inputId} not found in the DOM`);
    return;
  }

  input.addEventListener("change", () => {
    const files = input.files;
    if (!files || files.length === 0) {
      return;
    }
    const filtered = Array.from(files).filter((file) => !isLikelyNonDicom(file));
    if (filtered.length === 0) {
      console.log("filePicker: every selected file looked like non-DICOM junk, nothing to load");
      input.value = "";
      return;
    }
    loadVolumeFromFiles(filtered).catch((error: unknown) => {
      console.error("filePicker: failed to load volume from selected files", error);
    });
    // Reset so selecting the same file(s) again still fires "change".
    input.value = "";
  });
}

export function setupFilePicker(loadVolumeFromFiles: LoadVolumeFromFiles): void {
  wireFileInput("dicom-folder-input", loadVolumeFromFiles);
  wireFileInput("dicom-files-input", loadVolumeFromFiles);
}
