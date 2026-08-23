// Axial single-slice view: samples one Z-plane of the same HU volume
// texture the raymarch shader uses (rhi::Device::loadVolume), applies the
// same clinical window/level + transfer-function LUT and mask-overlay
// logic per pixel instead of per raymarch step, and draws it directly to
// the swapchain -- a traditional DICOM-style 2D cross-sectional view
// (REQ-R02, PRD §9 slice-panning gap, issue #37).
//
// WebGPU/Dawn cannot bind a single Z-slice of a 3D-dimension texture as a
// native 2D view (WGPUTextureViewDimension_2D only applies to textures
// created with dimension=2D), so this shader keeps sampling the same full
// 3D volumeTex/maskTex WebGPUDevice already binds for the raymarch
// pipeline, at a fixed Z instead of a varying one. See
// engine/docs/adr/0002-shader-source-strategy.md for why shader source is
// written once here and cross-compiled rather than hand-maintained
// per-backend.

struct AxialSliceUBO
{
    float4 sliceParams;  // x=sliceIndex (raw voxel index, not normalized), y=windowCenter, z=windowWidth, w unused
    float4 maskParams;   // x=overlayEnabled (0/1), y=overlayAlpha, zw unused
    // "Contain" letterbox fit (issue #40 follow-up -- the canvas is no
    // longer a fixed near-4:3 640x480 box, so filling it edge-to-edge
    // stretched/over-scaled the slice on wide or unusually-shaped
    // viewports). x/y are the NDC scale factors WebGPUDevice::renderFrame
    // computes from the volume's physical aspect ratio vs. the canvas's;
    // >1 on the axis that must be cropped to letterbox bars so the other
    // axis fills fully without distortion. zw unused.
    float4 fitParams;
};

[[vk::binding(0, 0)]] ConstantBuffer<AxialSliceUBO> ubo;
[[vk::binding(1, 0)]] Texture3D<float> volumeTex;   // R16Float HU volume, linear-filterable
[[vk::binding(2, 0)]] SamplerState linearSampler;   // volumeTex + lutTex
[[vk::binding(3, 0)]] Texture3D<uint> maskTex;      // R8Uint class indices -- Load only, never filtered
[[vk::binding(4, 0)]] Texture2D<float4> lutTex;     // 256x1 transfer-function LUT
// Declared (not sampled) only so this shader's bind group layout stays
// identical to volume_raymarch.slang's, which the two pipelines share
// (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md §6.1) -- a 2D
// per-pixel slice has no ray segment to pre-integrate over, so this view
// keeps using lutTex's direct per-pixel classification above instead.
[[vk::binding(5, 0)]] Texture2D<float4> preintegratedLutTex;  // unused in this shader
// Declared for the same shared-bind-group-layout reason as
// preintegratedLutTex above -- a single-plane view has no ray to shade
// along, so this shader never samples the precomputed gradient volume
// (gradient_bake.slang, issue #81's own follow-up) volume_raymarch.slang
// uses.
[[vk::binding(6, 0)]] Texture3D<float4> gradientTex;  // unused in this shader

// Same fixed highlight color as volume_raymarch.slang -- one lung model,
// one class set for this MVP, not a per-class palette.
static const float3 kMaskHighlightColor = float3(1.0, 0.15, 0.15);

struct VertexOutput
{
    float4 position : SV_Position;
    float2 ndc : TEXCOORD0;
};

// Same classic full-screen-triangle trick as volume_raymarch.slang's
// vertexMain -- no shared-include mechanism is wired into this repo's
// slangc build (compile_slang_shader compiles one file per invocation in
// isolation), so this ~10-line duplication is consistent with the
// existing single-file-per-shader design, not new debt.
[shader("vertex")]
VertexOutput vertexMain(uint vertexIndex : SV_VertexID)
{
    VertexOutput output;
    float x = float((vertexIndex << 1) & 2) * 2.0 - 1.0;
    float y = float(vertexIndex & 2) * 2.0 - 1.0;
    output.position = float4(x, y, 0.0, 1.0);
    output.ndc = float2(x, y);
    return output;
}

[shader("fragment")]
float4 fragmentMain(VertexOutput input) : SV_Target
{
    // NDC -> [0,1] UV, screen-top (ndc.y=+1) maps to texel row 0 (image
    // top). No clinical left/right orientation claim beyond that --
    // anatomical calibration is out of scope per PRD §7.2 ("display
    // calibration/strict DICOM color pipeline compliance") and
    // viewer/README.md's own documented gap (no suitable fixture exists
    // yet to verify against).
    //
    // fitParams scales the NDC range before mapping to [0,1] so the
    // image "contain"-fits the canvas at its own aspect ratio instead of
    // stretching to fill it -- ndc positions that fall outside the
    // fitted rectangle map outside [0,1] and are discarded below
    // (letterbox/pillarbox bars, drawn as the pass's clear color since
    // nothing is written there).
    float2 uv = float2(input.ndc.x * ubo.fitParams.x * 0.5 + 0.5, 0.5 - input.ndc.y * ubo.fitParams.y * 0.5);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)
    {
        discard;
    }

    uint volW, volH, volD;
    volumeTex.GetDimensions(volW, volH, volD);

    const float sliceIndex = ubo.sliceParams.x;
    const float windowCenter = ubo.sliceParams.y;
    const float windowWidth = ubo.sliceParams.z;
    const bool maskEnabled = ubo.maskParams.x > 0.5;
    const float maskAlpha = ubo.maskParams.y;

    // +0.5 samples the texel center along Z, matching how uv.x/uv.y
    // already land mid-texel for a full-resolution sample grid.
    float sliceZ = (sliceIndex + 0.5) / float(volD);
    float3 uvw = float3(uv, sliceZ);

    float raw = volumeTex.SampleLevel(linearSampler, uvw, 0.0);
    float n = clamp((raw - (windowCenter - windowWidth * 0.5)) / max(windowWidth, 1e-6), 0.0, 1.0);
    float4 lutColor = lutTex.SampleLevel(linearSampler, float2(n, 0.5), 0.0);
    float4 color = float4(lutColor.rgb, 1.0);

    if (maskEnabled)
    {
        uint maskW, maskH, maskD;
        maskTex.GetDimensions(maskW, maskH, maskD);

        // Nearest-only by construction (Load, not Sample), same reasoning
        // as volume_raymarch.slang's mask lookup. Uses the raw integer
        // sliceIndex directly (not a round-tripped float via sliceZ) to
        // stay pixel-exact with the Z plane actually being displayed.
        int3 texel = int3(int(uv.x * float(maskW)), int(uv.y * float(maskH)), int(sliceIndex));
        uint maskClass = maskTex.Load(int4(texel, 0));
        if (maskClass != 0u)
        {
            color.rgb = lerp(color.rgb, kMaskHighlightColor, maskAlpha);
        }
    }

    return color;
}
