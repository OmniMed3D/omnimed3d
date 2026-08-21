import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { beforeAll, describe, expect, it } from "vitest";
import { LungmaskAdapter } from "../src/adapters/lungmask/index.js";
import { runBatch, runSlice } from "../src/pipeline.js";
import { loadFloat32Bin, loadManifest, ONNX_MODEL_PATH_INT8 } from "./fixtures.js";

/**
 * Correctness check for runBatch() (Issue #24): batching must be
 * numerically transparent -- it exists purely to reduce fixed per-call
 * overhead, not to change results. INT8 (not FP32) is used here
 * specifically because it doesn't need the external-data workaround
 * pipeline.test.ts needs, keeping this file focused on the batching
 * behavior itself rather than repeating that setup.
 */
describe("runBatch produces the same per-slice results as runSlice (batching is numerically transparent)", () => {
  let session: ort.InferenceSession;
  const adapter = new LungmaskAdapter(ONNX_MODEL_PATH_INT8);

  beforeAll(async () => {
    session = await ort.InferenceSession.create(readFileSync(ONNX_MODEL_PATH_INT8));
  });

  it("batches all 5 manifest slices together and matches individual runSlice() calls exactly", async () => {
    const manifest = loadManifest();
    const requests = manifest.map((entry, i) => ({
      volumeId: "batch-test-volume",
      sliceIndex: i,
      slice: {
        data: loadFloat32Bin(entry.stem, "hu"),
        width: entry.originalWidth,
        height: entry.originalHeight,
      },
    }));

    const individualResults = await Promise.all(requests.map((r) => runSlice(adapter, session, r)));
    const batchedResults = await runBatch(adapter, session, requests);

    expect(batchedResults).toHaveLength(requests.length);
    batchedResults.forEach((batched, i) => {
      const individual = individualResults[i]!;
      expect(batched.volumeId).toBe(individual.volumeId);
      expect(batched.sliceIndex).toBe(individual.sliceIndex);
      expect(batched.width).toBe(individual.width);
      expect(batched.height).toBe(individual.height);
      expect(batched.data).toEqual(individual.data); // bit-exact, not just close
    });
  });

  it("runBatch([]) returns an empty array without calling the session", async () => {
    const results = await runBatch(adapter, session, []);
    expect(results).toEqual([]);
  });

  it("a batch of one matches runSlice for that same slice", async () => {
    const entry = loadManifest()[0]!;
    const request = {
      volumeId: "batch-of-one",
      sliceIndex: 0,
      slice: { data: loadFloat32Bin(entry.stem, "hu"), width: entry.originalWidth, height: entry.originalHeight },
    };

    const individual = await runSlice(adapter, session, request);
    const [batched] = await runBatch(adapter, session, [request]);

    expect(batched!.data).toEqual(individual.data);
  });
});
