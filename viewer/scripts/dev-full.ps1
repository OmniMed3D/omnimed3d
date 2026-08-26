# One-shot pipeline for local iteration: build the engine's WASM target,
# sync the resulting artifacts into viewer/src/shell/public/engine/, then
# start the dev server -- collapses the three manual steps (see engine's
# CLAUDE.md sec7 / viewer/scripts/sync-engine-wasm.mjs / dev-server.ps1) into
# one command. Windows-only, matching dev-server.ps1's existing scope --
# macOS/Linux devs run engine/scripts/wasm-build.sh + the npm steps by hand.
#
# Usage (from viewer/):
#   npm run dev:full
#   npm run dev:full -- -EmsdkDir C:\dev\emsdk

param(
    [string]$EmsdkDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ViewerRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $ViewerRoot
$EngineRoot = Join-Path $RepoRoot "engine"

Write-Output "==> [1/3] Building engine WASM target..."
if ($PSBoundParameters.ContainsKey("EmsdkDir")) {
    & "$EngineRoot\scripts\wasm-build.ps1" -EmsdkDir $EmsdkDir
} else {
    & "$EngineRoot\scripts\wasm-build.ps1"
}

Write-Output "==> [2/3] Syncing engine WASM artifacts into viewer..."
Push-Location $ViewerRoot
try {
    node scripts/sync-engine-wasm.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Output "==> [3/3] Starting dev server..."
    & "$PSScriptRoot\dev-server.ps1" -Action Start
} finally {
    Pop-Location
}
