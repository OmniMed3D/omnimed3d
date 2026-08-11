# ADR-0001: `dicom-parser/` as a top-level shared module

| Field  | Value      |
| ------ | ---------- |
| Status | Accepted   |
| Date   | 2026-08-11 |

## Context

This is the first repo-root ADR (`claude.md` §6's ADR split: repo-root
`docs/adr/` is for cross-team architectural decisions the whole monorepo
needs to agree on; module-scoped decisions live in each module's own
`docs/adr/`, e.g. `engine/docs/adr/`).

The DICOM parser (`engine/docs/adr/0004-shared-dicom-parser.md`) is a
single C++ library consumed by two independent build targets: the engine's
native/test builds, and (eventually) the Parse Worker's WASM build. It was
initially placed at `engine/src/assets/`, following the existing
engine-only "asset pipeline" location `claude.md` §6 already documented.
That placement was reconsidered: a library two independent deliverables
both depend on shouldn't live inside either one — if the Parse Worker ends
up living outside `engine/` (its exact location is still undecided, see
below), it would need to reach into `engine/`'s internal source tree to
get code it depends on, which is a backwards dependency direction and muddies
what `engine/`'s own build actually produces.

This changes `CONTRIBUTING.md`'s documented structure of four sibling
modules (`engine/`, `viewer/`, `ai-pipeline/`, `infra/`), each with its own
`CODEOWNERS` entry — hence a repo-root ADR rather than an engine-scoped one,
even though (for now) the same person owns both consumers.

## Decision

`dicom-parser/` is a new top-level directory, a sibling of `engine/`,
`viewer/`, `ai-pipeline/`, `infra/`:

```text
dicom-parser/
  CMakeLists.txt              STATIC library `dicom_parser`, alias dicom::parser
  include/dicom-parser/
    DicomFile.hpp
  src/
    DicomFile.cpp
```

It is not configured/built standalone — consumers `add_subdirectory()` it
from their own `CMakeLists.txt` (see `engine/CMakeLists.txt` for the
pattern: `add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../dicom-parser ...)`).
This mirrors how `engine/`'s own internal modules (`core`, `concurrency`,
`rhi`) are structured, just one level up.

`CONTRIBUTING.md`'s module list and `.github/CODEOWNERS` are updated to
include it (see those files' own history for the exact change) — owned by
@nowead for now, since they're the one implementing both consumers
currently; revisit if/when the Parse Worker's ownership changes.

## Consequences

- `engine/src/assets/` reverts to empty (scaffolded, `.gitkeep` only) — it
  remains reserved for genuinely engine-only asset-pipeline work (e.g. a
  future NIfTI loader, if that stays engine-only), not shared code.
- Any future code genuinely shared between `engine/` and another module
  (not just DICOM parsing) has a precedent to follow: a new top-level
  sibling directory, not nesting inside whichever module happened to need
  it first.
- The Parse Worker's own location (inside `viewer/`? a new top-level
  directory of its own?) is still undecided — this ADR only settles where
  the shared C++ library lives, not the Worker's JS/TS side.

## Alternatives Considered

- **Keep it in `engine/src/assets/`.** Rejected — see Context: backwards
  dependency direction once the Parse Worker's actual location is decided,
  and it was cheap to fix now (two files) versus later (more accumulated
  code depending on the wrong location).
- **`engine/dicom/` — its own top-level directory inside `engine/`, not
  nested under `src/assets/`, but still inside the engine module.**
  Rejected in favor of a repo-root sibling: it would still formally sit
  inside `engine/`'s `CODEOWNERS` boundary even though it isn't
  engine-exclusive code, which was judged more likely to cause confusion
  later than a new top-level directory now.
