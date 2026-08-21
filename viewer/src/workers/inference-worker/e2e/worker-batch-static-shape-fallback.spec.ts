import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Regression test for a real bug found while verifying Issue #24
 * (batched inference) against viewer/tests/e2e/shell-mask-integration.spec.ts
 * (Engine-owned): that test's dummy plumbing model
 * (tests/fixtures/generate-dummy-onnx.py) has a statically-fixed batch=1
 * input shape, not a dynamic batch axis like the real lungmask exports
 * (confirmed directly -- the generator script has no `dynamic_axes` at
 * all). Sending a burst of hu-slice messages made worker.ts's
 * accumulate-and-flush logic try a real batched session.run() call,
 * which threw immediately for this model -- and the batch's own
 * `.catch()` silently swallowed the entire failed batch, producing zero
 * mask-slice messages for all of it.
 *
 * Fixed by falling back to sequential per-slice processing (runSlice(),
 * not Promise.all -- concurrent session.run() calls are exactly what the
 * Issue #35 concurrency-hang fix exists to prevent) when a batched call
 * throws. This test keeps that path covered from AI-owned test infra
 * directly, not solely reliant on the Engine-owned Shell test noticing it
 * again if it regresses.
 */

const DUMMY_MODEL_PATH = fileURLToPath(new URL("../../../../tests/fixtures/dummy-lungmask.onnx", import.meta.url));

test("a burst of slices against a static-batch-shape model falls back to per-slice processing", async ({
  page,
}) => {
  await page.route("**/static-shape-check.onnx", (route) => route.fulfill({ path: DUMMY_MODEL_PATH }));

  await page.goto("/worker-harness.html");

  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      const w = window.__workerHarness!.worker;
      w.addEventListener("message", function ack(e: MessageEvent) {
        if (e.data.type === "init-complete") {
          w.removeEventListener("message", ack);
          resolve();
        }
      });
      w.postMessage({ type: "init", modelPath: "/static-shape-check.onnx" });
    });
  });

  const receivedCount = await page.evaluate(() => {
    return new Promise<number>((resolve) => {
      const w = window.__workerHarness!.worker;
      const width = 256;
      const height = 256;
      let received = 0;
      const sliceCount = 3;

      w.addEventListener("message", function onMsg(e: MessageEvent) {
        if (e.data.type === "mask-slice" && e.data.volumeId === "static-shape-test") {
          received++;
          if (received >= sliceCount) {
            w.removeEventListener("message", onMsg);
            resolve(received);
          }
        }
      });

      // Sent as a burst (no waiting between sends) so worker.ts's
      // accumulate-and-flush logic groups them into one batched call --
      // exactly the condition that triggered the original bug.
      for (let i = 0; i < sliceCount; i++) {
        const data = new Float32Array(width * height).buffer;
        w.postMessage(
          { type: "hu-slice", volumeId: "static-shape-test", sliceIndex: i, width, height, data },
          [data],
        );
      }

      setTimeout(() => resolve(received), 15_000); // don't hang forever if this regresses
    });
  });

  expect(receivedCount).toBe(3);
});
