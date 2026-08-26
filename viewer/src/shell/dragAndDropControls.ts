/**
 * Drag-and-drop DICOM loading (user request, 2026-08-27) -- drop a
 * folder or a handful of files anywhere on the page to load them,
 * alongside the existing "Load DICOM folder"/"Load DICOM files" pickers
 * (filePicker.ts). Both end up calling the same `loadVolumeFromFiles`
 * (main.ts), so this module's only real job is turning a `DragEvent`
 * into a flat `File[]`.
 *
 * Folder support uses the (still webkit-prefixed, Chrome-only --
 * matches REQ-R07's P0 scope) `DataTransferItem.webkitGetAsEntry()` /
 * `FileSystemDirectoryReader` API to walk a dropped directory
 * recursively. A dropped *file* (not a folder) usually has no real
 * filesystem entry backing it when the drag didn't originate from a real
 * OS file drag (e.g. a synthetic `DataTransfer` built in a test) --
 * `webkitGetAsEntry()` returns null in that case, so every item falls
 * back to `item.getAsFile()` (always available for a file-kind item)
 * rather than silently dropping it.
 *
 * `dragenter`/`dragleave` are tracked with a depth counter, not a plain
 * boolean -- both events re-fire (bubble) as the pointer crosses *every*
 * element boundary under the cursor (entering a child fires dragleave on
 * the parent then dragenter on the child), so a naive "hide on
 * dragleave" flickers the overlay on/off while dragging across the
 * page's own child elements. Depth only reaches 0 once the pointer has
 * actually left every nested element, i.e. left the window/page.
 */

import { isLikelyNonDicom } from "./filePicker.js";

export type LoadVolumeFromFiles = (files: File[]) => Promise<string>;

// FileSystemDirectoryReader.readEntries() only returns up to 100 entries
// per call by spec -- it must be called repeatedly until it resolves
// with an empty array to see the rest of a larger directory.
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    function readBatch(): void {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve(all);
          return;
        }
        all.push(...entries);
        readBatch();
      }, reject);
    }
    readBatch();
  });
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function collectFilesFromEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    out.push(await fileFromEntry(entry as FileSystemFileEntry));
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) {
      await collectFilesFromEntry(child, out);
    }
  }
}

async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const files: File[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") {
      continue;
    }
    const entry = item.webkitGetAsEntry?.();
    if (entry) {
      await collectFilesFromEntry(entry, files);
      continue;
    }
    // No real filesystem entry (see this module's own header comment) --
    // fall back to the plain File, still real drag-and-drop data either way.
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  return files;
}

function hasFilesPayload(event: DragEvent): boolean {
  // Ignore a drag that isn't carrying files at all (e.g. dragged text/a
  // link) -- showing "drop to load" for those would be misleading, and
  // preventDefault()ing every drag on the page would also break normal
  // text selection/drag elsewhere in the document.
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function setupDragAndDrop(loadVolumeFromFiles: LoadVolumeFromFiles): void {
  const overlay = document.getElementById("drop-overlay");
  if (!overlay) {
    console.error("dragAndDropControls: #drop-overlay not found in the DOM");
    return;
  }

  let dragDepth = 0;

  window.addEventListener("dragenter", (event) => {
    if (!hasFilesPayload(event)) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    overlay.hidden = false;
  });

  window.addEventListener("dragover", (event) => {
    // Required on every dragover, not just dragenter -- a drop target
    // that never calls preventDefault() here silently rejects the drop
    // entirely (the browser's own default is "not a valid drop target").
    if (hasFilesPayload(event)) {
      event.preventDefault();
    }
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasFilesPayload(event)) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      overlay.hidden = true;
    }
  });

  window.addEventListener("drop", (event) => {
    if (!hasFilesPayload(event)) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;

    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) {
      return;
    }
    void (async () => {
      const files = (await collectDroppedFiles(dataTransfer)).filter((file) => !isLikelyNonDicom(file));
      if (files.length === 0) {
        console.log(
          "dragAndDropControls: nothing but non-DICOM junk (or an empty folder) in the drop, nothing to load",
        );
        return;
      }
      try {
        await loadVolumeFromFiles(files);
      } catch (error) {
        console.error("dragAndDropControls: failed to load volume from dropped files", error);
      }
    })();
  });
}
