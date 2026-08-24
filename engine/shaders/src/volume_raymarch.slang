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
    float4 tfParams;         // x=threshold, y=gradient-opacity strength, z=low-memory gradient fallback (0/1), w unused
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
// Precomputed raw-HU gradient (gradient_bake.slang, issue #81's own
// follow-up) -- xyz = dHU/d(x,y,z) in HU/mm at each voxel, w unused.
// Same dimensions as volumeTex; sampled trilinearly at the same uvw a
// step's density sample uses, for a gradient field as spatially
// continuous as the density field it's derived from. See
// fragmentMain's own comment on why this replaced a per-step
// computeGradient() call. When the host loaded the volume in low-memory
// mode (mobile OOM mitigation, `tfParams.z`), this texture is a 1x1x1
// dummy (WebGPUDevice never baked it) and fragmentMain falls back to
// computeGradient() below instead of sampling it.
[[vk::binding(6, 0)]] Texture3D<float4> gradientTex;

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
// easy to reason about at a glance. Sum kept at 1.0 (unchanged) so a
// fully-lit surface still maps to exactly the unshaded color -- only the
// ambient/diffuse split moved.
//
// Ambient raised 0.35->0.55 (issue #81): the fixed world-space light
// direction rarely faces a typical orbit-camera's visible surfaces
// head-on, so most of the frame sits near the ambient floor rather than
// the diffuse ceiling -- a real-device test found the default (fully
// shaded) render "too dark" for exactly this reason. Also shrinks the
// gap between real shading and shading's flat interaction-mode
// approximation (kFlatShadingDiffuseTerm below): raising the floor a
// dark surface can be brightened to interaction-mode's fixed diffuse
// guess is a smaller jump than before, since real surfaces are so often
// near that floor to begin with.
static const float kShadingAmbient = 0.55;
static const float kShadingDiffuse = 0.45;

// Normalizes fragmentMain's windowed-gradient magnitude (see its own
// comment on gradientTex) into roughly [0,1] for gradientOpacityStrength
// (§6.3) -- an untuned reference value; the strength slider is the
// actual user-facing control, this constant just sets its effective
// sensitivity. Not derived from window width because the gradient read
// out of gradientTex is already converted to window-normalized units
// (divided by windowWidth) before this is applied, so this only needs
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

