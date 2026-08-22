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
    float4 shadingParams;    // xyz=light direction (world, normalized), w=shading enabled (0/1)
    float4 jitterParams;     // x=accumFrameIndex, y=accumulation enabled (0/1), zw unused
    float4 clipMin;          // xyz, world mm -- raymarch traversal bound (clip box, §6.4)
    float4 clipMax;          // xyz, world mm -- raymarch traversal bound (clip box, §6.4)
    float4 occlusionParams;  // x=DOS enabled (0/1), y=strength, zw unused
    float4 tfParams;         // x=threshold, y=gradient-opacity strength, zw unused
    float4 backgroundColor;  // xyz=RGB, w unused -- see kBackgroundColor's former header comment below
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

// Background color is ubo.backgroundColor (rhi::Device::setBackgroundColor,
// PRD baseline-perf-overlay follow-up) -- with jitter+temporal accumulation
// (§6.5), this shader's own output must already be a fully-resolved, opaque
// (alpha=1) frame (see fragmentMain's final composite below): the render
// pass this draws into now blends across FRAMES with a temporal weight
// (WGPUBlendFactor_Constant, set per frame in renderFrame()), not against
// this pass's own clear color the way a plain "render once, blend with
// alpha" pass would. WebGPUDevice::renderFrame()'s own render-pass clear
// colors are kept in sync with the same value (backgroundColor_) for the
// letterbox/no-volume cases that never reach this shader at all.

// Gradient-shading constants (docs/current/RENDERING_TECH_GAP_ANALYSIS_2026-08-20.md
// §4.3) -- fixed rather than UBO fields for this branch; kept close
// together so their sum (a fully-lit voxel's brightness multiplier) is
// easy to reason about at a glance.
static const float kShadingAmbient = 0.35;
static const float kShadingDiffuse = 0.65;

// Normalizes computeGradient()'s magnitude output (of windowed n, per mm)
// into roughly [0,1] for gradientOpacityStrength (§6.3) -- an untuned
// reference value; the strength slider is the actual user-facing control,
// this constant just sets its effective sensitivity. Not derived from
// window width because the gradient is already computed on window-
// normalized n (see computeGradient's header comment), so this only needs
// to account for typical edge sharpness relative to voxel spacing.
static const float kGradientOpacityReferenceMagnitude = 2.0;

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

// Window/level normalization, factored out so computeGradient() and
// computeOcclusion() (§6.2/§6.3) can share it with fragmentMain's own main
// sample without duplicating the formula three times.
float sampleN(float3 uvw, float windowCenter, float windowWidth)
{
    float raw = volumeTex.SampleLevel(linearSampler, uvw, 0.0);
    return clamp((raw - (windowCenter - windowWidth * 0.5)) / max(windowWidth, 1e-6), 0.0, 1.0);
}

