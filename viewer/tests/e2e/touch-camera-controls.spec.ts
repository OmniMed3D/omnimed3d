import { expect, test } from "@playwright/test";

/**
 * Regression test for issue #79: a real mobile-device test found camera
 * orbit simply didn't respond to a finger drag at all. Root cause was
 * cameraControls.ts listening for mousedown/mousemove/mouseup only --
 * those never fire for touch input, so nothing was broken so much as
 * never implemented for touch in the first place. Fixed by switching to
 * Pointer Events, which unify mouse/touch/pen.
 *
 * Dispatches synthetic PointerEvents with pointerType: "touch" directly
 * (Playwright has no built-in touch-drag API, unlike page.mouse.*) to
 * exercise the exact code path a real finger drag takes, and wraps the
 * real _engine_orbit_camera WASM export to confirm it's actually called
 * with nonzero deltas -- not just that no error was thrown.
 */

test("a touch drag on the canvas orbits the camera (issue #79)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await page.evaluate(() => {
    (window as unknown as { __orbitCalls: Array<[number, number]> }).__orbitCalls = [];
    const real = window.Module._engine_orbit_camera.bind(window.Module);
    window.Module._engine_orbit_camera = (dx: number, dy: number) => {
      (window as unknown as { __orbitCalls: Array<[number, number]> }).__orbitCalls.push([dx, dy]);
      return real(dx, dy);
    };
  });

  const box = (await page.locator("#canvas").boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.evaluate(
    ({ startX, startY }) => {
      const canvas = document.getElementById("canvas")!;
      const fire = (type: string, x: number, y: number, target: EventTarget = canvas) => {
        target.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            pointerType: "touch",
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      fire("pointerdown", startX, startY);
      fire("pointermove", startX + 40, startY + 20, window);
      fire("pointermove", startX + 70, startY + 35, window);
      fire("pointerup", startX + 70, startY + 35, window);
    },
    { startX, startY },
  );

  const orbitCalls = await page.evaluate(
    () => (window as unknown as { __orbitCalls: Array<[number, number]> }).__orbitCalls,
  );
  // Two pointermove events -> two orbit calls, both with a nonzero
  // rightward/downward delta matching the synthetic drag direction above.
  expect(orbitCalls.length).toBe(2);
  for (const [dx, dy] of orbitCalls) {
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeGreaterThan(0);
  }
});

test("a second touch point mid-drag is ignored, not treated as a new drag (issue #79)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#shell-status")).toHaveText(/ready for input/, { timeout: 15000 });

  await page.evaluate(() => {
    (window as unknown as { __orbitCalls: Array<[number, number]> }).__orbitCalls = [];
    const real = window.Module._engine_orbit_camera.bind(window.Module);
    window.Module._engine_orbit_camera = (dx: number, dy: number) => {
      (window as unknown as { __orbitCalls: Array<[number, number]> }).__orbitCalls.push([dx, dy]);
      return real(dx, dy);
    };
  });

  const box = (await page.locator("#canvas").boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.evaluate(
    ({ startX, startY }) => {
      const canvas = document.getElementById("canvas")!;
      const fire = (type: string, id: number, x: number, y: number, target: EventTarget = canvas) => {
        target.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: "touch",
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      // First finger starts a drag.
      fire("pointerdown", 1, startX, startY);
      // A second finger touches down mid-drag -- should be ignored
      // entirely (no orbit call from its own pointerdown/pointermove).
      fire("pointerdown", 2, startX - 100, startY - 100);
      fire("pointermove", 2, startX - 50, startY - 50, window);
      // First finger continues moving -- still drives the camera.
      fire("pointermove", 1, startX + 40, startY + 20, window);
    },
    { startX, startY },
  );

  const orbitCalls = await page.evaluate(
    () => (window as unknown as { __orbitCalls: Array<[number, number]> }).__orbitCalls,
  );
  // Only the first pointer's move should have produced an orbit call.
  expect(orbitCalls.length).toBe(1);
});
