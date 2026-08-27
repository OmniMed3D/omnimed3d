// Precomputes the HU volume's spatial gradient once per loadVolume() call
// (WebGPUDevice::bakeGradientVolume()), instead of volume_raymarch.slang
// sampling it per raymarch step -- the per-step gradient sample was the
// raymarch pass's dominant cost. A one-time load-time bake amortizes that
// over every frame, at the price of one storage-texture write pass at
// load and extra GPU memory for the output texture (same voxel dimensions
// as the HU volume, RGBA16Float).
//
// Computed on raw HU, not window/level-normalized density (unlike the
// runtime gradient this replaces) -- window/level is an interactive
// per-frame control, and baking on it would need to re-run on every
// slider change. Raw-HU gradient is window-independent: windowed density
// n = (raw-center)/width is an affine rescaling of raw HU (ignoring the
// [0,1] clamp), so its gradient is just this raw gradient divided by the
// current windowWidth, done per-pixel in volume_raymarch.slang. One
// behavior difference: the old runtime code computed on window-clamped
// samples, so regions fully outside the window read as gradient-free
// (flat) there; this bake has no notion of the current window and so
// keeps shading detail visible in those regions, which reads as a
// reasonable outcome rather than a regression.
//
// Central-difference (6 taps, clamped at the volume boundary), not
// volume_raymarch.slang's forward-difference (3 taps) -- the runtime path
// favored fewer samples because it ran every step of every frame; here
// the extra taps are a one-time cost, so the more accurate estimate is
// worth keeping.

[[vk::binding(0, 0)]] Texture3D<float> volumeTex;  // R16Float HU volume, same as volume_raymarch.slang's binding 1
// WTexture3D (write-only), not RWTexture3D -- this shader only writes
// gradientTex, but Slang's WGSL/SPIR-V backends compile an RWTexture3D to
// read-write access regardless of how it's used, producing
// `texture_storage_3d<rgba16float, read_write>` in WGSL. WebGPU's base
// feature set doesn't support read-write access for RGBA16Float (only a
// handful of single-channel 32-bit formats), so the WriteOnly bind group
// layout on the C++ side fails validation against that. WTexture3D +
// .Store() compiles to `<rgba16float, write>` / a SPIR-V
// NonReadable-decorated image, matching WGPUStorageTextureAccess_WriteOnly.
// [format(...)] is required either way -- without it slangc picks its own
// best-guess format (rgba32float for a float4 element type), mismatching
// this texture's actual RGBA16Float format.
[[vk::binding(1, 0)]] [format("rgba16f")] WTexture3D<float4> gradientTex;  // xyz = dHU/d(x,y,z) in HU/mm, w unused

struct GradientBakeParams
{
    float4 spacing;  // xyz = volume's physical voxel spacing (world mm), w unused
};
[[vk::binding(2, 0)]] ConstantBuffer<GradientBakeParams> params;

[shader("compute")]
[numthreads(4, 4, 4)]
void computeMain(uint3 id : SV_DispatchThreadID)
{
    uint width, height, depth;
    volumeTex.GetDimensions(width, height, depth);
    if (id.x >= width || id.y >= height || id.z >= depth)
    {
        return;
    }

    // Clamped taps rather than a branch per axis at the boundary -- a
    // clamped central difference at the edge degrades gracefully to a
    // one-sided (forward/backward) difference there, still a reasonable
    // estimate, without needing separate boundary-case code paths.
    int3 pos = int3(id);
    int3 dims = int3(width, height, depth);
    int3 xPlus = clamp(pos + int3(1, 0, 0), int3(0, 0, 0), dims - 1);
    int3 xMinus = clamp(pos - int3(1, 0, 0), int3(0, 0, 0), dims - 1);
    int3 yPlus = clamp(pos + int3(0, 1, 0), int3(0, 0, 0), dims - 1);
    int3 yMinus = clamp(pos - int3(0, 1, 0), int3(0, 0, 0), dims - 1);
    int3 zPlus = clamp(pos + int3(0, 0, 1), int3(0, 0, 0), dims - 1);
    int3 zMinus = clamp(pos - int3(0, 0, 1), int3(0, 0, 0), dims - 1);

    float dx = volumeTex.Load(int4(xPlus, 0)) - volumeTex.Load(int4(xMinus, 0));
    float dy = volumeTex.Load(int4(yPlus, 0)) - volumeTex.Load(int4(yMinus, 0));
    float dz = volumeTex.Load(int4(zPlus, 0)) - volumeTex.Load(int4(zMinus, 0));

    // Divides by physical spacing (world mm per voxel) so the stored
    // gradient is in HU/mm, matching the world-space convention
    // volume_raymarch.slang's shading/gradient-opacity code expects.
    float3 gradWorld = float3(dx, dy, dz) / params.spacing.xyz;
    gradientTex.Store(id, float4(gradWorld, 0.0));
}
