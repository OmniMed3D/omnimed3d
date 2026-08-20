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
    float4 cameraPos;      // xyz
    float4 aabbMin;        // xyz, world mm
    float4 aabbMax;        // xyz, world mm
    float4 rayParams;      // x=stepSize, y=maxSteps, z=extinction, w unused
    float4 window;         // x=windowCenter, y=windowWidth, zw unused
    float4 maskParams;     // x=overlayEnabled (0/1), y=overlayAlpha, zw unused
    float4 shadingParams;  // xyz=light direction (world, normalized), w=shading enabled (0/1)
    float4 jitterParams;   // x=accumFrameIndex, y=accumulation enabled (0/1), zw unused
};

[[vk::binding(0, 0)]] ConstantBuffer<RaymarchUBO> ubo;
[[vk::binding(1, 0)]] Texture3D<float> volumeTex;   // R16Float HU volume, linear-filterable
[[vk::binding(2, 0)]] SamplerState linearSampler;   // volumeTex + lutTex + preintegratedLutTex
[[vk::binding(3, 0)]] Texture3D<uint> maskTex;      // R8Uint class indices -- Load only, never filtered
[[vk::binding(4, 0)]] Texture2D<float4> lutTex;     // 256x1 transfer-function LUT (unused here -- see below)
// Pre-integrated transfer function (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md
// §6.1): rgb=average color, a=average classification value ("sBar"),
// integrated between a step's front/back density samples rather than
// point-classified at one of them -- prevents thin high-contrast
// structures from flickering/disappearing between coarse ray-march steps
// (worse at low quality tiers). Replaces lutTex for this shader's own
// color+opacity lookup; lutTex stays bound (same shared bind group layout
// as axial_slice.slang, which still uses it directly for its per-pixel,
// non-ray-marched classification) but this shader no longer samples it.
[[vk::binding(5, 0)]] Texture2D<float4> preintegratedLutTex;  // 256x256, (front,back) -> (colorBar.rgb, sBar)

// Mask overlay highlight -- one fixed color for this MVP (PRD P0 scope: one
// lung model, one class set; not a per-class palette).
static const float3 kMaskHighlightColor = float3(1.0, 0.15, 0.15);

// Matches WebGPUDevice::renderFrame()'s swapchain clear color exactly --
// with jitter+temporal accumulation (§6.5), this shader's own output must
// already be a fully-resolved, opaque (alpha=1) frame (see fragmentMain's
// final composite below): the render pass this draws into now blends
// across FRAMES with a temporal weight (WGPUBlendFactor_Constant, set per
// frame in renderFrame()), not against this pass's own clear color the
// way a plain "render once, blend with alpha" pass would.
static const float3 kBackgroundColor = float3(0.05, 0.05, 0.12);

// Gradient-shading constants (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md
// §4.3) -- fixed rather than UBO fields for this branch; kept close
// together so their sum (a fully-lit voxel's brightness multiplier) is
// easy to reason about at a glance.
static const float kShadingAmbient = 0.35;
static const float kShadingDiffuse = 0.65;

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

// Central-difference density gradient at uvw, converted from
// normalized-texture-space to world-space mm by dividing each axis by its
// own physical voxel spacing (worldTexelSize) -- doing this per-axis
// rather than with one scalar step matters on anisotropic volumes
// (thick-slice CT/MR): using a single isotropic step would skew the
// computed gradient direction toward the coarser axis. -(gradient)
// points from higher to lower density, i.e. outward from tissue, which is
// the convention fragmentMain's N.L term below expects.
float3 computeGradient(float3 uvw, float3 texelUvw, float3 worldTexelSize)
{
    float dx = volumeTex.SampleLevel(linearSampler, uvw + float3(texelUvw.x, 0.0, 0.0), 0.0) -
               volumeTex.SampleLevel(linearSampler, uvw - float3(texelUvw.x, 0.0, 0.0), 0.0);
    float dy = volumeTex.SampleLevel(linearSampler, uvw + float3(0.0, texelUvw.y, 0.0), 0.0) -
               volumeTex.SampleLevel(linearSampler, uvw - float3(0.0, texelUvw.y, 0.0), 0.0);
    float dz = volumeTex.SampleLevel(linearSampler, uvw + float3(0.0, 0.0, texelUvw.z), 0.0) -
               volumeTex.SampleLevel(linearSampler, uvw - float3(0.0, 0.0, texelUvw.z), 0.0);
    float3 gradWorld = float3(dx, dy, dz) / worldTexelSize;
    float gradLen = length(gradWorld);
    if (gradLen < 1e-8)
    {
        // Flat/uniform region: no well-defined gradient direction. A zero
        // vector makes the caller's N.L term evaluate to 0 (ambient-only
        // shading there) rather than risking a normalize(0) NaN.
        return float3(0.0, 0.0, 0.0);
    }
    return -gradWorld / gradLen;
}

