#!/usr/bin/env bash
# Starts/stops the Vite dev server in the background and tracks it via a PID
# file -- macOS/Linux equivalent of dev-server.ps1's Start/Stop/Status
# actions (same PID-file convention and .dev-server.pid path).
#
# Usage (from viewer/, via the npm script wrappers in package.json):
#   npm run dev:start:mac
#   npm run dev:stop:mac
#   npm run dev:status:mac

set -euo pipefail

action="${1:-}"
if [[ "$action" != "start" && "$action" != "stop" && "$action" != "status" ]]; then
    echo "Usage: dev-server.sh {start|stop|status}" >&2
    exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
viewer_root="$(dirname "$script_dir")"
pid_file="$viewer_root/.dev-server.pid"
log_file="$viewer_root/.dev-server.log"
dev_url="http://localhost:5173/"

get_tracked_pid() {
    if [[ -f "$pid_file" ]]; then
        local pid
        pid="$(tr -d '[:space:]' < "$pid_file")"
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            echo "$pid"
            return 0
        fi
    fi
    return 1
}

# Recursively kills a process and its children -- `npm run dev` backgrounds
# as one PID but spawns node/vite as child processes that a plain `kill`
# would leave orphaned (same reasoning as dev-server.ps1's Win32_Process walk).
kill_tree() {
    local pid="$1"
    local child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        kill_tree "$child"
    done
    kill -9 "$pid" 2>/dev/null || true
}

case "$action" in
    start)
        if pid="$(get_tracked_pid)"; then
            echo "Dev server already running (PID $pid) -- $dev_url"
            exit 0
        fi
        cd "$viewer_root"
        nohup npm run dev > "$log_file" 2>&1 &
        echo $! > "$pid_file"
        echo "Dev server starting (PID $!) -- $dev_url"
        echo "(give it a couple seconds before opening the URL; logs: $log_file)"
        ;;
    stop)
        if pid="$(get_tracked_pid)"; then
            kill_tree "$pid"
            rm -f "$pid_file"
            echo "Dev server stopped (was PID $pid)."
        else
            echo "Dev server is not running."
            rm -f "$pid_file"
        fi
        ;;
    status)
        if pid="$(get_tracked_pid)"; then
            echo "Dev server running (PID $pid) -- $dev_url"
        else
            echo "Dev server is not running."
        fi
        ;;
esac
