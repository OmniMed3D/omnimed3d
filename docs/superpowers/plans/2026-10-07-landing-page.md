# Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a landing page at `/` and move the existing viewer to `/app/`, with a one-click demo entry (`/app/?demo=<series-id>`) and self-hosted demo clips.

**Architecture:** One Vite multi-page build rooted at `viewer/src/shell`: `index.html` (landing, new) and `app/index.html` (the viewer, moved). The landing page is static HTML + its own CSS + one small TypeScript module (video playback and WebGPU notice). Demo clips are copied from `docs/media/` (Git LFS) into the gitignored `public/media/` by a sync script, chained into the existing `sync-demo-ct` npm script so `deploy.yml` stays untouched.

**Tech Stack:** Vite 5, vanilla TypeScript, Playwright (e2e), Node ESM scripts.

**Spec:** `docs/superpowers/specs/2026-10-07-landing-page-design.md`

## Global Constraints

- No new npm dependencies; no UI framework.
- No changes to `.github/workflows/deploy.yml`, `viewer/src/shell/public/_headers`, or anything under `infra/`.
- Page copy is English.
- Demo CTA target is exactly `/app/?demo=LIDC-IDRI-0001`. GitHub link is exactly `https://github.com/OmniMed3D/omnimed3d`.
- Demo series ids are exactly `LIDC-IDRI-0001`, `LIDC-IDRI-0002`, `UPENN-GBM-00001` (the `data-demo-ct-id` values in the viewer HTML).
- The footer must state the page is a research prototype, not a certified clinical device, not for diagnostic use, and credit LIDC-IDRI (CC BY 3.0) and UPENN-GBM (CC BY 4.0) via TCIA.
- No horizontal page scroll at 320 px and 375 px viewport widths.
- Each clip copied into `public/media/` must be ≤ 25 MiB (Cloudflare Pages per-file limit).
- All landing scripts and styles are same-origin; the only cross-origin load is Google Fonts (compatible with the site-wide `Cross-Origin-Embedder-Policy: require-corp`).
- **Commits:** never run `git commit` without the user's explicit go-ahead at that moment, and again separately before any `git push`. Commit messages: `type: subject`, no `(scope)`, no `Co-Authored-By` trailer, no references to gitignored/local-only files, no "Closes #N" (that goes in the PR body only). On PowerShell, write the message to a file without a BOM (e.g. from bash: `printf ... > "$TMP/msg.txt"`, then `git commit -F`).
- Work on branch `feat/viewer-landing-page`; the whole plan ships as one PR.

## Review Focus

1. `/app` without a trailing slash (typed URLs, old links) must open the viewer, not fall back to the landing page — test in Task 1.
2. `?demo=` with an unknown id must leave the viewer exactly as it is today (no load, no error, no disabled buttons) — test in Task 2.
3. `?demo=` combined with other params (`?lowMemory=1&demo=…`) must still auto-load — test in Task 2.
4. Clips missing or blocked (sync not run, network failure) must leave the layout intact, show the poster, and throw no page error — test in Task 4.
5. A browser without WebGPU must see a plain-language notice next to the CTA instead of clicking into a viewer that can't start — test in Task 4.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `viewer/src/shell/app/index.html` | The viewer page (moved from `src/shell/index.html`; only relative `./` refs change to `../`). |
| `viewer/src/shell/index.html` | Landing page markup. |
| `viewer/src/shell/landing.css` | Landing-only styles and tokens. Viewer `style.css` is not touched. |
| `viewer/src/shell/landing.ts` | Viewport-gated clip playback, reduced-motion handling, WebGPU-missing notice. |
| `viewer/src/shell/demoCtControls.ts` | Adds `autoLoadDemoFromQuery()`. |
| `viewer/src/shell/main.ts` | Calls `autoLoadDemoFromQuery()` after the shell reports ready. |
| `viewer/vite.config.ts` | Registers both HTML entries. |
| `viewer/scripts/sync-landing-media.mjs` | Copies `docs/media/*.mp4` → `public/media/` with LFS-stub and size guards. |
| `viewer/scripts/extract-landing-posters.mjs` | One-off: extracts poster JPEGs from the clips via system Chrome. |
| `viewer/src/shell/public/landing/*.jpg` | Committed poster frames. |
| `viewer/tests/e2e/landing.spec.ts` | Landing e2e. |
| `viewer/tests/e2e/demo-ct-autoload.spec.ts` | `?demo=` e2e. |
| `viewer/tests/e2e/*.spec.ts` (20 files) | `page.goto` paths migrated to `/app/`. |

