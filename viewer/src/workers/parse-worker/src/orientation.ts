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
 * Scope: `computeOrientationTransform`'s fast path only handles
 * acquisitions whose row/column cosines are already axis-aligned --
 * matches this project's original use case (lung CT, always acquired
 * axially) and REQ-R02's "axial cross-sectional volume rendering"
 * framing. It rejects anything else (sagittal/coronal/oblique) via
 * UnsupportedOrientationError rather than silently mishandling it.
 *
 * Oblique fallback (2026-08-27, bug report: UPENN-GBM brain MR series
 * failed to load -- real neuro MR is routinely angled a few to ~20
 * degrees off axial to align with the AC-PC line, which every series in
 * that dataset hits): `computeObliqueResampleGrid`/`canonicalToSourceIndex`
 * below let pipeline.ts's `assembleSeries` resample a genuinely oblique
 * series onto a canonical-axis-aligned grid via trilinear interpolation,
 * instead of rejecting it outright. This module stays pure geometry --
 * the actual pixel resampling loop (which needs the HU data these
 * functions don't touch) lives in pipeline.ts.
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

/**
 * Shared geometry for one oblique series -- row/column/normal are the
 * (assumed mutually consistent, checked by the caller) direction cosines
 * for every slice in the series, since a single physical acquisition has
 * one orientation. `origin` is the geometrically-first slice's
 * ImagePositionPatient (ascending along `normal`, same ordering
 * pipeline.ts already uses for the axis-aligned path).
 */
export interface ObliqueSeriesGeometry {
  row: Vec3;
  column: Vec3;
  /** unit vector, cross(row, column) -- row/column are already orthonormal per DICOM PS3.3 C.7.6.2.1.1, so this is too. */
  normal: Vec3;
  origin: Vec3;
  pixelSpacingRow: number;
  pixelSpacingColumn: number;
  /** average physical distance between consecutive slices along `normal`. */
  sliceSpacing: number;
}

export interface ResampleGrid {
  rows: number;
  columns: number;
  depth: number;
  /** output voxel spacing along canonical X (Left) / Y (Posterior) / Z (Superior) -- see computeObliqueResampleGrid's own comment for how this is derived; NOT simply pixelSpacingColumn/pixelSpacingRow/sliceSpacing in that fixed order except in the near-axial-tilt case. */
  spacingX: number;
  spacingY: number;
  spacingZ: number;
  /** canonical LPS position of output voxel (row=0, column=0, slice=0). */
  origin: Vec3;
}

/**
 * Index (0=X, 1=Y, 2=Z) of `v`'s largest-magnitude component -- which
 * canonical axis a direction vector most nearly points along. Unlike
 * classifyAxis (orientation.ts's axis-aligned fast-path check), this
 * never returns null: it's used to decide which of the *source*
 * geometry's three spacings (pixelSpacingColumn along `row`,
 * pixelSpacingRow along `column`, sliceSpacing along `normal`) governs
 * movement along each *output* canonical axis, and that assignment must
 * exist even when the acquisition is permuted (sagittal/coronal, where
 * none of row/column/normal is Z) or genuinely oblique.
 */
function dominantAxisIndex(v: Vec3): 0 | 1 | 2 {
  const ax = Math.abs(v[0]);
  const ay = Math.abs(v[1]);
  const az = Math.abs(v[2]);
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}

/**
 * Computes the canonical-axis-aligned output grid that fully contains an
 * oblique source stack's physical extent -- the bounding box of all 8
 * corners of the source volume, projected onto the canonical LPS axes
 * (which are already the raw patient-space axes ImagePositionPatient
 * itself is expressed in, so "projected onto" is just taking min/max of
 * each corner's X/Y/Z component directly, no extra rotation needed).
 *
 * Output spacing per canonical axis (bug fix, 2026-08-27, follow-up to
 * the UPENN-GBM report -- a *sagittal* series, T2 SAG SPACE, from the
 * same dataset, whose slice-stacking direction is ~X, not ~Z): each
 * output axis's step size must come from whichever of the source's three
 * spacings (pixelSpacingColumn along `row`, pixelSpacingRow along
 * `column`, sliceSpacing along `normal`) actually governs movement along
 * that physical direction -- not a fixed "spacingX always comes from
 * pixelSpacingColumn" mapping, which is only correct by coincidence when
 * `row`/`column`/`normal` already happen to point roughly along
 * X/Y/Z respectively (the near-axial-tilt case this function was
 * originally written and tested against). For a 90-degree-permuted
 * acquisition (sagittal/coronal) that assumption silently mislabels which
 * spacing applies to which output axis; it only produced a visually
 * correct result for the UPENN-GBM sagittal series by luck, because that
 * particular "SPACE" sequence happens to be near-isotropic (~0.9mm in all
 * three directions) -- see the sagittal-with-anisotropic-spacing test in
 * orientation.test.ts for a case that would have visibly failed under the
 * old fixed mapping.
 */
export function computeObliqueResampleGrid(
  geometry: ObliqueSeriesGeometry,
  sourceRows: number,
  sourceColumns: number,
  sourceDepth: number,
): ResampleGrid {
  const { row, column, normal, origin, pixelSpacingRow, pixelSpacingColumn, sliceSpacing } = geometry;

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const colFrac of [0, sourceColumns - 1]) {
    for (const rowFrac of [0, sourceRows - 1]) {
      for (const sliceFrac of [0, sourceDepth - 1]) {
        for (let axis = 0; axis < 3; axis++) {
          const corner =
            (origin[axis] as number) +
            colFrac * pixelSpacingColumn * (row[axis] as number) +
            rowFrac * pixelSpacingRow * (column[axis] as number) +
            sliceFrac * sliceSpacing * (normal[axis] as number);
          min[axis] = Math.min(min[axis] as number, corner);
          max[axis] = Math.max(max[axis] as number, corner);
        }
      }
    }
  }

  // Assign each source spacing to whichever output axis its own direction
  // vector dominates. row/column/normal are mutually orthonormal, so for
  // any axis-permuted (or near-axial-tilt) acquisition this fills all
  // three output slots exactly once; a collision (two source directions
  // dominating the same output axis) only happens for a genuinely
  // ambiguous ~45-degree-tie geometry, which real acquisitions don't
  // produce -- fail loudly rather than silently pick one arbitrarily.
  const axisSpacing: [number | undefined, number | undefined, number | undefined] = [undefined, undefined, undefined];
  const assign = (direction: Vec3, spacing: number, label: string) => {
    const axis = dominantAxisIndex(direction);
    if (axisSpacing[axis] !== undefined) {
      throw new Error(
        `computeObliqueResampleGrid: ambiguous orientation -- both a previous direction and ${label} dominate the same output axis (${axis})`,
      );
    }
    axisSpacing[axis] = spacing;
  };
  assign(row, pixelSpacingColumn, "row");
  assign(column, pixelSpacingRow, "column");
  assign(normal, sliceSpacing, "normal");

  const spacingX = axisSpacing[0] as number;
  const spacingY = axisSpacing[1] as number;
  const spacingZ = axisSpacing[2] as number;

  const columns = Math.max(1, Math.round(((max[0] as number) - (min[0] as number)) / spacingX) + 1);
  const rows = Math.max(1, Math.round(((max[1] as number) - (min[1] as number)) / spacingY) + 1);
  const depth = Math.max(1, Math.round(((max[2] as number) - (min[2] as number)) / spacingZ) + 1);

  return { rows, columns, depth, spacingX, spacingY, spacingZ, origin: min };
}

