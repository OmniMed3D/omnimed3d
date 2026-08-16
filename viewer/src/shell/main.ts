/**
 * Toolchain smoke test only -- not the real Web Application Shell (REQ-R06).
 * Proves Vite can bundle a Worker entry point that lives in a sibling npm
 * workspace package (parse-worker/inference-worker), which is the concrete
 * risk the Vite + npm workspaces decision (issue #21, PRD §6.1) needed to
 * de-risk before Epic 6 Step 2 / REQ-C02 can start (both need a real
 * browser build to exist first). Neither Worker is driven with real
 * messages here -- constructing them is enough to prove the bundler
 * resolves the cross-package entry.
 */
const parseWorker = new Worker(new URL("../workers/parse-worker/src/worker.ts", import.meta.url), {
  type: "module",
});
const inferenceWorker = new Worker(new URL("../workers/inference-worker/src/worker.ts", import.meta.url), {
  type: "module",
});

console.log("parseWorker constructed:", parseWorker);
console.log("inferenceWorker constructed:", inferenceWorker);

document.body.insertAdjacentHTML("beforeend", "<p>Both Workers constructed successfully -- see console.</p>");