---

### Task 1: Move the viewer to `/app/`

**Files:**
- Move: `viewer/src/shell/index.html` → `viewer/src/shell/app/index.html` (lines 24 and 664 change)
- Create: `viewer/src/shell/index.html` (minimal landing stub; replaced in Task 4)
- Modify: `viewer/vite.config.ts` (`build` block)
- Modify: all 20 files in `viewer/tests/e2e/` that call `page.goto`
- Modify: `viewer/scripts/dev-server.ps1:21`, `viewer/scripts/dev-server.sh:23`
- Modify: `viewer/README.md` (dev-server section near line 38)
- Test: `viewer/tests/e2e/demo-ct-loader.spec.ts` (existing), new `/app` no-slash case in `viewer/tests/e2e/landing.spec.ts`

**Interfaces:**
- Produces: viewer served at `/app/`; landing entry at `/` (stub); Vite build emitting `dist/index.html` and `dist/app/index.html`.

- [ ] **Step 1: Move the viewer HTML with git so history follows it**

```bash
cd viewer
mkdir -p src/shell/app
git mv src/shell/index.html src/shell/app/index.html
```

- [ ] **Step 2: Fix the two relative references in the moved file**

In `viewer/src/shell/app/index.html`:

```html
    <link rel="stylesheet" href="../style.css" />
```
(was `./style.css`, line 24)

```html
    <script type="module" src="../main.ts"></script>
```
(was `./main.ts`, line 664). Leave `/engine/wasm_smoke.js` and every other absolute path unchanged. Confirm nothing else is relative:

Run: `grep -n -E '(src|href)="\./' src/shell/app/index.html`
Expected: no output.

- [ ] **Step 3: Create the landing stub so `/` still resolves**

`viewer/src/shell/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OmniMed3D</title>
  </head>
  <body>
    <h1>OmniMed3D</h1>
    <a href="/app/?demo=LIDC-IDRI-0001">Open the demo</a>
  </body>
</html>
```

- [ ] **Step 4: Register both pages in the Vite build**

In `viewer/vite.config.ts`, replace the existing first line (`import { defineConfig } from "vite";`) with these imports plus the `shellRoot` constant, then replace the `build` block:

```ts
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), "src/shell");
```

```ts
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    // Two pages from one build: the landing page at / and the viewer at
    // /app/. Both share public/ (engine WASM, models, demo series) and the
    // site-wide headers in public/_headers.
    rollupOptions: {
      input: {
        landing: resolve(shellRoot, "index.html"),
        app: resolve(shellRoot, "app/index.html"),
      },
    },
  },
```

- [ ] **Step 5: Migrate every e2e `page.goto` to `/app/`**