/**
 * Inverse of the source stack's own forward mapping (columnIndex along
 * `row` scaled by pixelSpacingColumn, rowIndex along `column` scaled by
 * pixelSpacingRow, sliceIndex along `normal` scaled by sliceSpacing) --
 * row/column/normal are orthonormal, so the inverse is just projecting
 * the offset from `origin` onto each via a dot product. Returns
 * fractional (rowIndex, columnIndex, sliceIndex) into the *source* stack
 * for a canonical-space patient position; out-of-range values are the
 * caller's (trilinear sampler's) responsibility to handle.
 */
export function canonicalToSourceIndex(
  patientPos: Vec3,
  geometry: Pick<
    ObliqueSeriesGeometry,
    "row" | "column" | "normal" | "origin" | "pixelSpacingRow" | "pixelSpacingColumn" | "sliceSpacing"
  >,
): Vec3 {
  const { row, column, normal, origin, pixelSpacingRow, pixelSpacingColumn, sliceSpacing } = geometry;
  const relative: Vec3 = [patientPos[0] - origin[0], patientPos[1] - origin[1], patientPos[2] - origin[2]];
  const columnIndex = dot(relative, row) / pixelSpacingColumn;
  const rowIndex = dot(relative, column) / pixelSpacingRow;
  const sliceIndex = dot(relative, normal) / sliceSpacing;
  return [rowIndex, columnIndex, sliceIndex];
}
