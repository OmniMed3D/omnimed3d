/**
 * float32 -> IEEE 754 binary16 (half-precision) bit-pattern conversion.
 * No dependency on `Float16Array` -- it lands very recently in JS engines
 * and browser support isn't universal yet, while this project's WebGPU
 * target is specifically Chrome (see the PRD); a plain bit-manipulation
 * conversion works everywhere. Needed because
 * `rhi::Device::loadVolume`/`engine_load_volume`
 * (engine/src/rhi/include/rhi/Device.hpp, engine/src/main_wasm.cpp)
 * uploads its input buffer directly into an `R16Float` GPU texture --
 * whoever calls it must already have converted to this format themselves.
 *
 * Handles the normal, subnormal, zero, overflow-to-infinity, and NaN
 * cases correctly (verified against known reference bit patterns in
 * test/halfFloat.test.ts, not just the Hounsfield-range values this
 * module actually needs in practice).
 */

const floatBuf = new Float32Array(1);
const intBuf = new Uint32Array(floatBuf.buffer);

export function float32ToFloat16(value: number): number {
  floatBuf[0] = value;
  const x = intBuf[0] as number;

  let bits = (x >>> 16) & 0x8000; // sign
  let m = (x >>> 12) & 0x07ff; // mantissa candidate (top 11 bits of the 23-bit float32 mantissa)
  const e = (x >>> 23) & 0xff; // float32 exponent (biased by 127)

  if (e < 103) {
    // Magnitude too small to represent even as a half-float subnormal -> signed zero.
    return bits;
  }

  if (e > 142) {
    if (e === 255) {
      // Inf or NaN -- preserve NaN-ness via the mantissa's most significant bit.
      bits |= 0x7c00 | ((x & 0x007fffff) !== 0 ? 0x0200 : 0);
      return bits;
    }
    // Overflow -> signed infinity.
    return bits | 0x7c00;
  }

  if (e < 113) {
    // Subnormal half-float.
    m |= 0x0800;
    bits |= (m >>> (114 - e)) + ((m >>> (113 - e)) & 1);
    return bits;
  }

  // Normalized case, with round-half-up on the dropped mantissa bit.
  bits |= ((e - 112) << 10) | (m >>> 1);
  bits += m & 1;
  return bits;
}
