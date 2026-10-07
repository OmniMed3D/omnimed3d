// Copies the landing page's demo clips from docs/media/ (repo root, Git
// LFS -- also embedded in the root README) into
// viewer/src/shell/public/media/, served as-is at /media/. Same
// "gitignored, script-regenerated" pattern as sync-demo-ct.mjs, so the
// clips aren't stored twice in git. Chained after sync-demo-ct in
// package.json, which the deploy workflow already runs.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, "..", "..", "docs", "media");
const destDir = join(__dirname, "..", "src", "shell", "public", "media");

const CLIPS = ["omnimed3d_rendering.mp4", "omnimed3d_segmentation.mp4"];

// An un-pulled Git LFS pointer stub is ~130 bytes; a real clip is MBs.
const MIN_REAL_FILE_BYTES = 10 * 1024;
// Cloudflare Pages rejects any single static asset over 25 MiB.
const MAX_PAGES_FILE_BYTES = 25 * 1024 * 1024;

mkdirSync(destDir, { recursive: true });

for (const name of CLIPS) {
  const source = join(sourceDir, name);
  if (!existsSync(source)) {
    console.error(`sync-landing-media: ${source} not found.`);
    process.exit(1);
  }
  const size = statSync(source).size;
  if (size < MIN_REAL_FILE_BYTES) {
    console.error(
      `sync-landing-media: ${name} is only ${size} bytes -- looks like an un-pulled Git LFS pointer stub. ` +
        `Run "git lfs pull" first.`,
    );
    process.exit(1);
  }
  if (size > MAX_PAGES_FILE_BYTES) {
    console.error(
      `sync-landing-media: ${name} is ${(size / 1024 / 1024).toFixed(1)} MiB, over Cloudflare Pages' 25 MiB ` +
        `per-file limit -- re-encode it smaller before deploying.`,
    );
    process.exit(1);
  }
  copyFileSync(source, join(destDir, name));
  console.log(`sync-landing-media: copied ${name} (${(size / 1024 / 1024).toFixed(1)} MiB) -> ${destDir}`);
}
