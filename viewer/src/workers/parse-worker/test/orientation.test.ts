import { describe, expect, it } from "vitest";
import {
  applyTransform,
  classifyAxis,
  computeOrientationTransform,
  cross,
  dot,
  UnsupportedOrientationError,
} from "../src/orientation.js";

describe("cross / dot", () => {
  it("computes the standard basis cross products", () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(cross([0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1]);
  });

  it("computes a dot product", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
});

describe("classifyAxis", () => {
  it("classifies exact axis-aligned unit vectors", () => {
    expect(classifyAxis([1, 0, 0])).toEqual({ axis: "x", sign: 1 });
    expect(classifyAxis([-1, 0, 0])).toEqual({ axis: "x", sign: -1 });
    expect(classifyAxis([0, 1, 0])).toEqual({ axis: "y", sign: 1 });
    expect(classifyAxis([0, -1, 0])).toEqual({ axis: "y", sign: -1 });
    expect(classifyAxis([0, 0, 1])).toEqual({ axis: "z", sign: 1 });
    expect(classifyAxis([0, 0, -1])).toEqual({ axis: "z", sign: -1 });
  });

  it("rejects a 45-degree oblique vector", () => {
    expect(classifyAxis([Math.SQRT1_2, Math.SQRT1_2, 0])).toBeNull();
  });

  it("rejects a zero (degenerate) vector", () => {
    expect(classifyAxis([0, 0, 0])).toBeNull();
  });

  it("accepts small DS-string-rounding-scale deviation within the default tolerance", () => {
    expect(classifyAxis([0.9999, 0.0001, 0])).toEqual({ axis: "x", sign: 1 });
  });
});

describe("computeOrientationTransform", () => {
  it("is the identity for the canonical orientation (matches CT_small.dcm's real, already-canonical tags)", () => {
    const transform = computeOrientationTransform({ row: [1, 0, 0], column: [0, 1, 0] });
    expect(transform.transpose).toBe(false);
    expect(transform.flipRows).toBe(false);
    expect(transform.flipColumns).toBe(false);
    expect(transform.normal).toEqual([0, 0, 1]);
    expect(transform.sliceAxisSign).toBe(1);
  });

  it("flips rows only when the column cosine points -Y", () => {
    const transform = computeOrientationTransform({ row: [1, 0, 0], column: [0, -1, 0] });
    expect(transform).toMatchObject({ transpose: false, flipRows: true, flipColumns: false });
  });

  it("flips columns only when the row cosine points -X", () => {
    const transform = computeOrientationTransform({ row: [-1, 0, 0], column: [0, 1, 0] });
    expect(transform).toMatchObject({ transpose: false, flipRows: false, flipColumns: true });
  });

  it("transposes (no flips) when row/column axes are swapped but both point canonical-positive", () => {
    const transform = computeOrientationTransform({ row: [0, 1, 0], column: [1, 0, 0] });
    expect(transform).toMatchObject({ transpose: true, flipRows: false, flipColumns: false });
  });

  it("transposes and flips both axes for a combined case", () => {
    const transform = computeOrientationTransform({ row: [0, -1, 0], column: [-1, 0, 0] });
    expect(transform).toMatchObject({ transpose: true, flipRows: true, flipColumns: true });
  });

  it("rejects an oblique row cosine", () => {
    expect(() => computeOrientationTransform({ row: [Math.SQRT1_2, Math.SQRT1_2, 0], column: [0, 0, 1] })).toThrow(
      UnsupportedOrientationError,
    );
  });

  it("rejects a sagittal/coronal-style orientation (column cosine along Z)", () => {
    expect(() => computeOrientationTransform({ row: [0, 1, 0], column: [0, 0, 1] })).toThrow(
      UnsupportedOrientationError,
    );
  });

  it("rejects degenerate row/column cosines that resolve to the same axis", () => {
    expect(() => computeOrientationTransform({ row: [1, 0, 0], column: [1, 0, 0] })).toThrow(
      UnsupportedOrientationError,
    );
  });
});

describe("applyTransform", () => {
  const GRID: number[] = [1, 2, 3, 4, 5, 6]; // 2 rows x 3 columns: [[1,2,3],[4,5,6]]

  it("returns the same array reference (no copy) for the identity transform", () => {
    const data = new Float32Array(GRID);
    const identity = computeOrientationTransform({ row: [1, 0, 0], column: [0, 1, 0] });
    const result = applyTransform(data, 2, 3, identity);
    expect(result.data).toBe(data);
    expect(result.rows).toBe(2);
    expect(result.columns).toBe(3);
  });

  it("applies a 180-degree flip (flipRows + flipColumns, no transpose)", () => {
    const data = new Float32Array(GRID);
    const transform = computeOrientationTransform({ row: [-1, 0, 0], column: [0, -1, 0] });
    const result = applyTransform(data, 2, 3, transform);
    expect(result.rows).toBe(2);
    expect(result.columns).toBe(3);
    expect(Array.from(result.data)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("applies a pure transpose (no flips)", () => {
    const data = new Float32Array(GRID);
    const transform = computeOrientationTransform({ row: [0, 1, 0], column: [1, 0, 0] });
    const result = applyTransform(data, 2, 3, transform);
    expect(result.rows).toBe(3);
    expect(result.columns).toBe(2);
    expect(Array.from(result.data)).toEqual([1, 4, 2, 5, 3, 6]);
  });

  it("applies a combined transpose + both flips", () => {
    const data = new Float32Array(GRID);
    const transform = computeOrientationTransform({ row: [0, -1, 0], column: [-1, 0, 0] });
    const result = applyTransform(data, 2, 3, transform);
    expect(result.rows).toBe(3);
    expect(result.columns).toBe(2);
    expect(Array.from(result.data)).toEqual([6, 3, 5, 2, 4, 1]);
  });
});
