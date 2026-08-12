# ADR-0004: Shared DICOM parser library (native + Parse Worker WASM)

| Field  | Value      |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-08-11 |

> **Update (2026-08-11):** the *location* decision in this ADR's
> Consequences section (`engine/src/assets/`) was superseded the same day
> by `docs/adr/0001-shared-dicom-parser-module.md` (repo-root, cross-team)
> — the library now lives at top-level `dicom-parser/`, a sibling of
> `engine/`, not nested inside it. Everything else in this ADR (three
> build targets, buffer-first parsing API, why unification now) still
> holds; only the physical path changed.

## Context

The engine owner is now also implementing the Parse Worker (REQ-A05, PRD
§5.2/§6.2) — a staffing decision, not a PRD change (the PRD's own §6.2
diagram still labels Parse Worker "AI Track"; that categorization is about
product domain, not who writes the code).

`claude.md` §6.2's already-decided "Parser Redundancy Reconciliation"
(2026-08-06) established that the engine's own browser rendering WASM build
must exclude its DICOM parser entirely — the browser rendering path
consumes only the Parse Worker's HU volume buffer output. That decision
stands. What's newly in question is: given the same person now writes both
the engine's native/test-fixture parser AND the Parse Worker's parser,
should they be two independent implementations, or one shared library?

PRD §10.1 already flags "Redundant parsing between AI Parse Worker and
Rendering Engine" as a named risk (duplicated parsing overhead, load time
and RAM cost), with "plan single-parser unification in post-MVP phases" as
the noted mitigation. Given one person now owns both call sites, doing the
unification now — rather than deferring it post-MVP — avoids writing a real
DICOM parser (Explicit/Implicit VR, RLE/JPEG2000/legacy JPEG transfer
syntaxes) twice under a 16-day deadline.

## Decision

One C++ DICOM parser library, compiled to three targets:

1. **Native** — engine dev/test builds, `tests/parity/` fixtures (REQ-C03).
2. **A new WASM target for the Parse Worker** — a separate build output
   from the engine's own rendering WASM (`wasm_smoke` and its eventual
   successors).
3. **Never linked into the engine's rendering WASM build.** This is not
   new — it's the existing 2026-08-06 decision, restated here because it's
   now load-bearing for how the shared library's CMake wiring must be
   structured (three consumers, one of which is a hard exclusion, not just
   "unused").

**API shape: parse from an in-memory buffer, not a file path.**
`DicomFile::parseFromBuffer(std::byte const* data, size_t size)` is the
entire parsing surface. The library itself never does filesystem I/O. This
is what makes it WASM-safe by construction — `CLAUDE.md` §9 "No host
filesystem on WASM": the real Parse Worker receives bytes from the
browser's File API via JS (`postMessage`/`Transferable`, REQ-A15), not a
WASM-side file read. Native disk I/O (reading a file into memory, then
calling `parseFromBuffer`) is a thin wrapper used only by native tooling
(`dicom_inspect`, `tests/parity/` fixtures), never part of the shared
library itself.

## Consequences

- ~~`engine/src/assets/` becomes the home for `DicomFile.hpp`/`.cpp`~~ —
  superseded same-day by `docs/adr/0001-shared-dicom-parser-module.md`:
  lives at top-level `dicom-parser/` instead (see that ADR for why).
  `engine/src/assets/` reverts to empty/scaffolded, reserved for
  genuinely engine-only asset work.
- `engine/CMakeLists.txt` adds `add_subdirectory(...)` for the sibling
  `dicom-parser/` directory unconditionally (like `core`/`concurrency`) —
  the library must build clean under both the native and `EMSCRIPTEN`
  toolchains without a guard, by design.
- Any future PR that adds pixel-data transfer-syntax support to this
  library changes behavior for both native and the real Parse Worker
  simultaneously — this is the intended benefit (no drift between two
  independent parsers), but it also means a bug here has two blast
  radii, not one. Test against both targets, not just native.
- The Parse Worker's actual JS/TS side (the real Worker, `postMessage`
  wiring) is separate follow-up work — this ADR only settles the C++
  library's shape and build topology, not the Worker's JS glue.

## Alternatives Considered

- **Two independent parsers** (engine's native/test parser stays as
  originally scoped; Parse Worker gets its own separate implementation,
  e.g. a JS library like `dcmjs` or a from-scratch second C++ parser).
  Rejected: this is exactly the redundant-parsing risk PRD §10.1 already
  named, and there is no longer a staffing reason to keep them separate
  now that one person owns both. Two DICOM parsers is meaningfully more
  work than one under this project's timeline, for no benefit once both
  are owned by the same person.