```bash
cd viewer
sed -i -E 's#page\.goto\("/#page.goto("/app/#g; s#page\.goto\(`/\$\{#page.goto(`/app/${#g' tests/e2e/*.spec.ts
grep -rhn 'page.goto(' tests/e2e | grep -v '/app/'
```
Expected: the final grep prints only comment lines (e.g. `device-tier-low-memory.spec.ts:18`'s "before `page.goto()`"), no real calls. Spot-check: `goto("/")` → `goto("/app/")`, `goto("/?lowMemory=0")` → `goto("/app/?lowMemory=0")`, and `` goto(`/${urlSuffix}`) `` → `` goto(`/app/${urlSuffix}`) ``. Do NOT touch `src/workers/inference-worker/e2e/` — it runs its own server and `worker-harness.html`.

- [ ] **Step 6: Write the failing no-trailing-slash test**

Create `viewer/tests/e2e/landing.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

/**
 * Landing page at / and its hand-off into the viewer at /app/. See
 * docs/superpowers/specs/2026-10-07-landing-page-design.md.
 */

test("/app without a trailing slash opens the viewer, not the landing page", async ({ page }) => {
  await page.goto("/app");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
});
```

- [ ] **Step 7: Run it**

Run: `cd viewer && npx playwright test tests/e2e/landing.spec.ts`
Expected: PASS if Vite's dev server already resolves `/app` to `app/index.html`. If it FAILS (the landing stub renders, or 404), add this plugin to `vite.config.ts`'s `defineConfig({ ... })` and re-run until it passes:

```ts
  plugins: [
    {
      // The dev server doesn't map /app to app/index.html on its own;
      // Cloudflare Pages redirects /app -> /app/ in production, so mirror
      // that here.
      name: "app-trailing-slash",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/app" || req.url?.startsWith("/app?")) {
            res.statusCode = 301;
            res.setHeader("Location", req.url.replace(/^\/app/, "/app/"));
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
```

- [ ] **Step 8: Run an existing viewer e2e under the new path**

Run: `cd viewer && npx playwright test tests/e2e/demo-ct-loader.spec.ts tests/e2e/shell-mask-integration.spec.ts`
Expected: PASS (requires `npm run sync-engine-wasm` and `npm run sync-demo-ct` to have been run).

- [ ] **Step 9: Verify the production build emits both pages**

Run: `cd viewer && npm run build && ls ../viewer/dist/index.html ../viewer/dist/app/index.html`
Expected: both files listed. Then `grep -c "wasm_smoke.js" dist/app/index.html` → `1`.

- [ ] **Step 10: Point dev-server output and README at the viewer path**

`viewer/scripts/dev-server.ps1:21` → `$DevUrl = "http://localhost:5173/app/"` and `viewer/scripts/dev-server.sh:23` → `dev_url="http://localhost:5173/app/"`. In `viewer/README.md`'s dev-server section, add after the `npm run dev` block:

```markdown
The dev server serves the landing page at `/` and the viewer at `/app/`
(`http://localhost:5173/app/`). Append `?demo=LIDC-IDRI-0001` (or
`LIDC-IDRI-0002`, `UPENN-GBM-00001`) to start a demo series loading
immediately.
```

- [ ] **Step 11: Commit (after the user's explicit go-ahead)**

```bash
git add viewer/src/shell/app/index.html viewer/src/shell/index.html viewer/vite.config.ts viewer/tests/e2e viewer/scripts/dev-server.ps1 viewer/scripts/dev-server.sh viewer/README.md
git status --short   # confirm only these
```
Message: `refactor: move the viewer to /app/ and add a landing entry point`

---

### Task 2: `?demo=<series-id>` auto-load

**Files:**
- Modify: `viewer/src/shell/demoCtControls.ts` (add export after `setupDemoCtControls`)
- Modify: `viewer/src/shell/main.ts:35` (import) and `:703` (call)
- Test: `viewer/tests/e2e/demo-ct-autoload.spec.ts`

**Interfaces:**
- Consumes: viewer at `/app/` (Task 1); existing `[data-demo-ct-id]` buttons wired by `setupDemoCtControls`.
- Produces: `export function autoLoadDemoFromQuery(search: string = location.search): void` in `demoCtControls.ts`.

- [ ] **Step 1: Write the failing tests**

Create `viewer/tests/e2e/demo-ct-autoload.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

/**
 * ?demo=<series-id> starts that demo series loading without a click -- the
 * landing page's "Open the demo" CTA links here. Requires
 * `npm run sync-demo-ct` (same prerequisite as demo-ct-loader.spec.ts).
 */

test("?demo=LIDC-IDRI-0001 loads that series without a click", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));

  await page.goto("/app/?demo=LIDC-IDRI-0001");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await expect
    .poll(() => consoleLines.some((line) => /WebGPUDevice::loadVolume: volumeId=\d+ .* loaded/.test(line)), {
      timeout: 60000,
    })
    .toBe(true);
  await expect(page.locator("#load-demo-ct")).toHaveClass(/active/);
});

test("?demo= works alongside other query params", async ({ page }) => {
  await page.goto("/app/?lowMemory=1&demo=LIDC-IDRI-0002");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await expect(page.locator('[data-demo-ct-id="LIDC-IDRI-0002"]')).toHaveClass(/active/, { timeout: 60000 });
});

