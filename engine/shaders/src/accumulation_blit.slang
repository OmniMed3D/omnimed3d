// Blits the persistent raymarch accumulation buffer to the swapchain -- a
// trivial full-screen-triangle passthrough, no UBO. Kept as its own tiny
// shader/pipeline (not folded into volume_raymarch.slang) since it reads a
// different texture with different bindings and runs in a separate render
// pass -- the raymarch pass can't present directly to the swapchain and
// self-blend against its own history in one pass, because the swapchain
// returns a different physical texture every frame (WebGPUDevice.hpp's
// accumulationTexture_ comment has the full reasoning).

[[vk::binding(0, 0)]] Texture2D<float4> accumulationTex;
[[vk::binding(1, 0)]] SamplerState blitSampler;

struct VertexOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

// Same full-screen-triangle trick as the other shaders in this repo --
// see volume_raymarch.slang's vertexMain for why it's duplicated rather
// than shared.
[shader("vertex")]
VertexOutput vertexMain(uint vertexIndex : SV_VertexID)
{
    VertexOutput output;
    float x = float((vertexIndex << 1) & 2) * 2.0 - 1.0;
    float y = float(vertexIndex & 2) * 2.0 - 1.0;
    output.position = float4(x, y, 0.0, 1.0);
    output.uv = float2(x * 0.5 + 0.5, 0.5 - y * 0.5);
    return output;
}

[shader("fragment")]
float4 fragmentMain(VertexOutput input) : SV_Target
{
    return accumulationTex.SampleLevel(blitSampler, input.uv, 0.0);
}
