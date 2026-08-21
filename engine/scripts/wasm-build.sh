#!/usr/bin/env bash
# Convenience wrapper around emsdk-shell.sh: runs the configure + build pair
# for the wasm-macos preset through a single emsdk activation, instead of
# invoking emsdk-shell.sh twice by hand (see that script's header and
# engine/docs/adr/0003-ci-build-environment.md -- emsdk stays session-only,
# not permanently registered, so bare `cmake --build` fails with
# `emar: command not found` outside this wrapper).
#
# Usage:
#   ./engine/scripts/wasm-build.sh [emsdk-dir]
#
# Resolves emsdk dir the same way emsdk-shell.sh does ($EMSDK if set, else
# the argument), falling back to ~/emsdk (this machine's documented install
# path -- CLAUDE.md sec7) only if neither is given.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine_dir="$(dirname "$script_dir")"
emsdk_dir="${1:-${EMSDK:-$HOME/emsdk}}"

cd "$engine_dir"
"$script_dir/emsdk-shell.sh" "cmake --preset wasm-macos && cmake --build build_wasm" "$emsdk_dir"
