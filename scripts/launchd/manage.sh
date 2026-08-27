#!/bin/bash
# Simple control surface for the background auto-refresh setup — wraps the
# launchctl commands so you don't need to remember the syntax/labels.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
uid=$(id -u)

usage() {
  cat <<'EOF'
Usage: manage.sh {start|stop|pause|resume|status}

  start   Install (if needed) and start everything — Chrome, the window-hide
          helper, and the 5-min fetch timer. Safe to run again any time
          (re-syncs to the current plists in this folder).
  stop    Fully stop and remove all 3 agents, including quitting Chrome.
          Your signed-in session is preserved on disk either way — the next
          `start` just needs a few seconds to relaunch, not a fresh sign-in.
  pause   Stop just the fetch timer. Chrome keeps running in the background
          (signed in, ready) — lighter-weight than stop if you just want a
          break, and `resume` is instant since nothing needs to restart.
  resume  Re-enable the fetch timer after a pause.
  status  Show what's currently running and the last fetch's outcome.
EOF
  exit 1
}

cmd="${1:-}"

case "$cmd" in
  start)
    "$DIR/install.sh"
    ;;
  stop)
    "$DIR/uninstall.sh"
    ;;
  pause)
    if launchctl bootout "gui/${uid}/com.ap127.fetch" 2>/dev/null; then
      echo "Paused — fetch timer stopped, Chrome is still running (signed in, ready)."
      echo "Resume any time with: $0 resume"
    else
      echo "Fetch timer wasn't running (already paused, or never started — try '$0 start')."
    fi
    ;;
  resume)
    if [ ! -f "$AGENTS_DIR/com.ap127.fetch.plist" ]; then
      echo "Not installed yet — run '$0 start' first."
      exit 1
    fi
    if launchctl bootstrap "gui/${uid}" "$AGENTS_DIR/com.ap127.fetch.plist" 2>/dev/null; then
      echo "Resumed — fetch timer running again."
    else
      echo "Already running — check with '$0 status'."
    fi
    ;;
  status)
    echo "=== Agents ==="
    launchctl list | grep ap127 || echo "(none loaded — auto-refresh is off; run '$0 start')"
    echo
    echo "=== Chrome ==="
    if curl -sf http://localhost:9222/json/version >/dev/null 2>&1; then
      echo "Running, CDP responsive on port 9222."
    else
      echo "Not reachable."
    fi
    echo
    echo "=== Last fetch (tail of the log) ==="
    tail -5 "$HOME/Library/Logs/ap127-fetch.log" 2>/dev/null || echo "(no log yet)"
    ;;
  *)
    usage
    ;;
esac
