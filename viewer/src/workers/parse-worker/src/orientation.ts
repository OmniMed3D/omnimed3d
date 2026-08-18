/**
 * Pure geometry: normalizes DICOM ImageOrientationPatient/ImagePositionPatient
 * (dicom-parser/README.md's "caller does the math" fields) into one
 * canonical pixel-data orientation, so `hu-slice`/`volume-ready` output
 * never depends on which of the several equally-valid DICOM row/column
 * conventions (HFS/FFS/HFP/FFP, etc.) a given file happened to use.
 *
 * Canonical convention (documented for the AI track in viewer/README.md):
 * column-index-increasing = patient Left (+X), row-index-increasing =
 * patient Posterior (+Y), slice-index-increasing = patient Superior (+Z)
 * -- i.e. LPS, matching common tooling like ITK's default.
 *
 * Scope: axial acquisitions only (slice normal must resolve to the Z
 * axis) -- matches this project's actual use case (lung CT, always
 * acquired axially) and REQ-R02's "axial cross-sectional volume
 * rendering" framing. Sagittal/coronal/oblique acquisitions are rejected
 * via UnsupportedOrientationError rather than silently mishandled.
 */

export type Axis = "x" | "y" | "z";
export type AxisSign = 1 | -1;
export type Vec3 = [number, number, number];

export interface ClassifiedAxis {
  axis: Axis;
  sign: AxisSign;
}

/** Tolerance for "is this vector axis-aligned" -- generous enough to absorb DS-string rounding in real files, tight enough to still reject a genuinely oblique cosine. */
const DEFAULT_EPSILON = 1e-3;

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Classifies a vector expected to be axis-aligned: which principal axis
 * it's closest to, and its sign relative to that axis. Returns null if
 * the vector isn't close to any single axis within `epsilon` -- the
 * oblique-rejection case.
 */
export function classifyAxis(vector: Vec3, epsilon = DEFAULT_EPSILON): ClassifiedAxis | null {
  const magnitude = Math.hypot(vector[0], vector[1], vector[2]);
  if (magnitude < epsilon) {
    return null;
  }
  const normalized: Vec3 = [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude];
  const candidates: { axis: Axis; value: number }[] = [
    { axis: "x", value: normalized[0] },
    { axis: "y", value: normalized[1] },
    { axis: "z", value: normalized[2] },
  ];

  let best = candidates[0] as { axis: Axis; value: number };
  for (const candidate of candidates) {
    if (Math.abs(candidate.value) > Math.abs(best.value)) {
      best = candidate;
    }
  }
  if (Math.abs(Math.abs(best.value) - 1) > epsilon) {
    return null; // dominant component isn't close enough to +-1 -- not axis-aligned
  }
  for (const candidate of candidates) {
    if (candidate.axis !== best.axis && Math.abs(candidate.value) > epsilon) {
      return null; // a supposedly-zero component is too large -- not axis-aligned
    }
  }
  return { axis: best.axis, sign: best.value >= 0 ? 1 : -1 };
}

export interface ImageOrientation {
  /** ImageOrientationPatient[0..2] -- direction cosine of the row (direction of travel as column index increases). */
  row: Vec3;
  /** ImageOrientationPatient[3..5] -- direction cosine of the column (direction of travel as row index increases). */
  column: Vec3;
}

export interface OrientationTransform {
  /** True when row/column need swapping (source row axis is Y, not X) before flips are applied. */
  transpose: boolean;
  flipRows: boolean;
  flipColumns: boolean;
  /** Raw slice normal = cross(row, column), for projecting ImagePositionPatient onto the slice-stacking axis. */
  normal: Vec3;
  /** Sign of normal's Z component. Combined with `normal` as dot(position, normal) * sliceAxisSign, ascending, this always sorts slice-index-increasing = Superior, regardless of row/column handedness. */
  sliceAxisSign: AxisSign;
}

export class UnsupportedOrientationError extends Error {
  constructor(reason: string) {
    super(`parse-worker: cannot normalize orientation -- ${reason}`);
  }
}

/**
 * Classifies row/column/normal against the patient axes and derives the
 * pixel-data transform needed to reach the canonical convention above.
 * Throws UnsupportedOrientationError for anything not axis-aligned
 * axial (oblique cosines, or a slice normal that isn't +-Z).
 */
export function computeOrientationTransform(orientation: ImageOrientation): OrientationTransform {
  const rowAxis = classifyAxis(orientation.row);
  const columnAxis = classifyAxis(orientation.column);
  if (!rowAxis || !columnAxis) {
    throw new UnsupportedOrientationError(
      "row/column direction cosines are not axis-aligned (oblique acquisition, not supported)",
    );
  }
  if (rowAxis.axis === "z" || columnAxis.axis === "z" || rowAxis.axis === columnAxis.axis) {
    throw new UnsupportedOrientationError(
      `row/column direction cosines must resolve to two distinct in-plane axes, got row=${rowAxis.axis}, column=${columnAxis.axis}`,
    );
  }

  const normal = cross(orientation.row, orientation.column);
  const normalAxis = classifyAxis(normal);
  if (!normalAxis || normalAxis.axis !== "z") {
    throw new UnsupportedOrientationError(
      "slice normal does not resolve to the patient Z axis (sagittal/coronal/oblique acquisitions are not supported -- axial only)",
    );
  }

  // rowAxis.axis === "y" means row/column are swapped relative to canonical
  // (row should drive +X, column should drive +Y) -- transpose first, then
  // flip whichever cosine ends up driving each output axis if its sign
  // doesn't already point the canonical direction. Because rowAxis/columnAxis
  // are always exactly {x, y} in some order (checked above), the vector
  // driving the output row index always classified to "y", and the one
  // driving the output column index always classified to "x" -- so its
  // .sign is already relative to the correct canonical target axis.
  const transpose = rowAxis.axis === "y";
  const rowDrivingSign = transpose ? rowAxis.sign : columnAxis.sign;
  const columnDrivingSign = transpose ? columnAxis.sign : rowAxis.sign;

  return {
    transpose,
    flipRows: rowDrivingSign === -1,
    flipColumns: columnDrivingSign === -1,
    normal,
    sliceAxisSign: normalAxis.sign,
  };
}

export interface TransformedGrid {
  data: Float32Array;
  rows: number;
  columns: number;
}

/** Reorders a row-major `rows`x`columns` grid per `transform`. Returns the input unchanged (no copy) when the transform is the identity. */
export function applyTransform(
  data: Float32Array,
  rows: number,
  columns: number,
  transform: OrientationTransform,
): TransformedGrid {
  const { transpose, flipRows, flipColumns } = transform;
  if (!transpose && !flipRows && !flipColumns) {
    return { data, rows, columns };
  }

  const outRows = transpose ? columns : rows;
  const outColumns = transpose ? rows : columns;
  const out = new Float32Array(rows * columns);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const value = data[r * columns + c] as number;
      let outR: number;
      let outC: number;
      if (transpose) {
        outR = flipRows ? columns - 1 - c : c;
        outC = flipColumns ? rows - 1 - r : r;
      } else {
        outR = flipRows ? rows - 1 - r : r;
        outC = flipColumns ? columns - 1 - c : c;
      }
      out[outR * outColumns + outC] = value;
    }
  }

  return { data: out, rows: outRows, columns: outColumns };
}