// Interleaved gradient noise (Jimenez, "Next Generation Post Processing in
// Call of Duty: Advanced Warfare") -- cheap, well-distributed per-pixel
// noise in [0,1). frameIndex offsets the sampled coordinate by a large,
// non-repeating-looking step so consecutive accumulated frames (§6.5) get
// decorrelated jitter instead of the same pattern every frame, which
// would just look like a static offset rather than converging noise.
float interleavedGradientNoise(float2 pixelCoord, float frameIndex)
{
    const float2 magic = float2(0.06711056, 0.00583715);
    float2 offsetCoord = pixelCoord + frameIndex * float2(47.0, 17.0);
    return frac(52.9829189 * frac(dot(offsetCoord, magic)));
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
    const bool shadingEnabled = ubo.shadingParams.w > 0.5;
    const float3 lightDir = ubo.shadingParams.xyz;
    const float3 boxSize = ubo.aabbMax.xyz - ubo.aabbMin.xyz;

    uint maskW, maskH, maskD;
    maskTex.GetDimensions(maskW, maskH, maskD);

    uint volW, volH, volD;
    volumeTex.GetDimensions(volW, volH, volD);
    const float3 texelUvw = float3(1.0 / float(volW), 1.0 / float(volH), 1.0 / float(volD));
    const float3 worldTexelSize = texelUvw * boxSize;

    float4 accum = float4(0.0, 0.0, 0.0, 0.0);
    // Jitters the ray-march lattice's starting offset per pixel/frame
    // (§6.5) -- in [0, stepSize), so t never lands before tNear. Combined
    // with temporal accumulation (renderFrame()'s per-frame blend
    // weight), this trades a single frame's regular sampling-lattice
    // banding for noise that converges toward the correct image while the
    // camera/params are static.
    float jitter = interleavedGradientNoise(input.position.xy, ubo.jitterParams.x);
    float t = tNear + jitter * stepSize;
    // Front density sample for the pre-integrated (front,back) lookup --
    // negative sentinel means "no previous sample yet" (first step of the
    // ray), handled below by using the first step's own n for both ends
    // (degenerates to the original point-classification behavior for
    // that one step).
    float prevN = -1.0;

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
        float frontN = (prevN < 0.0) ? n : prevN;
        float4 preint = preintegratedLutTex.SampleLevel(linearSampler, float2(frontN, n), 0.0);
        float3 stepColor = preint.rgb;
        float sBar = preint.a;
        prevN = n;

        if (shadingEnabled)
        {
            float3 normal = computeGradient(uvw, texelUvw, worldTexelSize);
            float diffuseTerm = max(dot(normal, lightDir), 0.0);
            float lit = kShadingAmbient + kShadingDiffuse * diffuseTerm;
            stepColor *= lit;
        }

        // Beer-Lambert absorption, not a plain linear scale -- keeps alpha
        // naturally bounded in [0,1) regardless of step count/density,
        // matching Mini-Engine-reference's validated raymarch formula.
        // sBar (the pre-integrated average classification value across
        // this step) replaces the single-point n used previously.
        float alpha = 1.0 - exp(-extinction * sBar * stepSize);
        accum.rgb += (1.0 - accum.a) * stepColor * alpha;
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

    // Resolves against a fixed background and forces alpha=1 -- see
    // kBackgroundColor's header comment for why this shader now owns that
    // compositing step itself instead of leaning on the render pass's own
    // alpha blend.
    float3 finalColor = accum.rgb + (1.0 - accum.a) * kBackgroundColor;
    return float4(finalColor, 1.0);
}
