import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { beforeAll, describe, expect, it } from "vitest";
import { LungmaskAdapter } from "../src/adapters/lungmask/index.js";
import { runSlice } from "../src/pipeline.js";
import { ONNX_MODEL_PATH, loadManifest, loadFloat32Bin, loadUint8Bin } from "./fixtures.js";

describe("end-to-end pipeline vs Python reference (§5.3.2 mask-slice contract)", () => {
  let session: ort.InferenceSession;
  const adapter = new LungmaskAdapter(ONNX_MODEL_PATH);

  beforeAll(async () => {
    // onnxruntime-web's wasm backend can't auto-mount the model's external
    // weights file (browser-only fetch mechanism) when running under Node
    // for tests, so both files are read and passed in explicitly.
    const modelBuffer = readFileSync(ONNX_MODEL_PATH);
    const externalData = readFileSync(`${ONNX_MODEL_PATH}.data`);
    session = await ort.InferenceSession.create(modelBuffer, {
      externalData: [{ path: "lungmask_r231.onnx.data", data: externalData }],
    });
  });

  for (const entry of loadManifest()) {
    it(`argmax classes match Python reference for ${entry.stem}`, async () => {
      const hu = loadFloat32Bin(entry.stem, "hu");
      const referenceMask = loadUint8Bin(entry.stem, "mask");

      const message = await runSlice(adapter, session, {
        volumeId: "test-volume",
        sliceIndex: 0,
        slice: { data: hu, width: entry.originalWidth, height: entry.originalHeight },
      });

      // §5.3.2 mask-slice shape
      expect(message.type).toBe("mask-slice");
      expect(message.volumeId).toBe("test-volume");
      expect(message.width).toBe(entry.originalWidth);
      expect(message.height).toBe(entry.originalHeight);
      expect(message.data).toBeInstanceOf(Uint8Array);
      expect(message.data.length).toBe(entry.originalWidth * entry.originalHeight);

      let mismatches = 0;
      for (let i = 0; i < message.data.length; i++) {
        if (message.data[i] !== referenceMask[i]) mismatches++;
      }
      const mismatchRate = mismatches / message.data.length;
      expect(mismatchRate).toBeLessThan(0.01);
    });
  }
});