// Forward-difference gradient of the *windowed* density n (not raw HU) at
// uvw, converted from normalized-texture-space to world-space mm by
// dividing each axis by its own physical voxel spacing (worldTexelSize) --
// doing this per-axis rather than with one scalar step matters on
// anisotropic volumes (thick-slice CT/MR): using a single isotropic step
// would skew the computed gradient direction toward the coarser axis.
// Using n instead of raw HU doesn't change the returned *direction* (n is
// just raw HU rescaled by a positive per-window constant, and normalize()
// removes magnitude entirely), but it does give outMagnitude a bounded,
// window-relative range instead of one that varies wildly with each
// volume's raw HU scale -- needed for gradientOpacityStrength (§6.3) to
// have predictable behavior across different loaded volumes/windows.
// -(gradient) points from higher to lower density, i.e. outward from
// tissue, which is the convention fragmentMain's N.L term expects.
//
// Was central-difference (6 volume samples: +/-x/y/z) until a real-device
// GPU-timing investigation (docs/current/PERF_BASELINE_2026-08-21.md
// §11-12) found shading responsible for ~71% of this pass's per-step
// cost -- centerN is fragmentMain's own already-sampled n at uvw (no
// extra fetch), reused here instead of re-sampling it a second time, so
// this only takes 3 additional samples (+x/+y/+z) instead of 6. This
// halves gradWorld's magnitude relative to the old central-difference
// convention (f(x+h)-f(x) approximates h*grad, vs the old f(x+h)-f(x-h)
// approximating 2h*grad) -- the *2.0 below restores the original scale
// so kGradientOpacityReferenceMagnitude and the gradient-opacity
// strength slider's existing feel don't need retuning. Direction is
// unaffected either way (normalize() removes any uniform scale factor);
// this only trades a small amount of directional accuracy (forward-
// difference is first-order vs central-difference's second-order, i.e.
// slightly more sensitive to local asymmetry in the density field) for
// half the sampling cost.
float3 computeGradient(float3 uvw, float3 texelUvw, float3 worldTexelSize, float windowCenter, float windowWidth,
                        float centerN, out float outMagnitude)
{
    float dx = sampleN(uvw + float3(texelUvw.x, 0.0, 0.0), windowCenter, windowWidth) - centerN;
    float dy = sampleN(uvw + float3(0.0, texelUvw.y, 0.0), windowCenter, windowWidth) - centerN;
    float dz = sampleN(uvw + float3(0.0, 0.0, texelUvw.z), windowCenter, windowWidth) - centerN;
    float3 gradWorld = 2.0 * float3(dx, dy, dz) / worldTexelSize;
    outMagnitude = length(gradWorld);
    if (outMagnitude < 1e-8)
    {
        // Flat/uniform region: no well-defined gradient direction. A zero
        // vector makes the caller's N.L term evaluate to 0 (ambient-only
        // shading there) rather than risking a normalize(0) NaN.
        return float3(0.0, 0.0, 0.0);
    }
    return -gradWorld / outMagnitude;
}

