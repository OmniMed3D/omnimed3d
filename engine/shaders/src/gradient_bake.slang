// Precomputes the HU volume's spatial gradient once per loadVolume() call
// (WebGPUDevice::bakeGradientVolume(), issue #81's own follow-up), instead
// of volume_raymarch.slang sampling it per raymarch step. A real-device
// GPU-timing investigation (docs/current/PERF_BASELINE_2026-08-21.md
// §11-12) found the per-step gradient sample was the raymarch pass's
// dominant cost (~71%) -- moving it to a one-time load-time bake instead
// amortizes that cost over every frame the volume is rendered, at the
// price of one storage-texture write pass at load time and extra GPU
// memory for the output texture (same voxel dimensions as the HU volume
// itself, RGBA16Float).
//
// Deliberately computed on *raw* HU, not window/level-normalized density
// (unlike the runtime gradient this replaces) -- window/level is a purely
// interactive per-frame control (window/width sliders), and baking would
// otherwise need to re-run on every slider change. Raw-HU gradient is
// window-independent: the windowed density n = (raw-center)/width is an
// affine rescaling of raw HU (ignoring the [0,1] clamp -- see below), so
// its gradient is just this raw gradient divided by the current
// windowWidth, done cheaply per-pixel in volume_raymarch.slang's
// fragmentMain instead of requiring a rebake. The one behavior difference
// from the old runtime computation: the old code computed on already-
// window-clamped samples, so regions fully outside the current window
// (n pinned to 0 or 1) read as gradient-free (flat shading) there: this
// bake doesn't replicate that clamp-boundary zeroing (raw HU has no
// notion of the current window), so shading detail can now show through
// in regions the window would otherwise flatten. Not replicated
// deliberately -- that zeroing was a side effect of the old
// implementation's approach, not a documented design goal (see
// RENDERING_SPEC.md §1.2 step 3's history), and showing real anatomical
// detail there reads as a reasonable outcome, not a regression.
//
// Central-difference (6 taps, clamped at the volume boundary), not
// volume_raymarch.slang's forward-difference (3 taps) -- that trade
// favored fewer samples specifically because it ran every step of every
// frame; here the extra 3 taps are a one-time load-time cost, so there's
// no reason not to keep the more accurate second-order estimate.

[[vk::binding(0, 0)]] Texture3D<float> volumeTex;  // R16Float HU volume, same as volume_raymarch.slang's binding 1
// WTexture3D (write-only), not RWTexture3D -- this shader never reads
// gradientTex, only writes it, but Slang's WGSL/SPIR-V backends default
// an RWTexture3D to read-write access regardless of how it's actually
// used in the shader body (confirmed empirically: RWTexture3D<float4>
// here produced `texture_storage_3d<rgba16float, read_write>` in WGSL --
// and WebGPU's base feature set doesn't support read-write access for
// most storage-texture formats, RGBA16Float included, only a handful of
// single-channel 32-bit ones -- so the WebGPUDevice-side bind group
// layout, declared WriteOnly to match this, failed validation against
// that read_write shader declaration). WTexture3D + .Store() (below)
// instead compiles to `texture_storage_3d<rgba16float, write>` in WGSL
// and a SPIR-V NonReadable-decorated image -- both correctly write-only,
// matching WGPUStorageTextureAccess_WriteOnly on the C++ side. [format(...)]
// is still required either way -- an RWTexture3D/WTexture3D with no
// format hint gets slangc's own best-guess format (rgba32float for a
// float4 element type, confirmed the same way), which silently mismatched
// this texture's actual RGBA16Float C++-side format until this was added.
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
    // gradient is already in HU/mm, matching the world-space convention
    // volume_raymarch.slang's shading/gradient-opacity code expects --
    // matches this same division by "worldTexelSize" (== spacing exactly,
    // see WebGPUDevice::bakeGradientVolume's own comment) the old runtime
    // computeGradient() did.
    float3 gradWorld = float3(dx, dy, dz) / params.spacing.xyz;
    gradientTex.Store(id, float4(gradWorld, 0.0));
}
