/**
 * Thin typed wrapper over dicom-parser's WASM export layer
 * (dicom-parser/wasm/DicomParserWasm.cpp). No Node-specific APIs here
 * deliberately -- this file needs to work unchanged in a real browser
 * Worker once viewer/'s bundler exists, not just under Node for tests
 * (see test/fixtures.ts for the Node-only path-to-URL handling).
 *
 * The byte offsets below mirror DicomParserWasm.cpp's `DicomWasmImageInfo`
 * exactly -- that file pins them with `static_assert`s; this file's copy
 * is verified indirectly by pipeline.test.ts actually parsing a real file
 * and checking the values that come back, not assumed correct just
 * because the numbers match.
 */

const IMAGE_INFO_OFFSET = {
  rows: 0,
  columns: 4,
  bitsAllocated: 8,
  pixelRepresentation: 12,
  rescaleSlope: 16,
  rescaleIntercept: 24,
  pixelSpacingRow: 32,
  pixelSpacingColumn: 40,
  sliceThickness: 48,
  pixelDataOffset: 56,
  pixelDataLength: 60,
  instanceNumber: 64,
  imageOrientationPatient: 72,
  imagePositionPatient: 120,
  hasImageOrientationPatient: 144,
  hasImagePositionPatient: 148,
  windowCenter: 152,
  windowWidth: 160,
  hasWindowCenter: 168,
  hasWindowWidth: 172,
} as const;

/** Mirrors DicomParseError's declaration order (position + 1; 0 = success) in dicom-parser/include/dicom-parser/DicomFile.hpp. */
export const DicomParseErrorCode = {
  BufferTooSmall: 1,
  MissingMagic: 2,
  MissingGroupLength: 3,
  Truncated: 4,
  UnsupportedTransferSyntax: 5,
  UnsupportedSequenceEncoding: 6,
  UnsupportedPixelFormat: 7,
  MissingRequiredElement: 8,
} as const;

export interface DicomWasmImageInfo {
  rows: number;
  columns: number;
  bitsAllocated: number;
  pixelRepresentation: number; // 0 = unsigned, 1 = signed
  rescaleSlope: number;
  rescaleIntercept: number;
  pixelSpacingRow: number;
  pixelSpacingColumn: number;
  sliceThickness: number;
  /** Ordering hint for multi-file volume assembly; 0 if the tag was absent from the file. */
  instanceNumber: number;
  /** Row direction cosine [0..2] + column direction cosine [3..5], patient LPS space. Meaningless unless hasImageOrientationPatient. */
  imageOrientationPatient: [number, number, number, number, number, number];
  /** Slice origin (x, y, z), patient LPS space. Meaningless unless hasImagePositionPatient. */
  imagePositionPatient: [number, number, number];
  hasImageOrientationPatient: boolean;
  hasImagePositionPatient: boolean;
  /** VOI LUT display window (DICOM PS3.3 C.11.2), same units as the caller's computed HU. Meaningless unless hasWindowCenter/hasWindowWidth. */
  windowCenter: number;
  windowWidth: number;
  hasWindowCenter: boolean;
  hasWindowWidth: boolean;
  /** Copied out of WASM memory -- safe to use after the module call returns. */
  pixelData: Uint8Array;
}

interface EmscriptenModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  _dicom_wasm_image_info_size(): number;
  _dicom_wasm_parse_meta(
    dataPtr: number,
    size: number,
    outDataSetOffsetPtr: number,
    outTransferSyntaxBufPtr: number,
    outTransferSyntaxBufLen: number,
  ): number;
  _dicom_wasm_parse_image(
    dataPtr: number,
    size: number,
    dataSetOffset: number,
    transferSyntaxUIDPtr: number,
    outPtr: number,
  ): number;
}

type EmscriptenModuleFactory = () => Promise<EmscriptenModule>;

export class DicomParseError extends Error {
  constructor(
    public readonly code: number,
    context: string,
  ) {
    super(`dicom-parser WASM call failed (${context}): error code ${code}`);
  }
}

/** Narrow surface pipeline.ts depends on -- lets tests exercise pipeline logic without a real WASM module. */
export interface ImageParser {
  parseImage(fileBytes: Uint8Array): DicomWasmImageInfo;
}

export class DicomParserWasm implements ImageParser {
  private constructor(private readonly module: EmscriptenModule) {}

  /** `wasmModuleUrl` must resolve to `dicom_parser_wasm.mjs` -- a file:// URL under Node, a bundled asset URL in the browser. */
  static async load(wasmModuleUrl: string): Promise<DicomParserWasm> {
    const imported = (await import(/* @vite-ignore */ wasmModuleUrl)) as { default: EmscriptenModuleFactory };
    const module = await imported.default();
    return new DicomParserWasm(module);
  }