test("an unknown ?demo= id leaves the viewer idle", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));

  await page.goto("/app/?demo=not-a-series");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
  await page.waitForTimeout(1000);

  const buttons = page.locator("[data-demo-ct-id]");
  for (let i = 0; i < (await buttons.count()); i++) {
    await expect(buttons.nth(i)).toBeEnabled();
    await expect(buttons.nth(i)).not.toHaveClass(/active/);
  }
  await expect(page.locator("#empty-hint")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
```

- [ ] **Step 2: Run to confirm the first two fail**

Run: `cd viewer && npx playwright test tests/e2e/demo-ct-autoload.spec.ts`
Expected: the two load tests FAIL (timeout waiting for the load / `.active`); the unknown-id test PASSES already.

- [ ] **Step 3: Implement `autoLoadDemoFromQuery`**

Append to `viewer/src/shell/demoCtControls.ts`, directly after `setupDemoCtControls`:

```ts
/**
 * Starts the demo series named by `?demo=<series-id>` loading, as if its
 * button had been clicked -- the landing page's "Open the demo" CTA links
 * to /app/?demo=LIDC-IDRI-0001. Must run after setupDemoCtControls (the
 * click handler does the actual load) and after the engine is ready. An
 * unknown or empty id is ignored: the viewer stays exactly as it would
 * without the parameter.
 */
export function autoLoadDemoFromQuery(search: string = location.search): void {
  const seriesId = new URLSearchParams(search).get("demo");
  if (!seriesId) {
    return;
  }
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-demo-ct-id]")).find(
    (candidate) => candidate.dataset["demoCtId"] === seriesId,
  );
  button?.click();
}
```

- [ ] **Step 4: Call it once the shell is ready**

`viewer/src/shell/main.ts:35`:

```ts
import { autoLoadDemoFromQuery, setupDemoCtControls } from "./demoCtControls.js";
```

After line 703 (`document.getElementById("shell-status")!.textContent = "shell: ready for input";`) and the `empty-hint` line that follows it, add:

```ts
  autoLoadDemoFromQuery();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd viewer && npx playwright test tests/e2e/demo-ct-autoload.spec.ts tests/e2e/demo-ct-loader.spec.ts`
Expected: all PASS.

- [ ] **Step 6: Commit (after the user's explicit go-ahead)**

```bash
git add viewer/src/shell/demoCtControls.ts viewer/src/shell/main.ts viewer/tests/e2e/demo-ct-autoload.spec.ts
```
Message: `feat: auto-load a demo series from the ?demo= query parameter`

---

### Task 3: Landing media sync and poster frames

**Files:**
- Create: `viewer/scripts/sync-landing-media.mjs`
- Create: `viewer/scripts/extract-landing-posters.mjs`
- Create (generated, committed): `viewer/src/shell/public/landing/rendering-poster.jpg`, `viewer/src/shell/public/landing/segmentation-poster.jpg`
- Modify: `viewer/package.json` (`scripts`)
- Modify: `.gitignore` (after line 33)

**Interfaces:**
- Produces: `/media/omnimed3d_rendering.mp4`, `/media/omnimed3d_segmentation.mp4` (served from gitignored `public/media/`); `/landing/rendering-poster.jpg`, `/landing/segmentation-poster.jpg` (committed). npm script `sync-landing-media`; `sync-demo-ct` now also runs it.

- [ ] **Step 1: Write the sync script**

`viewer/scripts/sync-landing-media.mjs`:

```js
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
```

- [ ] **Step 2: Wire it into npm scripts**

In `viewer/package.json` `scripts`, replace the `sync-demo-ct` line and add `sync-landing-media`:

```json
    "sync-demo-ct": "node scripts/sync-demo-ct.mjs && node scripts/sync-landing-media.mjs",
    "sync-landing-media": "node scripts/sync-landing-media.mjs",
```

- [ ] **Step 3: Gitignore the copied clips**

In `.gitignore`, after line 33 (`viewer/src/shell/public/demo-ct/`):

```gitignore
# Landing page demo clips, copied from docs/media/ (Git LFS) by
# npm run sync-landing-media -- same no-double-storage reasoning as
# public/demo-ct/ above.
viewer/src/shell/public/media/
```

- [ ] **Step 4: Run the sync and verify**

Run: `cd viewer && npm run sync-landing-media && ls -l src/shell/public/media && git status --short src/shell/public`
Expected: two `.mp4` files ~19.7 MB and ~8.9 MB; `git status` shows nothing under `public/media/`.

- [ ] **Step 5: Write the poster extraction script**

`viewer/scripts/extract-landing-posters.mjs`:

```js
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

