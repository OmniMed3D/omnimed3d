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

// Also applied to 404s -- a cross-origin fetch() reads this header
// regardless of status code, and without it a genuine 404 shows up in the
// browser as an opaque CORS error instead, which is what sent the "CORS
// error" on an empty bucket down the wrong path while debugging this.
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = new URL(request.url).pathname.replace(/^\//, "");
    if (!isAllowedKey(key)) {
      return notFound();
    }

    const object = await env.MODEL_BUCKET.get(key);
    if (!object) {
      return notFound();
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    // writeHttpMetadata() doesn't include this -- without it,
    // fetchModelBytes() in the Inference Worker treats the download as
    // size-unknown and shows cumulative bytes instead of a percentage.
    headers.set("Content-Length", String(object.size));
    // The Inference Worker fetches this cross-origin from the Pages
    // domain, which runs under COEP: require-corp -- without this header
    // the browser blocks the response outright.
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    // CORP alone satisfies COEP, but fetch()'s default `mode: "cors"`
    // separately requires this before the script can read the response
    // body at all -- without it, the browser surfaces a CORS error before
    // COEP ever comes into play. The model is public, non-sensitive data,
    // so a wildcard is fine (no credentials involved).
    headers.set("Access-Control-Allow-Origin", "*");
    // Short TTL, not "immutable": these filenames stay stable across model
    // re-quantization, so a long-lived cache would keep serving a stale
    // model after a content update.
    headers.set("Cache-Control", "public, max-age=3600");

    return new Response(object.body, { headers });
  },
};