  /** Parses one DICOM file's bytes into the geometry/rescale/pixel-data needed to produce one HU slice. */
  parseImage(fileBytes: Uint8Array): DicomWasmImageInfo {
    const m = this.module;
    const dataPtr = m._malloc(fileBytes.length);
    const outOffsetPtr = m._malloc(4);
    const tsBufLen = 64;
    const tsBufPtr = m._malloc(tsBufLen);
    const structSize = m._dicom_wasm_image_info_size();
    const outStructPtr = m._malloc(structSize);

    try {
      m.HEAPU8.set(fileBytes, dataPtr);

      const metaRc = m._dicom_wasm_parse_meta(dataPtr, fileBytes.length, outOffsetPtr, tsBufPtr, tsBufLen);
      if (metaRc !== 0) {
        throw new DicomParseError(metaRc, "parseFromBuffer");
      }
      const dataSetOffset = new DataView(m.HEAPU8.buffer, outOffsetPtr, 4).getUint32(0, true);

      const imageRc = m._dicom_wasm_parse_image(dataPtr, fileBytes.length, dataSetOffset, tsBufPtr, outStructPtr);
      if (imageRc !== 0) {
        throw new DicomParseError(imageRc, "parseImageInfo");
      }

      const view = new DataView(m.HEAPU8.buffer, outStructPtr, structSize);
      const pixelDataOffset = view.getUint32(IMAGE_INFO_OFFSET.pixelDataOffset, true);
      const pixelDataLength = view.getUint32(IMAGE_INFO_OFFSET.pixelDataLength, true);

      // Copy pixel bytes out now, rather than returning a view over WASM
      // memory -- `dataPtr` is freed below, and ALLOW_MEMORY_GROWTH=1 means
      // a later allocation elsewhere could otherwise detach/relocate the
      // underlying buffer out from under a cached view.
      const pixelData = new Uint8Array(
        m.HEAPU8.buffer.slice(dataPtr + pixelDataOffset, dataPtr + pixelDataOffset + pixelDataLength),
      );

      return {
        rows: view.getUint32(IMAGE_INFO_OFFSET.rows, true),
        columns: view.getUint32(IMAGE_INFO_OFFSET.columns, true),
        bitsAllocated: view.getUint32(IMAGE_INFO_OFFSET.bitsAllocated, true),
        pixelRepresentation: view.getUint32(IMAGE_INFO_OFFSET.pixelRepresentation, true),
        rescaleSlope: view.getFloat64(IMAGE_INFO_OFFSET.rescaleSlope, true),
        rescaleIntercept: view.getFloat64(IMAGE_INFO_OFFSET.rescaleIntercept, true),
        pixelSpacingRow: view.getFloat64(IMAGE_INFO_OFFSET.pixelSpacingRow, true),
        pixelSpacingColumn: view.getFloat64(IMAGE_INFO_OFFSET.pixelSpacingColumn, true),
        sliceThickness: view.getFloat64(IMAGE_INFO_OFFSET.sliceThickness, true),
        instanceNumber: view.getInt32(IMAGE_INFO_OFFSET.instanceNumber, true),
        imageOrientationPatient: [0, 1, 2, 3, 4, 5].map((i) =>
          view.getFloat64(IMAGE_INFO_OFFSET.imageOrientationPatient + i * 8, true),
        ) as DicomWasmImageInfo["imageOrientationPatient"],
        imagePositionPatient: [0, 1, 2].map((i) =>
          view.getFloat64(IMAGE_INFO_OFFSET.imagePositionPatient + i * 8, true),
        ) as DicomWasmImageInfo["imagePositionPatient"],
        hasImageOrientationPatient: view.getUint32(IMAGE_INFO_OFFSET.hasImageOrientationPatient, true) !== 0,
        hasImagePositionPatient: view.getUint32(IMAGE_INFO_OFFSET.hasImagePositionPatient, true) !== 0,
        windowCenter: view.getFloat64(IMAGE_INFO_OFFSET.windowCenter, true),
        windowWidth: view.getFloat64(IMAGE_INFO_OFFSET.windowWidth, true),
        hasWindowCenter: view.getUint32(IMAGE_INFO_OFFSET.hasWindowCenter, true) !== 0,
        hasWindowWidth: view.getUint32(IMAGE_INFO_OFFSET.hasWindowWidth, true) !== 0,
        pixelData,
      };
    } finally {
      m._free(dataPtr);
      m._free(outOffsetPtr);
      m._free(tsBufPtr);
      m._free(outStructPtr);
    }
  }
}