// On-the-fly forward-difference gradient (mobile OOM mitigation,
// `tfParams.z`) -- the per-step alternative to sampling gradientTex,
// restored from before issue #81's gradient-volume precompute (see
// gradientTex's own comment above). Costs 3 extra volumeTex samples per
// step needing it (~+1.2ms/frame measured) in exchange for not needing
// gradientTex's full-volume-sized RGBA16Float texture at all -- worth it
// specifically when that texture's memory (4x the HU volume's own size)
// is what's pushing a memory-constrained device toward OOM, not when
// frame time is the bottleneck.
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
    // 0=off, 1=on, 2=on-flat (issue #81 -- see kFlatShadingDiffuseTerm's
    // own comment below for what "flat" means).
    const bool shadingEnabled = ubo.shadingParams.w > 0.5;
    const bool shadingFlat = ubo.shadingParams.w > 1.5;
    const float3 lightDir = ubo.shadingParams.xyz;
    const bool occlusionEnabled = ubo.occlusionParams.x > 0.5;
    const float occlusionStrength = ubo.occlusionParams.y;
    const float threshold = ubo.tfParams.x;
    const float gradientOpacityStrength = ubo.tfParams.y;
    const bool lowMemoryMode = ubo.tfParams.z > 0.5;
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
    // Tracks the mask class from the previous step so the overlay below
    // can detect boundary *crossings* (0 -> nonzero) instead of
    // compositing on every step inside the mask -- see that block's own
    // comment for why.
    uint prevMaskClass = 0u;

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
        // modulation below -- skipped entirely when neither needs it. Not
        // needed for shading specifically in flat mode (kFlatShadingDiffuseTerm
        // below is a fixed constant, no gradient sample required), but
        // gradient-opacity modulation is a separate feature that still
        // needs it regardless of shading mode.
        //
        // Reads gradientTex (precomputed raw-HU gradient, gradient_bake.slang,
        // issue #81's own follow-up) instead of computing it here every
        // step -- was the raymarch pass's dominant per-step cost (~71% per
        // a real-device GPU-timing investigation) before this. Dividing by
        // windowWidth converts the raw-HU-per-mm value into the same
        // window-normalized-per-mm units the old runtime computation
        // produced (n = (raw-center)/width is an affine rescaling of raw
        // HU, so its gradient is exactly the raw gradient over windowWidth
        // -- see gradient_bake.slang's own header comment for the one
        // behavior difference this doesn't replicate: clamp-boundary
        // zeroing outside the current window). -(gradient) points from
        // higher to lower density, i.e. outward from tissue, the
        // convention the N.L term below expects.
        bool needsGradient = (shadingEnabled && !shadingFlat) || gradientOpacityStrength > 0.0;
        float3 normal = float3(0.0, 0.0, 0.0);
        float gradMagnitude = 0.0;
        if (needsGradient)
        {
            if (lowMemoryMode)
            {
                float outMagnitude;
                normal = computeGradient(uvw, texelUvw, worldTexelSize, windowCenter, windowWidth, n, outMagnitude);
                gradMagnitude = outMagnitude;
            }
            else
            {
                float3 gradWorld = gradientTex.SampleLevel(linearSampler, uvw, 0.0).xyz / windowWidth;
                gradMagnitude = length(gradWorld);
                normal = gradMagnitude < 1e-8 ? float3(0.0, 0.0, 0.0) : -gradWorld / gradMagnitude;
            }
        }

        if (shadingEnabled)
        {
            // Flat mode (issue #81): skips computeGradient's sampling cost
            // (the raymarch pass's dominant per-step cost, per a real-
            // device GPU-timing investigation) by using a fixed
            // representative diffuse term instead of the real N.L --
            // deliberately not simply disabling shading (mode 0) here,
            // since that skips the ambient/diffuse *falloff* itself,
            // which multiplies color by at most 1.0 (fully lit) and as
            // little as kShadingAmbient (0.35, unlit) -- turning shading
            // off entirely made every surface jump to "fully lit"
            // brightness the instant a drag started, a visible pop a
            // real mobile test caught. 0.5 is not derived from anything
            // physical, just a reasonable "average-looking" placeholder
            // between the ambient floor and fully-lit ceiling -- revisit
            // if a real drag still looks visibly different from an idle
            // frame. Occlusion is also skipped in flat mode (its own
            // extra samples), matching the same "skip what's expensive,
            // approximate what's cheap to fake" reasoning.
            const float kFlatShadingDiffuseTerm = 0.5;
            float diffuseTerm = shadingFlat ? kFlatShadingDiffuseTerm : max(dot(normal, lightDir), 0.0);
            // Directional Occlusion Shading (§6.2) -- only meaningful
            // alongside shading, since it modulates the diffuse term.
            float occlusionFactor =
                (occlusionEnabled && !shadingFlat)
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
            // Composites the highlight exactly once per boundary crossing
            // (prevMaskClass==0 -> maskClass!=0), not on every step the
            // ray spends inside the mask. Compositing every step would
            // apply the same front-to-back formula the density pass uses
            // above, which approaches full opacity after enough steps
            // regardless of how low maskAlpha is set -- correct for a
            // literal semi-transparent substance, wrong for a boundary
            // highlight, where a thick mask region would end up darker
            // than a thin one at the same maskAlpha and the opacity
            // slider would lose most of its range. A single blend per
            // crossing, weighted by whatever transmittance (1-accum.a)
            // the volume has already accumulated up to that depth, keeps
            // maskAlpha meaning the same thing (this crossing's own
            // opacity) regardless of the mask's thickness along the ray,
            // and reads as a crisp highlighted surface rather than a
            // depth-blurred wash.
            if (maskClass != 0u && prevMaskClass == 0u)
            {
                accum.rgb += (1.0 - accum.a) * kMaskHighlightColor * maskAlpha;
                accum.a += (1.0 - accum.a) * maskAlpha;
            }
            prevMaskClass = maskClass;
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
