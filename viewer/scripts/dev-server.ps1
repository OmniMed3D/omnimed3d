# Starts/stops the Vite dev server in the background and tracks it via a
# PID file, so it can be started/stopped with simple one-line commands
# (npm run dev:start / dev:stop / dev:status) instead of having to keep a
# foreground terminal open for `npm run dev`.
#
# Usage (from viewer/, via the npm script wrappers in package.json):
#   npm run dev:start
#   npm run dev:stop
#   npm run dev:status

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Start", "Stop", "Status")]
    [string]$Action
)

$ErrorActionPreference = "Stop"

$ViewerRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ViewerRoot ".dev-server.pid"
$DevUrl = "http://localhost:5173/"

function Get-TrackedProcess {
    if (-not (Test-Path $PidFile)) {
        return $null
    }
    $processId = Get-Content $PidFile -Raw | ForEach-Object { $_.Trim() }
    if (-not $processId) {
        return $null
    }
    try {
        return Get-Process -Id $processId -ErrorAction Stop
    } catch {
        return $null
    }
}

switch ($Action) {
    "Start" {
        $existing = Get-TrackedProcess
        if ($existing) {
            Write-Output "Dev server already running (PID $($existing.Id)) -- $DevUrl"
            return
        }

        # npm.cmd directly (not "npm run dev") so the tracked PID is the
        # actual long-running process, not a wrapper shell that immediately
        # exits once it has spawned the real one.
        $proc = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev" `
            -WorkingDirectory $ViewerRoot -WindowStyle Hidden -PassThru
        Set-Content -Path $PidFile -Value $proc.Id -Encoding utf8
        Write-Output "Dev server starting (PID $($proc.Id)) -- $DevUrl"
        Write-Output "(give it a couple seconds before opening the URL)"
    }
    "Stop" {
        $existing = Get-TrackedProcess
        if (-not $existing) {
            Write-Output "Dev server is not running (no tracked process)."
            Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
            return
        }
        # Stop the whole process tree -- `npm.cmd run dev` spawns node/vite
        # as child processes that Stop-Process alone would leave orphaned.
        Get-CimInstance Win32_Process -Filter "ParentProcessId = $($existing.Id)" |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $existing.Id -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
        Write-Output "Dev server stopped (was PID $($existing.Id))."
    }
    "Status" {
        $existing = Get-TrackedProcess
        if ($existing) {
            Write-Output "Dev server running (PID $($existing.Id)) -- $DevUrl"
        } else {
            Write-Output "Dev server is not running."
        }
    }
}
