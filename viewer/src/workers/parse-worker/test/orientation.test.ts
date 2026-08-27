import { describe, expect, it } from "vitest";
import {
  applyTransform,
  canonicalToSourceIndex,
  classifyAxis,
  computeObliqueResampleGrid,
  computeOrientationTransform,
  cross,
  dot,
  UnsupportedOrientationError,
  type ObliqueSeriesGeometry,
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

// Oblique-resample fallback: real neuro MR is routinely angled a few to
// ~20 degrees off axial. Uses a 30-degree in-plane rotation (row/column
// cosines rotated about Z, so the slice normal stays exactly Z) --
// hand-derived below, not taken from the code under test, same policy as
// the rest of this file.
describe("computeObliqueResampleGrid / canonicalToSourceIndex", () => {
  const COS30 = Math.sqrt(3) / 2; // 0.8660254...
  const SIN30 = 0.5;
  // row=[cos30,sin30,0], column=[-sin30,cos30,0] -- a 30-degree rotation
  // about Z, so neither cosine is axis-aligned (computeOrientationTransform
  // would reject this), but cross(row,column) is still exactly [0,0,1].
  const GEOMETRY: ObliqueSeriesGeometry = {
    row: [COS30, SIN30, 0],
    column: [-SIN30, COS30, 0],
    normal: [0, 0, 1],
    origin: [0, 0, 0],
    pixelSpacingRow: 1,
    pixelSpacingColumn: 1,
    sliceSpacing: 1,
  };

  it("computes the bounding-box grid for a 2x2x2 oblique source stack (hand-verified corners)", () => {
    // 8 corners of the unit cube rotated 30 degrees about Z: X ranges over
    // [-0.5, cos30] (width cos30+0.5 = 1.3660254), Y ranges over
    // [0, sin30+cos30] (height 1.3660254 too, by symmetry), Z is untouched
    // ([0, 1]). See this test file's own math, not the implementation.
    // Math.round(1.3660254) = 1 (rounds down, below the .5 threshold).
    const grid = computeObliqueResampleGrid(GEOMETRY, 2, 2, 2);

    expect(grid.columns).toBe(2); // round(1.3660254) + 1
    expect(grid.rows).toBe(2);
    expect(grid.depth).toBe(2); // round(1) + 1
    expect(grid.spacingX).toBe(1);
    expect(grid.spacingY).toBe(1);
    expect(grid.spacingZ).toBe(1);
    expect(grid.origin[0]).toBeCloseTo(-0.5, 6);
    expect(grid.origin[1]).toBeCloseTo(0, 6);
    expect(grid.origin[2]).toBeCloseTo(0, 6);
  });

  it("inverts the forward corner mapping back to the exact source index", () => {
    // Source corner (columnIndex=1, rowIndex=0, sliceIndex=0) in patient
    // space is exactly `row` itself (origin is [0,0,0], spacing is 1) --
    // hand-verified: dot(row, row) = cos30^2+sin30^2 = 1, dot(row, column)
    // = -cos30*sin30 + sin30*cos30 = 0.
    const patientPos: [number, number, number] = [COS30, SIN30, 0];
    const [rowIndex, columnIndex, sliceIndex] = canonicalToSourceIndex(patientPos, GEOMETRY);
    expect(rowIndex).toBeCloseTo(0, 6);
    expect(columnIndex).toBeCloseTo(1, 6);
    expect(sliceIndex).toBeCloseTo(0, 6);
  });

  it("round-trips an arbitrary output-grid voxel through the forward/inverse mapping", () => {
    const grid = computeObliqueResampleGrid(GEOMETRY, 4, 4, 3);
    const outCol = 2;
    const outRow = 3;
    const outSlice = 1;
    const patientPos: [number, number, number] = [
      grid.origin[0] + outCol * grid.spacingX,
      grid.origin[1] + outRow * grid.spacingY,
      grid.origin[2] + outSlice * grid.spacingZ,
    ];
    const [rowIndex, columnIndex, sliceIndex] = canonicalToSourceIndex(patientPos, GEOMETRY);

    // Forward-mapping that same source index should reproduce patientPos --
    // proves the two functions are consistent inverses of each other,
    // independent of any specific numeric expectation.
    const reconstructed: [number, number, number] = [
      GEOMETRY.origin[0] +
        columnIndex * GEOMETRY.pixelSpacingColumn * GEOMETRY.row[0] +
        rowIndex * GEOMETRY.pixelSpacingRow * GEOMETRY.column[0] +
        sliceIndex * GEOMETRY.sliceSpacing * GEOMETRY.normal[0],
      GEOMETRY.origin[1] +
        columnIndex * GEOMETRY.pixelSpacingColumn * GEOMETRY.row[1] +
        rowIndex * GEOMETRY.pixelSpacingRow * GEOMETRY.column[1] +
        sliceIndex * GEOMETRY.sliceSpacing * GEOMETRY.normal[1],
      GEOMETRY.origin[2] +
        columnIndex * GEOMETRY.pixelSpacingColumn * GEOMETRY.row[2] +
        rowIndex * GEOMETRY.pixelSpacingRow * GEOMETRY.column[2] +
        sliceIndex * GEOMETRY.sliceSpacing * GEOMETRY.normal[2],
    ];
    expect(reconstructed[0]).toBeCloseTo(patientPos[0], 6);
    expect(reconstructed[1]).toBeCloseTo(patientPos[1], 6);
    expect(reconstructed[2]).toBeCloseTo(patientPos[2], 6);
  });

  // A sagittal series' slice-stacking direction (normal) is ~X, not ~Z.
  // The 30-degree-about-Z case above never exercises this: its normal
  // stays exactly Z, so a fixed mapping (spacingX from pixelSpacingColumn,
  // spacingY from pixelSpacingRow, spacingZ from sliceSpacing) agrees with
  // the correct dominant-axis assignment by construction. A permuted
  // (sagittal/coronal-style) orientation with anisotropic spacing is the
  // case that actually distinguishes them, so this fixture uses
  // deliberately distinct spacings.
  it("assigns each output axis's spacing from whichever source direction actually dominates it (permuted/sagittal orientation)", () => {
    // Pure sagittal, no tilt: row=+Y, column=-Z, normal=cross(row,column)=-X.
    // computeOrientationTransform's fast path would reject this too (column
    // resolves to "z", disallowed even though both cosines are individually
    // axis-aligned) -- same dispatch path a real sagittal series takes.
    const geometry: ObliqueSeriesGeometry = {
      row: [0, 1, 0],
      column: [0, 0, -1],
      normal: [-1, 0, 0],
      origin: [0, 0, 0],
      pixelSpacingRow: 2.0, // governs the column direction (-Z) -- should end up as spacingZ
      pixelSpacingColumn: 0.5, // governs the row direction (+Y) -- should end up as spacingY
      sliceSpacing: 3.0, // governs the normal direction (-X) -- should end up as spacingX
    };
    const sourceRows = 4;
    const sourceColumns = 5;
    const sourceDepth = 6;

    const grid = computeObliqueResampleGrid(geometry, sourceRows, sourceColumns, sourceDepth);

    // Hand-verified (see this test's own math): with no tilt, each output
    // axis's voxel count exactly recovers whichever source dimension maps
    // to it via the correct dominant-axis spacing -- X count = sourceDepth
    // (normal -> X), Y count = sourceColumns (row -> Y), Z count =
    // sourceRows (column -> Z). The old fixed mapping would instead have
    // produced columns=31, rows=2, depth=3 -- wildly wrong.
    expect(grid.spacingX).toBe(3.0);
    expect(grid.spacingY).toBe(0.5);
    expect(grid.spacingZ).toBe(2.0);
    expect(grid.columns).toBe(sourceDepth);
    expect(grid.rows).toBe(sourceColumns);
    expect(grid.depth).toBe(sourceRows);
  });
});
