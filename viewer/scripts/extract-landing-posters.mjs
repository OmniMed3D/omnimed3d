// One-off: extracts a poster JPEG from each landing clip so the page has
// something to show before (or instead of) playback. Re-run only when a
// clip in docs/media/ changes; the output is committed under
// public/landing/. Uses system Chrome (channel "chrome") because
// Playwright's bundled Chromium has no H.264 decoder. Serves the clip via
// page.route on a fake origin so the canvas read isn't cross-origin
// tainted.
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mediaDir = join(__dirname, "..", "..", "docs", "media");
const outDir = join(__dirname, "..", "src", "shell", "public", "landing");
const ORIGIN = "http://posters.local";

// atSeconds past a clip's end clamps to its last frame -- the segmentation
// clip's poster should show the finished lung mask, not the bare volume.
const POSTERS = [
  { clip: "omnimed3d_rendering.mp4", out: "rendering-poster.jpg", atSeconds: 2 },
  { clip: "omnimed3d_segmentation.mp4", out: "segmentation-poster.jpg", atSeconds: 999 },
];

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

await page.route(`${ORIGIN}/**`, async (route) => {
  const path = new URL(route.request().url()).pathname.slice(1);
  if (path === "") {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
    return;
  }
  await route.fulfill({ contentType: "video/mp4", body: readFileSync(join(mediaDir, path)) });
});
await page.goto(`${ORIGIN}/`);

for (const { clip, out, atSeconds } of POSTERS) {
  const dataUrl = await page.evaluate(
    async ({ src, t }) => {
      // page.route can't answer Range requests, so a direct src isn't
      // seekable (seekable = [0, 0]) and every seek lands on frame 0. A
      // blob: URL of the whole clip is fully seekable.
      const blob = await (await fetch(src)).blob();
      const video = document.createElement("video");
      video.muted = true;
      video.src = URL.createObjectURL(blob);
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error(`could not decode ${src}`));
      });
      // A detached <video> can report `seeked` before the new frame is
      // decoded, and drawImage then paints black. Attach it and wait for
      // the seeked-to frame to actually be presented.
      document.body.append(video);
      const presented = new Promise((resolve) => video.requestVideoFrameCallback(resolve));
      video.currentTime = Math.min(t, video.duration - 0.5);
      await presented;
      const scale = Math.min(1, 1280 / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.8);
    },
    { src: `${ORIGIN}/${clip}`, t: atSeconds },
  );
  const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
  writeFileSync(join(outDir, out), bytes);
  console.log(`extract-landing-posters: wrote ${out} (${(bytes.length / 1024).toFixed(0)} KiB)`);
}

await browser.close();