const POSTERS = [
  { clip: "omnimed3d_rendering.mp4", out: "rendering-poster.jpg", atSeconds: 2 },
  { clip: "omnimed3d_segmentation.mp4", out: "segmentation-poster.jpg", atSeconds: 4 },
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
      const video = document.createElement("video");
      video.muted = true;
      video.src = src;
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error(`could not decode ${src}`));
      });
      video.currentTime = Math.min(t, video.duration - 0.1);
      await new Promise((resolve) => (video.onseeked = resolve));
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
```

- [ ] **Step 6: Generate the posters and check them**

Run: `cd viewer && node scripts/extract-landing-posters.mjs`
Expected: two `wrote …-poster.jpg` lines, each roughly 50–300 KiB. Open both JPEGs and confirm each shows a rendered volume, not a black frame. If a frame is black or a title card, change that entry's `atSeconds` and re-run.

- [ ] **Step 7: Commit (after the user's explicit go-ahead)**

```bash
git add viewer/scripts/sync-landing-media.mjs viewer/scripts/extract-landing-posters.mjs viewer/src/shell/public/landing viewer/package.json .gitignore
```
Note: on the reference dev machine `.gitignore` also carries an unrelated, uncommitted `.ua/`/`.understand-anything/` block at the end of the file. Ask the user whether it belongs in this PR. If not, keep it out without interactive staging: `git stash push -- .gitignore`, re-apply only Step 3's block, `git add .gitignore`, commit, then `git stash pop` (the two edits touch different regions, so the pop applies cleanly).
Message: `feat: sync landing demo clips and add poster frames`

---

### Task 4: Landing page

**Files:**
- Modify (replace stub): `viewer/src/shell/index.html`
- Create: `viewer/src/shell/landing.css`
- Create: `viewer/src/shell/landing.ts`
- Test: `viewer/tests/e2e/landing.spec.ts` (extend)

**Interfaces:**
- Consumes: `/app/?demo=LIDC-IDRI-0001` (Task 2), `/media/*.mp4` and `/landing/*-poster.jpg` (Task 3).
- Produces: elements the tests address — `#cta-demo`, `#webgpu-warning`, `video.clip` (×2), `footer`.

- [ ] **Step 1: Write the failing landing tests**

Append to `viewer/tests/e2e/landing.spec.ts`:

```ts
test("landing shows the product, the demo CTA, and the GitHub link", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("#cta-demo")).toHaveAttribute("href", "/app/?demo=LIDC-IDRI-0001");
  await expect(page.getByRole("link", { name: "View on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/OmniMed3D/omnimed3d",
  );
});

test("footer carries the prototype disclaimer and demo data attribution", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer).toContainText("not a certified clinical device");
  await expect(footer).toContainText("LIDC-IDRI");
  await expect(footer).toContainText("CC BY 3.0");
  await expect(footer).toContainText("UPENN-GBM");
  await expect(footer).toContainText("CC BY 4.0");
});

for (const width of [320, 375]) {
  test(`no horizontal scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("reduced motion keeps clips paused with native controls", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const clips = page.locator("video.clip");
  await expect(clips).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    expect(await clips.nth(i).evaluate((v: HTMLVideoElement) => v.paused && v.controls)).toBe(true);
  }
});

test("missing clips leave the layout intact and throw no page error", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));
  await page.route("**/media/*.mp4", (route) => route.abort());
  await page.goto("/");
  await page.waitForTimeout(1000);

  const box = await page.locator(".hero-media video").boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(100);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(pageErrors).toEqual([]);
});

test("a browser without WebGPU sees a notice next to the CTA", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true });
  });
  await page.goto("/");
  await expect(page.locator("#webgpu-warning")).toBeVisible();
});

test("a WebGPU-capable browser sees no notice", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#webgpu-warning")).toBeHidden();
});
```

- [ ] **Step 2: Run to confirm they fail against the stub**

Run: `cd viewer && npx playwright test tests/e2e/landing.spec.ts`
Expected: the `/app` test PASSES; the CTA test fails (no `#cta-demo`), and footer/clip/WebGPU tests fail.

- [ ] **Step 3: Replace the stub with the landing markup**

`viewer/src/shell/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OmniMed3D</title>
    <meta
      name="description"
      content="A browser-only 3D medical imaging viewer: WebGPU volume rendering and on-device AI segmentation. Nothing is installed or uploaded."
    />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="./landing.css" />
  </head>
  <body>
    <header class="site-header">
      <span class="wordmark">OmniMed3D</span>
      <a class="header-link" href="https://github.com/OmniMed3D/omnimed3d">GitHub</a>
    </header>

    <main>
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">Research prototype</p>
          <h1>3D medical imaging that runs entirely in your browser</h1>
          <p class="lede">
            OmniMed3D renders CT and MR volumes with WebGPU and runs AI segmentation on your own device. There is
            nothing to install, and your scans never leave your machine.
          </p>
          <div class="cta-row">
            <a class="btn btn-primary" id="cta-demo" href="/app/?demo=LIDC-IDRI-0001">Open the demo</a>
            <a class="btn btn-secondary" href="https://github.com/OmniMed3D/omnimed3d">View on GitHub</a>
          </div>
          <p class="cta-note">
            The demo loads a public, de-identified chest CT. Needs a WebGPU-capable browser, such as recent Chrome on
            desktop or Android.
          </p>
          <p class="webgpu-warning" id="webgpu-warning" hidden>
            This browser doesn't expose WebGPU, so the viewer can't start here. Try a recent version of Chrome.
          </p>
        </div>
        <figure class="hero-media">
          <video
            class="clip"
            src="/media/omnimed3d_rendering.mp4"
            poster="/landing/rendering-poster.jpg"
            muted
            loop
            playsinline
            preload="none"
            aria-label="Screen capture: a chest CT volume rotating under real-time WebGPU rendering"
          ></video>
          <figcaption>Real-time WebGPU raymarching with clinical window/level.</figcaption>
        </figure>
      </section>

      <section class="values" aria-label="Why OmniMed3D">
        <div class="value">
          <h2>Nothing to install</h2>
          <p>Open a link and load a scan. No plugin, no desktop app, no IT setup.</p>
        </div>
        <div class="value">
          <h2>Nothing uploaded</h2>
          <p>DICOM parsing, AI inference, and rendering all happen on your device. No server ever sees the data.</p>
        </div>
        <div class="value">
          <h2>Works offline</h2>
          <p>After the first visit loads the app, it keeps working without a network connection.</p>
        </div>
      </section>

      <section class="feature">
        <figure class="feature-media">
          <video
            class="clip"
            src="/media/omnimed3d_segmentation.mp4"
            poster="/landing/segmentation-poster.jpg"
            muted
            loop
            playsinline
            preload="none"
            aria-label="Screen capture: a lung segmentation mask filling in progressively over the rendered CT volume"
          ></video>
        </figure>
        <div class="feature-copy">
          <h2>AI segmentation that never blocks the view</h2>
          <p>
            The volume renders the moment it loads. A lung segmentation model runs in the browser with ONNX Runtime
            Web, and its mask fills in slice by slice on top of the image you're already exploring.
          </p>
        </div>
      </section>

      <section class="pipeline" aria-labelledby="pipeline-title">
        <h2 id="pipeline-title">How it works</h2>
        <ol class="steps">
          <li>
            <span class="step-name">Your DICOM files</span>
            <span class="step-detail">Picked from disk. Never uploaded.</span>
          </li>
          <li>
            <span class="step-name">Parse Worker</span>
            <span class="step-detail">C++ DICOM parser compiled to WASM builds the HU volume.</span>
          </li>
          <li>
            <span class="step-name">Engine</span>
            <span class="step-detail">Renders the volume with WebGPU right away.</span>
          </li>
          <li>
            <span class="step-name">Inference Worker</span>
            <span class="step-detail">Segments slices in parallel and streams the mask to the engine.</span>
          </li>
        </ol>
      </section>

      <section class="stack" aria-labelledby="stack-title">
        <h2 id="stack-title">Built with</h2>
        <ul class="stack-list">
          <li><strong>WebGPU</strong> volume raymarching</li>
          <li><strong>C++20</strong> engine compiled to WASM with Emscripten</li>
          <li><strong>Slang</strong> shaders cross-compiled to WGSL</li>
          <li><strong>ONNX Runtime Web</strong> for on-device inference</li>
        </ul>
      </section>
    </main>

    <footer class="site-footer">
      <p class="disclaimer">
        OmniMed3D is research prototype software. It is not a certified clinical device and is not for diagnostic
        use.
      </p>
      <p>
        Demo data: LIDC-IDRI (CC BY 3.0) and UPENN-GBM (CC BY 4.0), both from The Cancer Imaging Archive. Full
        citations are shown in the viewer's demo panel.
      </p>
      <p>
        <a href="https://github.com/OmniMed3D/omnimed3d">Source on GitHub</a> ·
        <a href="https://github.com/OmniMed3D/omnimed3d/blob/main/LICENSE">Apache License 2.0</a>
      </p>
    </footer>

    <script type="module" src="./landing.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: Write the landing script**

`viewer/src/shell/landing.ts`:

```ts
/**
 * Landing page behavior (viewer/src/shell/index.html):
 * - Clips start only while on screen, so a phone visitor doesn't pull
 *   ~28 MB of video they never scroll to. With prefers-reduced-motion they
 *   never autoplay; the poster stays and native controls appear instead.
 * - A browser without WebGPU gets a plain-language notice next to the demo
 *   CTA, rather than discovering it inside the viewer.
 */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const clips = Array.from(document.querySelectorAll<HTMLVideoElement>("video.clip"));

