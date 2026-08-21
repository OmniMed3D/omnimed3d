/**
 * Instantiates the real `src/worker.ts` as an actual module Worker and
 * exposes it on `window` for e2e tests to drive via postMessage --
 * unlike bench.ts (which calls the adapter/session directly on the page's
 * main thread for latency measurement), this exercises worker.ts's own
 * `self.onmessage` protocol end-to-end, the same way the Shell's
 * `main.ts` does. Used by e2e/worker-fallback.spec.ts to verify the
 * WebGPU-session-failure fallback recovers correctly through the real
 * message protocol, not just the underlying logic in isolation.
 */
declare global {
  interface Window {
    __workerHarness?: { worker: Worker };
  }
}

const worker = new Worker(new URL("../src/worker.ts", import.meta.url), { type: "module" });
window.__workerHarness = { worker };
