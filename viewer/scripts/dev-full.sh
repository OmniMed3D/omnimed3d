#!/usr/bin/env bash
# One-shot pipeline for local iteration: build the engine's WASM target,
# sync the resulting artifacts into viewer/src/shell/public/engine/, then
# start the dev server -- macOS/Linux equivalent of dev-full.ps1, collapsing
# the three manual steps (engine/scripts/wasm-build.sh -> npm run
# sync-engine-wasm -> npm run dev:start:mac) into one command.
#
# Usage (from viewer/):
#   npm run dev:full:mac
#   npm run dev:full:mac -- ~/emsdk

set -euo pipefail

emsdk_dir="${1:-}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
viewer_root="$(dirname "$script_dir")"
repo_root="$(dirname "$viewer_root")"
engine_root="$repo_root/engine"

echo "==> [1/3] Building engine WASM target..."
"$engine_root/scripts/wasm-build.sh" "$emsdk_dir"

echo "==> [2/3] Syncing engine WASM artifacts into viewer..."
cd "$viewer_root"
node scripts/sync-engine-wasm.mjs

echo "==> [3/3] Starting dev server..."
"$script_dir/dev-server.sh" start