function playIfAllowed(video: HTMLVideoElement): void {
  if (reducedMotion.matches) {
    return;
  }
  // Rejects when the clip is missing or autoplay is blocked -- either way
  // the poster is still showing, so offer controls and move on.
  video.play().catch(() => {
    video.controls = true;
  });
}

function applyMotionPreference(): void {
  for (const video of clips) {
    video.controls = reducedMotion.matches;
    if (reducedMotion.matches) {
      video.pause();
    }
  }
}

applyMotionPreference();
reducedMotion.addEventListener("change", applyMotionPreference);

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const video = entry.target as HTMLVideoElement;
      if (entry.isIntersecting) {
        playIfAllowed(video);
      } else {
        video.pause();
      }
    }
  },
  { threshold: 0.25 },
);
clips.forEach((video) => observer.observe(video));

if (!(navigator as Navigator & { gpu?: unknown }).gpu) {
  document.getElementById("webgpu-warning")?.removeAttribute("hidden");
}
```

- [ ] **Step 5: Write the landing styles**

`viewer/src/shell/landing.css`:

```css
/* Landing page (index.html). Separate from the viewer's style.css on
   purpose -- the viewer's tokens are tuned for a control panel floating
   over a diagnostic render; this page is long-form reading. Colors reuse
   the viewer's teal accent family so the hand-off into /app/ feels like
   the same product. Dark only, matching the viewer. */

