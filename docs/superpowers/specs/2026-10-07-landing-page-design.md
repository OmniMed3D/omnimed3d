# Landing page — design

- **Date:** 2026-10-07
- **Status:** Draft, awaiting review
- **Module:** `viewer/` (Shell)
- **Branch:** `feat/viewer-landing-page`

## Goal

Give the deployed site a front door. Today the Cloudflare Pages deploy
(`.github/workflows/deploy.yml`) serves `viewer/dist` at `/`, so a first-time
visitor lands directly in an empty viewer with no explanation of what
OmniMed3D is. The landing page explains the product and gets the visitor into
a working demo in one click.

**Audience:** balanced. The first screen serves prospective users (clinicians,
researchers, students) with the value proposition and a one-click demo; lower
sections serve technical reviewers with how it works and what it's built on.

**Success criteria**

1. Visiting `/` shows the landing page; one click on the primary CTA opens the
   viewer with a demo CT series already loading.
2. Every existing viewer behavior and e2e test keeps working, now under `/app/`.
3. No change to `deploy.yml`, `_headers`, or anything under `infra/`.
4. The page is honest about being a research prototype, not a clinical device
   (`PRODUCT.md`, principle 5).

## Non-goals

- No UI framework, no new npm dependencies.
- No i18n — the page ships in English, matching the repo's public docs.
- No analytics, no forms, no external embeds (video is self-hosted).
- No changes to the engine or the AI inference pipeline.

## Routing and file layout

Vite multi-page build within the existing `viewer/` workspace (root stays
`src/shell`):

| URL      | Source                         | Notes                         |
|----------|--------------------------------|-------------------------------|
| `/`      | `src/shell/index.html` (new)   | Landing page                  |
| `/app/`  | `src/shell/app/index.html`     | Moved from `src/shell/index.html` |

- `vite.config.ts` registers both pages via `build.rollupOptions.input`.
- In the moved viewer HTML, only relative references (`./style.css`,
  `./main.ts`, …) change to `../`. Absolute runtime paths (`/engine/`,
  `/models/`, `/demo-ct/`) are unaffected by the move.
- Landing styles live in their own stylesheet (`src/shell/landing.css`); the
  viewer's `style.css` is not shared or modified for the landing page.
- `public/_headers` already applies COOP/COEP/CORP to `/*`. The landing page
  loads only same-origin assets plus Google Fonts (CORS-enabled, already used
  by the viewer), so it is compatible with `require-corp`.

## Page content

Top to bottom:

1. **Hero** — product name, one-line description (browser-only 3D medical
   imaging viewer with on-device AI segmentation), primary CTA **Open the
   demo** → `/app/?demo=LIDC-IDRI-0001`, secondary CTA **View on GitHub**. The
   rendering clip plays muted and looped beside or behind the copy.
2. **Three value props** — no install; nothing uploaded (data never leaves the
   device); works offline after the first load.
3. **On-device AI segmentation** — the segmentation clip, with the point that
   rendering is never blocked by inference: the volume renders immediately and
   the lung mask fills in progressively.
4. **How it works** — the Parse Worker → Engine / Inference Worker pipeline
   from the root README's diagram, rebuilt as responsive HTML steps (a row on
   wide screens, a vertical list on phones) rather than an SVG that would
   shrink its text below legibility at phone width.
5. **Built with** — WebGPU raymarching, a C++20 engine compiled to WASM, Slang
   shaders cross-compiled to WGSL, ONNX Runtime Web.
6. **Footer** —
   - Browser requirement: a WebGPU-capable Chrome (desktop or mobile).
   - Prototype disclaimer: research software, not a certified clinical
     device, not for diagnostic use.
   - Demo data attribution: LIDC-IDRI (CC BY 3.0) and UPENN-GBM (CC BY 4.0),
     both via TCIA, linking to the same citation text the viewer's demo panel
     carries (`test-data/lidc_idri/README.md`, `test-data/upenn_gbm/README.md`).
   - Link to the repository and the license.

Visual direction is settled during implementation against `PRODUCT.md`: dark
base suited to medical imaging, high contrast for bright ambient light, touch
targets sized for mobile, no visual overclaiming of clinical authority. The
page must work at phone width with no horizontal scroll.

## Demo media

- Source of truth stays at `docs/media/*.mp4` (Git LFS; 19.7 MB and 8.9 MB,
  both under Pages' ~25 MiB per-file limit).
- A new `viewer/scripts/sync-landing-media.mjs` copies them into
  `src/shell/public/media/` (gitignored), the same pattern as
  `sync-demo-ct.mjs`. It runs as part of the existing sync steps in local dev
  and in the deploy build, so no clip is stored twice in git.
  - The deploy workflow already runs `npm run sync-demo-ct`; to keep
    `deploy.yml` untouched, that npm script chains the media copy after the
    demo-series copy rather than adding a new workflow step.
  - The copy fails loudly on an un-pulled Git LFS pointer stub or on a clip
    over 25 MiB (the Pages per-file limit), instead of producing a deploy
    that silently breaks.
- Each `<video>` is `muted loop playsinline preload="none"` with a poster
  frame (a still extracted once and committed). A small script starts
  playback only while the clip is on screen, so mobile visitors don't
  download ~28 MB up front.
- `prefers-reduced-motion: reduce` disables autoplay; the poster and native
  controls remain.
- If the clips are missing (sync not run), the poster still renders and the
  page layout does not break.

## Viewer change: `?demo=<series-id>`

- `demoCtControls.ts` reads `demo` from `location.search` once at setup. If it
  matches a `[data-demo-ct-id]` button, it triggers that button's existing
  load path exactly as a click would.
- Unknown or empty values are ignored silently; the viewer behaves as it does
  today.
- No other viewer behavior changes.

## Testing

- **Existing e2e (Playwright):** every `page.goto("/…")` across the 20 files
  in `viewer/tests/e2e/` becomes `page.goto("/app/…")`, preserving query
  strings. A mechanical replacement, reviewed in the diff.
- **New e2e:**
  1. Landing renders; the primary CTA's `href` is
     `/app/?demo=LIDC-IDRI-0001`; the GitHub link is present.
  2. At 375 px viewport width the landing page has no horizontal overflow.
  3. `/app/?demo=LIDC-IDRI-0001` starts loading that series without a click.
- **Regression:** `npm run typecheck`, `npm test`, `npm run test:e2e` all pass.
  `npm run build` emits both `dist/index.html` and `dist/app/index.html`.

## Docs

- Root `README.md` and `viewer/README.md`: local dev URLs move to `/app/`;
  mention the landing page at `/`.

## Edge cases

| Case | Handling |
|------|----------|
| Browser without WebGPU | Landing still renders fully (no WebGPU use). The browser requirement is stated in the footer and near the CTA; the viewer's existing error handling applies after the click. |
| Old bookmarks to `/` expecting the viewer | They now land on the landing page, one click from the viewer. No redirect needed. |
| `?debug=1` and other viewer query params | Still work under `/app/`. |
| Demo assets not synced in local dev | The `?demo=` load reports the viewer's existing load error; the landing page is unaffected. |
