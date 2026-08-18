// Volume raymarch: samples the HU volume texture (rhi::Device::loadVolume)
// and segmentation mask texture (applyMaskSlice), applies clinical
// window/level via a transfer-function LUT, and composites a front-to-back
// raymarch to the swapchain (REQ-R02/R03, issue #29). See
// engine/docs/adr/0002-shader-source-strategy.md for why this is written
// once here and cross-compiled (slangc, engine/shaders/CMakeLists.txt)
// rather than hand-maintained per-backend.
//
// World space here is the same canonical LPS convention the Parse Worker
// already normalizes pixel data to before it ever reaches loadVolume()
// (viewer/README.md "DICOM orientation normalization"): +X = patient Left,
// +Y = patient Posterior, +Z = patient Superior. WebGPUDevice frames its
// default camera with up=+Z accordingly -- see loadVolume()'s camera setup.

struct RaymarchUBO
{
    float4x4 invView;
    float4x4 invProj;
    float4 cameraPos;   // xyz
    float4 aabbMin;     // xyz, world mm
    float4 aabbMax;     // xyz, world mm
    float4 rayParams;   // x=stepSize, y=maxSteps, z=extinction, w unused
    float4 window;      // x=windowCenter, y=windowWidth, zw unused
    float4 maskParams;  // x=overlayEnabled (0/1), y=overlayAlpha, zw unused
};

[[vk::binding(0, 0)]] ConstantBuffer<RaymarchUBO> ubo;
[[vk::binding(1, 0)]] Texture3D<float> volumeTex;   // R16Float HU volume, linear-filterable
[[vk::binding(2, 0)]] SamplerState linearSampler;   // volumeTex + lutTex
[[vk::binding(3, 0)]] Texture3D<uint> maskTex;      // R8Uint class indices -- Load only, never filtered
[[vk::binding(4, 0)]] Texture2D<float4> lutTex;     // 256x1 transfer-function LUT

// Mask overlay highlight -- one fixed color for this MVP (PRD P0 scope: one
// lung model, one class set; not a per-class palette).
static const float3 kMaskHighlightColor = float3(1.0, 0.15, 0.15);

struct VertexOutput
{
    float4 position : SV_Position;
    // Clip-space xy, carried separately from `position` -- SV_Position in
    // the fragment stage is framebuffer pixel coordinates, not NDC, so
    // reconstructing the view ray needs this rather than input.position.
    float2 ndc : TEXCOORD0;
};

// Classic full-screen-triangle trick: 3 vertices, no vertex buffer. Covers
// the whole clip-space rectangle; the triangle's excess outside [-1,1]
// gets clipped by the rasterizer for free.
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

// Ray-AABB slab intersection. tNear is clamped to >= 0 (camera may already
// be inside the box). Caller checks tNear >= tFar for "no intersection"
// rather than a separate out bool, to keep this branch-light.
void intersectAABB(float3 rayOrigin, float3 rayDir, float3 boxMin, float3 boxMax,
                    out float tNear, out float tFar)
{
    float3 invDir = 1.0 / rayDir;
    float3 t0 = (boxMin - rayOrigin) * invDir;
    float3 t1 = (boxMax - rayOrigin) * invDir;
    float3 tSmall = min(t0, t1);
    float3 tBig = max(t0, t1);
    tNear = max(max(tSmall.x, tSmall.y), max(tSmall.z, 0.0));
    tFar = min(min(tBig.x, tBig.y), tBig.z);
}

[shader("fragment")]
float4 fragmentMain(VertexOutput input) : SV_Target
{
    // Unproject NDC -> world-space ray. WebGPU's own clip-space convention
    // is used throughout (no Y-flip correction needed -- the vertex stage
    // already emits WebGPU-convention clip-space positions directly).
    float4 clipFar = float4(input.ndc, 1.0, 1.0);
    float4 viewFar = mul(ubo.invProj, clipFar);
    viewFar /= viewFar.w;
    float4 worldFar = mul(ubo.invView, viewFar);
    float3 rayOrigin = ubo.cameraPos.xyz;
    float3 rayDir = normalize(worldFar.xyz - rayOrigin);

    float tNear, tFar;
    intersectAABB(rayOrigin, rayDir, ubo.aabbMin.xyz, ubo.aabbMax.xyz, tNear, tFar);
    if (tNear >= tFar)
    {
        discard;
    }

    const float stepSize = ubo.rayParams.x;
    const int maxSteps = int(ubo.rayParams.y);
    const float extinction = ubo.rayParams.z;
    const float windowCenter = ubo.window.x;
    const float windowWidth = ubo.window.y;
    const bool maskEnabled = ubo.maskParams.x > 0.5;
    const float maskAlpha = ubo.maskParams.y;
    const float3 boxSize = ubo.aabbMax.xyz - ubo.aabbMin.xyz;

    uint maskW, maskH, maskD;
    maskTex.GetDimensions(maskW, maskH, maskD);

    float4 accum = float4(0.0, 0.0, 0.0, 0.0);
    float t = tNear;

    // Front-to-back: accum starts transparent at the near face and
    // composites forward, early-terminating once effectively opaque.
    for (int i = 0; i < maxSteps; i++)
    {
        if (t >= tFar || accum.a > 0.99)
        {
            break;
        }

        float3 worldPos = rayOrigin + rayDir * t;
        float3 uvw = (worldPos - ubo.aabbMin.xyz) / boxSize;

        float raw = volumeTex.SampleLevel(linearSampler, uvw, 0.0);
        float n = clamp((raw - (windowCenter - windowWidth * 0.5)) / max(windowWidth, 1e-6), 0.0, 1.0);
        float4 lutColor = lutTex.SampleLevel(linearSampler, float2(n, 0.5), 0.0);

        // Beer-Lambert absorption, not a plain linear scale -- keeps alpha
        // naturally bounded in [0,1) regardless of step count/density,
        // matching Mini-Engine-reference's validated raymarch formula.
        float alpha = 1.0 - exp(-extinction * n * stepSize);
        accum.rgb += (1.0 - accum.a) * lutColor.rgb * alpha;
        accum.a += (1.0 - accum.a) * alpha;

        if (maskEnabled)
        {
            // Nearest-only by construction (Load, not Sample) -- the mask
            // texture holds discrete class indices; interpolating them
            // would fabricate nonexistent class values at texel borders,
            // exactly the rule PRD 5.3.1 already mandates for the
            // producer side's own upscaling.
            int3 texel = int3(uvw * float3(maskW, maskH, maskD));
            uint maskClass = maskTex.Load(int4(texel, 0));
            if (maskClass != 0u)
            {
                accum.rgb += (1.0 - accum.a) * kMaskHighlightColor * maskAlpha;
                accum.a += (1.0 - accum.a) * maskAlpha;
            }
        }

        t += stepSize;
    }

    return accum;
}
