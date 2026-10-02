# model-proxy

Cloudflare Worker that serves the lungmask INT8/FP16 ONNX model files out
of R2. They don't go through Cloudflare Pages directly because Pages caps
static assets at ~25MiB per file, and both variants exceed that (INT8
~28MiB, FP16 ~55MiB).

See `.github/workflows/deploy.yml` for how this fits into the build: on
every push to `main`, it uploads whatever `.onnx` files are committed
under `viewer/src/shell/public/models/` to R2, strips them out of the
Pages bundle, and deploys this Worker so they're servable at runtime.

## One-time setup (not done by CI)

1. `npx wrangler login` -- browser auth, needed once per machine before
   any of the commands below will work locally.
2. Create the R2 bucket this Worker's `wrangler.toml` binds to:
   ```
   npx wrangler r2 bucket create omnimed3d-models
   ```
3. Create the Cloudflare Pages project (the CI workflow's
   `wrangler pages deploy --project-name=omnimed3d` expects it to already
   exist -- it won't create one non-interactively):
   ```
   npx wrangler pages project create omnimed3d
   ```
4. Register `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub
   repo secrets (Settings -> Secrets and variables -> Actions). The token
   needs Account-scoped `Cloudflare Pages: Edit`, `Workers R2 Storage:
   Edit`, and `Workers Scripts: Edit` permissions.

## Getting the model URL into the app

After the first deploy, this Worker is reachable at
`https://omnimed3d-model-proxy.<your-workers.dev-subdomain>.workers.dev/`.
The Inference Worker's `modelBasePath` (see
`viewer/src/workers/inference-worker/src/worker.ts`'s `InitMessage`) needs
to point there in production instead of the dev-only `/models/lungmask_r231`
relative path -- e.g.
`https://omnimed3d-model-proxy.<subdomain>.workers.dev/lungmask_r231`.
That value is set in `viewer/src/shell/` (Shell-owned), not here.
