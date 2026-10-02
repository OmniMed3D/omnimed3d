/**
 * Serves ONNX model files out of R2 instead of Cloudflare Pages, since the
 * INT8 (~28MiB) and FP16 (~55MiB) lungmask variants both exceed Pages'
 * ~25MiB per-file static asset limit. Only top-level ".onnx" keys are
 * served (no subpaths, restricted filename characters) so this never turns
 * into an open proxy for whatever else ends up in the bucket.
 */
export interface Env {
  MODEL_BUCKET: R2Bucket;
}

function isAllowedKey(key: string): boolean {
  return /^[\w-]+\.onnx$/.test(key);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = new URL(request.url).pathname.replace(/^\//, "");
    if (!isAllowedKey(key)) {
      return new Response("Not found", { status: 404 });
    }

    const object = await env.MODEL_BUCKET.get(key);
    if (!object) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    // The Inference Worker fetches this cross-origin from the Pages
    // domain, which runs under COEP: require-corp -- without this header
    // the browser blocks the response outright.
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    // Short TTL, not "immutable": these filenames stay stable across model
    // re-quantization, so a long-lived cache would keep serving a stale
    // model after a content update.
    headers.set("Cache-Control", "public, max-age=3600");

    return new Response(object.body, { headers });
  },
};