:root {
  --bg: #0a0c10;
  --surface: #121a19;
  --border: rgba(255, 255, 255, 0.1);
  --text: #e6e9ef;
  --text-muted: #a7b5b1;
  --accent: #1d5c56;
  --accent-bright: #4fb8ab;
  --warning: #e0b15c;
  --radius: 10px;
  --font-ui: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --gutter: 16px;
  --max-width: 1120px;
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 1rem;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

a {
  color: var(--accent-bright);
}

h1,
h2 {
  line-height: 1.2;
  margin: 0 0 0.5em;
  text-wrap: balance;
}

h1 {
  font-size: clamp(2rem, 1.4rem + 2.6vw, 3.25rem);
  letter-spacing: -0.02em;
}

h2 {
  font-size: clamp(1.25rem, 1.1rem + 0.6vw, 1.6rem);
}

p {
  margin: 0 0 1em;
}

main,
.site-header,
.site-footer {
  width: 100%;
  max-width: var(--max-width);
  margin-inline: auto;
  padding-inline: var(--gutter);
}

.site-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-block: 20px;
}

.wordmark {
  font-family: var(--font-mono);
  font-weight: 500;
  letter-spacing: 0.02em;
}

.header-link {
  color: var(--text-muted);
  text-decoration: none;
  padding: 10px 4px;
}

.header-link:hover {
  color: var(--text);
}

section {
  padding-block: clamp(40px, 6vw, 88px);
}

.hero {
  display: grid;
  gap: 32px;
  align-items: center;
  padding-top: 24px;
}

.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--accent-bright);
  margin-bottom: 0.75em;
}

.lede {
  font-size: 1.125rem;
  color: var(--text-muted);
  max-width: 34em;
}

.cta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 28px 0 16px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 0 22px;
  border-radius: var(--radius);
  font-weight: 600;
  text-decoration: none;
  border: 1px solid transparent;
}

.btn-primary {
  background: var(--accent-bright);
  color: #06201d;
}

.btn-primary:hover {
  background: #6cc9bd;
}

.btn-secondary {
  border-color: var(--border);
  color: var(--text);
}

.btn-secondary:hover {
  border-color: var(--text-muted);
}

.btn:focus-visible,
.header-link:focus-visible,
.site-footer a:focus-visible {
  outline: 2px solid var(--accent-bright);
  outline-offset: 3px;
}

