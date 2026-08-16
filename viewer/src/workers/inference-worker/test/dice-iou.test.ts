import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { beforeAll, describe, expect, it } from "vitest";
import { LungmaskAdapter } from "../src/adapters/lungmask/index.js";
import { runSlice } from "../src/pipeline.js";
import {
  ONNX_MODEL_PATH,
  ONNX_MODEL_PATH_FP16,
  ONNX_MODEL_PATH_INT8,
  loadGroundTruthFloat32Bin,
  loadGroundTruthManifest,
  loadGroundTruthUint8Bin,
} from "./fixtures.js";

/**
 * REQ-A10: segmentation *quality*, not pipeline correctness -- a different
 * question from the other test files here. Ground truth is the raw PyTorch
 * lungmask model (scripts/export_ground_truth_masks.py), run independently
 * of our ONNX/TS chain rather than reusing anything already parity-checked
 * elsewhere. Deliberately does NOT include lungmask's own connected-
 * component postprocessing cleanup (utils.postprocessing) -- our
 * postprocess.ts doesn't implement that step either (REQ-A17 only covers
 * argmax + NN upscale), so comparing against the un-cleaned raw output is
 * the correct apples-to-apples ground truth for what this pipeline actually
 * claims to do.
 *
 * For context (not reproduced here, cite the primary source directly if
 * quoting a number): the original R231 paper (Hofmanninger et al. 2020,
 * "Automatic lung segmentation in routine imaging is primarily a data
 * diversity problem, not a methodology problem") reports Dice scores in the
 * ~0.97-0.98 range on their own test data -- a useful sanity anchor, not
 * something this test reproduces (different test set, different metric
 * target: this measures *our pipeline's* fidelity to the reference model,
 * not the reference model's own accuracy).
 */
const LUNG_CLASSES = [
  { id: 1, label: "right lung" },
  { id: 2, label: "left lung" },
] as const;

interface SliceScore {
  stem: string;
  classId: number;
  dice: number;
  iou: number;
}

function diceAndIou(predicted: Uint8Array, groundTruth: Uint8Array, classId: number): { dice: number; iou: number } | null {
  let intersection = 0;
  let predCount = 0;
  let gtCount = 0;
  for (let i = 0; i < predicted.length; i++) {
    const p = predicted[i] === classId;
    const g = groundTruth[i] === classId;
    if (p && g) intersection++;
    if (p) predCount++;
    if (g) gtCount++;
  }
  const union = predCount + gtCount - intersection;
  if (union === 0) return null; // class absent from both -- not informative, exclude
  return {
    dice: (2 * intersection) / (predCount + gtCount),
    iou: intersection / union,
  };
}

function summarize(values: number[]): { mean: number; median: number; min: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
  return { mean, median, min: sorted[0] as number };
}

describe("segmentation quality: Dice/IoU vs raw PyTorch ground truth (REQ-A10)", () => {
  const manifest = loadGroundTruthManifest();

  it.each([
    { label: "FP32", modelPath: ONNX_MODEL_PATH, hasExternalData: true },
    { label: "INT8", modelPath: ONNX_MODEL_PATH_INT8, hasExternalData: false },
    { label: "FP16", modelPath: ONNX_MODEL_PATH_FP16, hasExternalData: false },
  ])("$label", async ({ label, modelPath, hasExternalData }) => {
    const adapter = new LungmaskAdapter(modelPath);
    const modelBuffer = readFileSync(modelPath);
    const session = hasExternalData
      ? await ort.InferenceSession.create(modelBuffer, {
          externalData: [{ path: "lungmask_r231.onnx.data", data: readFileSync(`${modelPath}.data`) }],
        })
      : await ort.InferenceSession.create(modelBuffer);

    const scores: SliceScore[] = [];
    for (const entry of manifest) {
      const hu = loadGroundTruthFloat32Bin(entry.stem, "hu");
      const groundTruth = loadGroundTruthUint8Bin(entry.stem, "groundtruth");

      const message = await runSlice(adapter, session, {
        volumeId: "dice-iou-eval",
        sliceIndex: 0,
        slice: { data: hu, width: entry.originalWidth, height: entry.originalHeight },
      });

      for (const { id: classId } of LUNG_CLASSES) {
        const result = diceAndIou(message.data, groundTruth, classId);
        if (result) scores.push({ stem: entry.stem, classId, ...result });
      }
    }

    console.log(`\n[${label}] per-class summary (n=${manifest.length} slices):`);
    console.table(
      LUNG_CLASSES.map(({ id, label: classLabel }) => {
        const classScores = scores.filter((s) => s.classId === id);
        const dice = summarize(classScores.map((s) => s.dice));
        const iou = summarize(classScores.map((s) => s.iou));
        return {
          class: classLabel,
          "Dice mean": dice.mean.toFixed(4),
          "Dice median": dice.median.toFixed(4),
          "Dice min": dice.min.toFixed(4),
          "IoU mean": iou.mean.toFixed(4),
          "IoU min": iou.min.toFixed(4),
          n: classScores.length,
        };
      }),
    );

    // Generous sanity floor -- catches a broken pipeline, not a stand-in
    // for the (currently undecided, PRD 10.2) clinical accuracy threshold.
    for (const s of scores) {
      expect(s.dice, `${label} ${s.stem} class ${s.classId}`).toBeGreaterThan(0.5);
    }
  });
});
