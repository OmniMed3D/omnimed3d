# Convenience wrapper around emsdk-shell.ps1: runs the configure + build pair
# for the wasm-windows preset through a single emsdk activation, instead of
# invoking emsdk-shell.ps1 twice by hand (see that script's header and
# engine/docs/adr/0003-ci-build-environment.md -- emsdk stays session-only,
# not permanently registered).
#
# Usage:
#   .\engine\scripts\wasm-build.ps1
#   .\engine\scripts\wasm-build.ps1 -EmsdkDir C:\dev\emsdk
#
# Resolves emsdk dir the same way emsdk-shell.ps1 does ($env:EMSDK if set,
# else -EmsdkDir), falling back to C:\dev\emsdk (this machine's documented
# install path -- CLAUDE.md sec7) only if neither is given.

param(
    [string]$EmsdkDir = $(if ($env:EMSDK) { $env:EMSDK } else { "C:\dev\emsdk" })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
& "$scriptDir\emsdk-shell.ps1" "cmake --preset wasm-windows && cmake --build build_wasm" -EmsdkDir $EmsdkDir
