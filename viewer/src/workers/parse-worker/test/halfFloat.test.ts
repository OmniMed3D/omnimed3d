import { describe, expect, it } from "vitest";
import { float32ToFloat16 } from "../src/halfFloat.js";

describe("float32ToFloat16", () => {
  it("converts known reference values to their exact IEEE 754 binary16 bit patterns", () => {
    expect(float32ToFloat16(0)).toBe(0x0000);
    expect(float32ToFloat16(-0)).toBe(0x8000);
    expect(float32ToFloat16(1)).toBe(0x3c00);
    expect(float32ToFloat16(-1)).toBe(0xbc00);
    expect(float32ToFloat16(2)).toBe(0x4000);
    expect(float32ToFloat16(65504)).toBe(0x7bff); // largest finite half-float
  });

  it("converts real Hounsfield-range values correctly (independently hand-derived, not round-tripped)", () => {
    // -1024 = -2^10 exactly representable: sign=1, biased exponent=10+15=25, mantissa=0.
    expect(float32ToFloat16(-1024)).toBe(0xe400);
    expect(float32ToFloat16(0)).toBe(0x0000);
  });

  it("overflows to signed infinity beyond the representable range", () => {
    expect(float32ToFloat16(100000)).toBe(0x7c00);
    expect(float32ToFloat16(-100000)).toBe(0xfc00);
  });

  it("preserves NaN as a half-float NaN pattern", () => {
    const result = float32ToFloat16(NaN);
    const exponent = (result >> 10) & 0x1f;
    const mantissa = result & 0x3ff;
    expect(exponent).toBe(0x1f);
    expect(mantissa).not.toBe(0);
  });
});
