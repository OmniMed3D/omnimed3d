import { expect, test } from "@playwright/test";

/**
 * Landing page at / and its hand-off into the viewer at /app/. See
 * docs/superpowers/specs/2026-10-07-landing-page-design.md.
 */

test("/app without a trailing slash opens the viewer, not the landing page", async ({ page }) => {
  await page.goto("/app");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });
});

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
  const posterResponse = page.waitForResponse((response) => response.url().endsWith("/landing/rendering-poster.jpg"));
  await page.goto("/");
  expect((await posterResponse).status()).toBe(200);
  await page.waitForTimeout(1000);

  const hero = page.locator(".hero-media video");
  const box = await hero.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(100);
  expect(await hero.evaluate((v: HTMLVideoElement) => v.poster)).toContain("/landing/rendering-poster.jpg");
  // A clip that can't load has nothing to play -- native controls would be
  // an inert play button over the poster.
  expect(await hero.evaluate((v: HTMLVideoElement) => v.controls)).toBe(false);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(pageErrors).toEqual([]);
});

test("turning reduced motion off restarts the clip already on screen", async ({ page }) => {
  // Counts play() calls rather than checking playback itself, so this
  // doesn't depend on the browser shipping an H.264 decoder (Playwright's
  // bundled Chromium doesn't).
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      this.dataset["playCalls"] = String(Number(this.dataset["playCalls"] ?? "0") + 1);
      return original.call(this);
    };
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const hero = page.locator(".hero-media video");
  await page.waitForTimeout(500);
  expect(await hero.getAttribute("data-play-calls")).toBeNull();

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(hero).toHaveAttribute("data-play-calls", "1");
  expect(await hero.evaluate((v: HTMLVideoElement) => v.controls)).toBe(false);
});

for (const path of ["/", "/app/"]) {
  test(`${path} loads without a 404 (favicon included)`, async ({ page }) => {
    const notFound: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 404) notFound.push(response.url());
    });
    await page.goto(path);
    await page.waitForLoadState("load");
    await page.waitForTimeout(1000);
    const favicon = await page.evaluate(
      () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? null,
    );
    expect(favicon).not.toBeNull();
    expect(notFound).toEqual([]);
  });
}

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

test("a browser that exposes WebGPU but has no adapter sees the notice", async ({ page }) => {
  await page.addInitScript(() => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (gpu) gpu.requestAdapter = () => Promise.resolve(null);
  });
  await page.goto("/");
  await expect(page.locator("#webgpu-warning")).toBeVisible();
});

test("the offline claim matches what the app actually does", async ({ page }) => {
  // No service worker exists, so the page must not promise that a later
  // visit works offline -- only that processing runs without a network.
  await page.goto("/");
  const values = page.locator(".values");
  await expect(values).not.toContainText("first visit");
  await expect(values).toContainText("no network connection");
});
