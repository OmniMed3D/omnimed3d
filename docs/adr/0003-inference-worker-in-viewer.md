# ADR-0003: Inference Worker lives inside `viewer/`, not `ai-pipeline/`

| Field  | Value      |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-08-13 |

## Context

The Inference Worker (REQ-A03/A09/A16/A17) was first built at
`ai-pipeline/inference/` as its own npm package, alongside `ai-pipeline`'s
existing Python tooling (`conversion/`, `quantization/`). A teammate
(Engine track) proposed instead placing it — along with the Parse Worker —
under a new `viewer/src/workers/` directory, next to the Web Application
Shell (REQ-R06):

```text
viewer/src/
  shell/                Web Application Shell
  workers/
    parse-worker/        dicom-parser (WASM) + HU conversion (REQ-A05)
    inference-worker/     model adapter preprocess/infer/postprocess (REQ-A04/A17)
```

This needs cross-team agreement (not a module-local call) because `viewer/`
is currently documented in `CONTRIBUTING.md`/`CODEOWNERS` as entirely
Engine-track-owned, and moving AI-track code into it changes that.

## Decision

The Inference Worker's source moves to `viewer/src/workers/inference-worker/`
(this ADR's scope; the Parse Worker's placement is Engine track's own
call, following REQ-A05's 2026-08-12 update assigning it dicom-parser/WASM
ownership). `ai-pipeline/` keeps only the offline Python tooling
(`conversion/`, `quantization/`) that produces the `.onnx` model artifacts
the Inference Worker loads at runtime as static assets — a data dependency,
not a code dependency, so it does not need to share a source tree.

`CODEOWNERS` gets a path-specific override for the subtree
(`/viewer/src/workers/inference-worker/ @hyuniverse`), placed after the
blanket `/viewer/ @nowead` rule per the file's documented
later-pattern-wins order.

**Test:** the deciding factor is *number of independent consumers*, the
same test that put `dicom-parser/` at the repo root — it's shared by two
independent build targets (engine native + Parse Worker WASM). The
Inference Worker has exactly one consumer (this web app), so there's no
analogous reuse case for keeping it as an arm's-length package; it belongs
in the project that actually bundles and ships it.

## Consequences

- Inference Worker, Parse Worker, and Shell can share one build/bundler
  setup once Engine track scaffolds `viewer/`'s root tooling — no
  cross-package wiring needed for Worker bundling (Vite/webpack worker
  plugins generally expect the entry file inside the same project graph).
- `viewer/` is no longer single-owner; PR review routing for
  `inference-worker/` now follows the CODEOWNERS override, not the
  directory's blanket rule. Both tracks should treat `viewer/`'s root
  build config (bundler choice, shared tsconfig/lint baseline) as a joint
  decision going forward.
- `ai-pipeline/inference/` no longer exists; anything referencing that path
  (docs, scripts) should point at `viewer/src/workers/inference-worker/`
  instead.
- The Inference Worker currently keeps its own self-contained
  `package.json`/`node_modules` rather than an npm workspace member of a
  `viewer/`-root workspace, since that root doesn't exist yet — whoever
  scaffolds `viewer/`'s Shell can fold it into a workspace at that point
  without changing where the source lives.

## Alternatives Considered

- **Keep it in `ai-pipeline/inference/` as an independent package.**
  Rejected — no independent consumer exists to justify the indirection
  (see Decision), and it defers the Worker-bundling integration problem
  rather than solving it.
- **`ai-pipeline/inference/`, referenced by `viewer/` via npm workspaces.**
  A middle ground keeping the source under AI-track's existing directory
  while still getting single-bundle-graph benefits. Rejected in favor of
  physical co-location: workspace-linking is the right tool when there's a
  genuine reuse boundary, which isn't the case here, and it would add
  mechanical indirection without reflecting any real architectural
  boundary.
- **A new, track-neutral top-level directory (e.g. `client/`) instead of
  reusing `viewer/`.** This was the pre-repo external discussion's
  original instinct (see `docs/ai-track-decisions.md` #1). Rejected as
  not worth reopening: `viewer/` is already the established, documented
  name for "the frontend web app" in `CONTRIBUTING.md`; the ownership
  question is fully addressed by the `CODEOWNERS` subtree override above,
  and the directory's name carries no additional architectural weight
  beyond that.