// Directional Occlusion Shading (§6.2) -- a handful of short secondary
// density samples marching from uvw toward the light, averaged into an
// approximate self-occlusion factor in [0,1]. Far cheaper than a full
// self-shadow ray march (which would reuse the *primary* ray's full
// stepSize/maxSteps budget per shading sample); this is deliberately a
// coarse approximation, not a shadow map or a physically exact
// visibility term.
float computeOcclusion(float3 uvw, float3 lightDirWorld, float3 worldTexelSize, float sampleWorldStep,
                        float windowCenter, float windowWidth)
{
    const int kOcclusionSamples = 3;
    float3 uvwStep = (lightDirWorld / worldTexelSize) * sampleWorldStep;
    float occlusion = 0.0;
    float3 sampleUvw = uvw;
    for (int i = 0; i < kOcclusionSamples; i++)
    {
        sampleUvw += uvwStep;
        if (any(sampleUvw < 0.0) || any(sampleUvw > 1.0))
        {
            break;
        }
        occlusion += sampleN(sampleUvw, windowCenter, windowWidth);
    }
    return saturate(occlusion / float(kOcclusionSamples));
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

    // Traversal is bounded by the clip box (§6.4), which defaults to the
    // full AABB when no clipping is set -- see intersectAABB's own header
    // comment. uvw/boxSize below stay anchored to the *original* AABB
    // (ubo.aabbMin/aabbMax) regardless of clipping, so texture sampling
    // coordinates and the mask overlay stay correctly aligned with the
    // (possibly partially hidden) volume rather than drifting.
    float tNear, tFar;
    intersectAABB(rayOrigin, rayDir, ubo.clipMin.xyz, ubo.clipMax.xyz, tNear, tFar);
    if (tNear >= tFar)
    {
        discard;
    }

    const float stepSize = ubo.rayParams.x;
    const int maxSteps = int(ubo.rayParams.y);
    const float extinction = ubo.rayParams.z;
    const float densityScale = ubo.rayParams.w;
    const float windowCenter = ubo.window.x;
    const float windowWidth = ubo.window.y;
    const bool maskEnabled = ubo.maskParams.x > 0.5;
    const float maskAlpha = ubo.maskParams.y;
    const bool shadingEnabled = ubo.shadingParams.w > 0.5;
    const float3 lightDir = ubo.shadingParams.xyz;
    const bool occlusionEnabled = ubo.occlusionParams.x > 0.5;
    const float occlusionStrength = ubo.occlusionParams.y;
    const float threshold = ubo.tfParams.x;
    const float gradientOpacityStrength = ubo.tfParams.y;
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

        float n = sampleN(uvw, windowCenter, windowWidth);
        float frontN = (prevN < 0.0) ? n : prevN;
        float4 preint = preintegratedLutTex.SampleLevel(linearSampler, float2(frontN, n), 0.0);
        float3 stepColor = preint.rgb;
        // densityScale (§5.3) is a global multiplier on the pre-integrated
        // classification value, independent of window/level -- 1.0 (the
        // default) leaves this exactly as before.
        float sBar = preint.a * densityScale;
        prevN = n;

        // Computed once, shared by shading's N.L term and gradient-opacity
        // modulation below -- skipped entirely when neither needs it.
        bool needsGradient = shadingEnabled || gradientOpacityStrength > 0.0;
        float3 normal = float3(0.0, 0.0, 0.0);
        float gradMagnitude = 0.0;
        if (needsGradient)
        {
            normal = computeGradient(uvw, texelUvw, worldTexelSize, windowCenter, windowWidth, n, gradMagnitude);
        }

        if (shadingEnabled)
        {
            float diffuseTerm = max(dot(normal, lightDir), 0.0);
            // Directional Occlusion Shading (§6.2) -- only meaningful
            // alongside shading, since it modulates the diffuse term.
            float occlusionFactor =
                occlusionEnabled
                    ? computeOcclusion(uvw, lightDir, worldTexelSize, stepSize * 2.0, windowCenter, windowWidth)
                    : 0.0;
            float lit = kShadingAmbient + kShadingDiffuse * diffuseTerm * (1.0 - occlusionFactor * occlusionStrength);
            stepColor *= lit;
        }

        // Beer-Lambert absorption, not a plain linear scale -- keeps alpha
        // naturally bounded in [0,1) regardless of step count/density,
        // matching Mini-Engine-reference's validated raymarch formula.
        // sBar (the pre-integrated average classification value across
        // this step) replaces the single-point n used previously.
        float alpha = 1.0 - exp(-extinction * sBar * stepSize);

        // Threshold cutoff (§5.3): density below this contributes no
        // opacity, independent of window/level -- lets background/noise
        // be cut out. Gated on the step's own n, not sBar, so it reflects
        // the actual sampled point rather than a pre-integrated average.
        if (n < threshold)
        {
            alpha = 0.0;
        }

        // Gradient-magnitude opacity modulation (§6.3, a scoped-down
        // stand-in for a full 2D transfer function -- see
        // engine/docs/RENDERING_SPEC.md for why). strength=0 is a no-op;
        // strength=1 fully re-weights alpha by normalized edge strength,
        // suppressing homogeneous-region noise and emphasizing boundaries.
        if (gradientOpacityStrength > 0.0)
        {
            float normalizedGrad = saturate(gradMagnitude / kGradientOpacityReferenceMagnitude);
            alpha *= lerp(1.0, normalizedGrad, gradientOpacityStrength);
        }

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

    // Resolves against the configurable background and forces alpha=1 --
    // see ubo.backgroundColor's declaration above for why this shader now
    // owns that compositing step itself instead of leaning on the render
    // pass's own alpha blend.
    float3 finalColor = accum.rgb + (1.0 - accum.a) * ubo.backgroundColor.rgb;
    return float4(finalColor, 1.0);
}