.cta-note {
  font-size: 0.9rem;
  color: var(--text-muted);
  max-width: 34em;
}

.webgpu-warning {
  font-size: 0.9rem;
  color: var(--warning);
  border-left: 3px solid var(--warning);
  padding-left: 12px;
}

figure {
  margin: 0;
}

.clip {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

figcaption {
  margin-top: 10px;
  font-size: 0.85rem;
  color: var(--text-muted);
}

.values {
  display: grid;
  gap: 24px;
  border-top: 1px solid var(--border);
}

.value h2 {
  font-size: 1.15rem;
}

.value p {
  color: var(--text-muted);
  margin: 0;
}

.feature {
  display: grid;
  gap: 32px;
  align-items: center;
  border-top: 1px solid var(--border);
}

.feature-copy p {
  color: var(--text-muted);
  max-width: 34em;
}

.pipeline,
.stack {
  border-top: 1px solid var(--border);
}

.steps {
  list-style: none;
  counter-reset: step;
  display: grid;
  gap: 12px;
  margin: 24px 0 0;
  padding: 0;
}

.steps li {
  counter-increment: step;
  display: grid;
  gap: 4px;
  padding: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.steps li::before {
  content: counter(step, decimal-leading-zero);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--accent-bright);
}

.step-name {
  font-weight: 600;
}

.step-detail {
  color: var(--text-muted);
  font-size: 0.95rem;
}

.stack-list {
  display: grid;
  gap: 10px;
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
  color: var(--text-muted);
}

.stack-list strong {
  color: var(--text);
}

.site-footer {
  border-top: 1px solid var(--border);
  padding-block: 32px 48px;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.disclaimer {
  color: var(--text);
}

@media (min-width: 720px) {
  .values {
    grid-template-columns: repeat(3, 1fr);
  }

  .steps {
    grid-template-columns: repeat(4, 1fr);
  }

  .stack-list {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (min-width: 960px) {
  .hero {
    grid-template-columns: 5fr 6fr;
    gap: 48px;
  }

  .feature {
    grid-template-columns: 6fr 5fr;
    gap: 48px;
  }
}
```

- [ ] **Step 6: Run the landing tests**

Run: `cd viewer && npx playwright test tests/e2e/landing.spec.ts`
Expected: all PASS.

- [ ] **Step 7: Look at it**

Run `npm run dev`, open `http://localhost:5173/` at desktop width and at 375 px (DevTools device mode). Check: hero clip plays, the segmentation clip starts only when scrolled into view, "Open the demo" lands in the viewer with LIDC-IDRI-0001 loading, text is readable, no element touches the screen edge. Take screenshots of both widths for the PR.

- [ ] **Step 8: Commit (after the user's explicit go-ahead)**

```bash
git add viewer/src/shell/index.html viewer/src/shell/landing.css viewer/src/shell/landing.ts viewer/tests/e2e/landing.spec.ts
```
Message: `feat: add the OmniMed3D landing page`

---

### Task 5: Root README and full verification

**Files:**
- Modify: `README.md` (getting-started section near lines 190–230)

- [ ] **Step 1: Document the two routes in the root README**

In `README.md`'s getting-started section, right after the `npm run dev` instructions, add:

```markdown
The dev server serves the landing page at `/` and the viewer at `/app/`.
`/app/?demo=LIDC-IDRI-0001` opens the viewer with that demo series
loading.
```

- [ ] **Step 2: Run the full verification suite**

```bash
cd viewer
npm run typecheck
npm test
npm run test:e2e
npm run build
ls dist/index.html dist/app/index.html
```
Expected: typecheck and unit tests pass; every e2e passes (same count as before this branch plus the new landing and autoload specs); both HTML files exist. If any pre-existing e2e fails, check first whether it also fails on `main` before changing anything.

- [ ] **Step 3: Check deploy-size constraints on the built output**

Run: `cd viewer && npm run sync-landing-media && npm run build && find dist -type f -size +25M`
Expected: only `dist/models/*.onnx` and `dist/assets/ort-wasm-simd-threaded.jsep-*.wasm` (both already stripped by `deploy.yml`) — no `media/` file.

- [ ] **Step 4: Commit (after the user's explicit go-ahead), then ask separately before pushing and opening the PR**

```bash
git add README.md
```
Message: `docs: document the landing page and viewer routes`
