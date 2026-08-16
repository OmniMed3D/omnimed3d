#!/usr/bin/env bash
# Runs a command with the Emscripten SDK activated for this process only --
# no permanent/global environment changes (see engine/docs/adr/0003-ci-build-environment.md
# for why: portability across machines matters more than saving one `activate` call).
# bash/zsh equivalent of emsdk-shell.ps1 -- simpler than that script because
# em++/emar are real executables on macOS, not .bat wrappers, so none of the
# .bat-bridging or nmake.exe version-search logic applies here.
#
# Usage:
#   ./engine/scripts/emsdk-shell.sh "cmake --preset wasm-macos"
#   ./engine/scripts/emsdk-shell.sh "cmake --build build_wasm" ~/emsdk
#
# Resolves the emsdk install location from $EMSDK if already set (e.g. by a
# prior manual `source emsdk_env.sh`), otherwise falls back to the second
# argument. No absolute path is hardcoded as a default -- every machine's
# emsdk lives wherever that machine's setup put it.

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: emsdk-shell.sh \"<command>\" [emsdk-dir]" >&2
    exit 1
fi

command="$1"
emsdk_dir="${2:-${EMSDK:-}}"

if [[ -z "$emsdk_dir" ]]; then
    echo "EMSDK not set and no emsdk-dir argument passed. Install emsdk first (git clone https://github.com/emscripten-core/emsdk.git, then ./emsdk install <version> && ./emsdk activate <version>), then pass its path as the second argument or set \$EMSDK." >&2
    exit 1
fi

emsdk_env="$emsdk_dir/emsdk_env.sh"
if [[ ! -f "$emsdk_env" ]]; then
    echo "emsdk not found at '$emsdk_dir' (expected emsdk_env.sh there)." >&2
    exit 1
fi

# shellcheck disable=SC1090
source "$emsdk_env" >/dev/null

eval "$command"
