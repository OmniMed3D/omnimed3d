# Runs a command with the Emscripten SDK activated for this process only --
# no permanent/global environment changes (see engine/docs/adr/0003-ci-build-environment.md
# for why: portability across machines matters more than saving one `activate` call).
#
# Usage:
#   .\engine\scripts\emsdk-shell.ps1 "cmake --preset wasm-windows"
#   .\engine\scripts\emsdk-shell.ps1 "cmake --build build_wasm" -EmsdkDir C:\dev\emsdk
#
# Resolves the emsdk install location from $env:EMSDK if already set (e.g. by a
# prior manual `emsdk activate`), otherwise falls back to -EmsdkDir. No absolute
# path is hardcoded as a default -- every machine's emsdk lives wherever that
# machine's setup put it.

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Command,

    [string]$EmsdkDir = $env:EMSDK
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $EmsdkDir) {
    Write-Error "EMSDK not set and -EmsdkDir not passed. Install emsdk first (git clone https://github.com/emscripten-core/emsdk.git, then .\emsdk.bat install <version> && .\emsdk.bat activate <version>), then pass its path via -EmsdkDir or set `$env:EMSDK."
    exit 1
}

$EmsdkEnvBat = Join-Path $EmsdkDir "emsdk_env.bat"
if (-not (Test-Path $EmsdkEnvBat)) {
    Write-Error "emsdk not found at '$EmsdkDir' (expected emsdk_env.bat there)."
    exit 1
}

# NMake Makefiles (required generator -- see engine/CMakePresets.json's
# wasm-windows preset) needs nmake.exe, which isn't on PATH outside a VS
# Developer shell. Search installed MSVC toolsets rather than hardcoding one
# version, and use the newest found.
$nmakeDir = $null
$nmakeCandidates = Get-ChildItem `
    -Path "C:\Program Files\Microsoft Visual Studio\2022\*\VC\Tools\MSVC\*\bin\Hostx64\x64\nmake.exe" `
    -ErrorAction SilentlyContinue
if ($nmakeCandidates) {
    $nmakeDir = ($nmakeCandidates | Sort-Object FullName -Descending | Select-Object -First 1).DirectoryName
}

# Bridge via a temp .bat file rather than `cmd /c "call ... && $Command"` directly --
# avoids PowerShell -> cmd quote-escaping issues.
$tmpBat = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.bat'
try {
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("@echo off")
    $lines.Add("call `"$EmsdkEnvBat`"")
    # emsdk_env.bat's PATH additions aren't always reliably visible to the next
    # command in this cmd context; prepend the emcc/em++ directory explicitly.
    $emBin = Join-Path $EmsdkDir "upstream\emscripten"
    $lines.Add("set PATH=$emBin;%PATH%")
    # EmscriptenToolchain.cmake's Windows .bat-wrapper fix (CMAKE_AR/CMAKE_RANLIB)
    # is gated on `DEFINED ENV{EMSDK}` -- set it explicitly in case emsdk_env.bat's
    # export-style output isn't picked up in this cmd context.
    $lines.Add("set EMSDK=$EmsdkDir")
    if ($nmakeDir) {
        $lines.Add("set PATH=$nmakeDir;%PATH%")
    }
    $lines.Add($Command)

    [System.IO.File]::WriteAllText($tmpBat, ($lines -join "`r`n"), [System.Text.Encoding]::ASCII)
    cmd /c $tmpBat
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Remove-Item $tmpBat -ErrorAction SilentlyContinue
}
