#!/bin/bash
set -uo pipefail   # deliberately NOT -e — we want to control exit paths explicitly

# One-command manual data refresh, for whenever the automated pipeline can't
# run — which as of 2026-08-26 is ALWAYS, since fetch_schedule.yml is
# disabled (see CLAUDE.md's 2026-08-26 entry) until the Orange Pi Zero 2W
# pipeline (docker/, being built for that board) is live and proven.
#
# Usage:
#   ./scripts/manual_refresh.sh
#
# What it does, same technique proven live 2026-08-25 (see
# fetch_schedule.py's _get_content_frame() docstring for why the automated
# scraper can't do this itself — Google's bot-detection blocks a
# Playwright-launched browser from signing in, but a plain, unflagged
# Chrome window signs in completely normally):
#   1. Opens (or reuses, if already running) a real, plain Chrome window
#      with a PERSISTENT profile — you sign into Google ONCE, ever, not
#      once per run. Never launched by Playwright/any automation tool, so
#      Google has no reason to flag it.
#   2. Waits for that tab to actually reach the portal (i.e. for you to
#      finish signing in, if this is the first run or the session expired).
#   3. Runs the normal fetch_schedule.py against it over CDP.
#   4. Commits + pushes any changed data, and pings CMDV2's refresh
#      workflow — the exact same steps fetch_schedule.yml's later steps do.
#
# Requires: Google Chrome installed, `gh` CLI authenticated (for the CMDV2
# refresh trigger — everything else uses plain git).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="$HOME/.ap127-manual-chrome-profile"
CDP_PORT=9222
SCRIPT_URL="https://script.google.com/macros/s/AKfycbx-8p8MWbDAeJkTBPt4Yy_6cH0azSv-5VXcrzVhIUGM6XEJRtMBQNku-WybzNlhq9zN/exec"

cd "$REPO_ROOT"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) — manual refresh starting ==="

# Discard noise Finder/macOS writes into the working tree on its own (never
# real work) so it can't block the rebase below — see 2026-08-27 incident.
git checkout -- .DS_Store 2>/dev/null || true

if ! git pull --rebase origin main; then
  echo "git pull failed — likely uncommitted changes in the way. Current status:" >&2
  git status --short >&2
  echo "Resolve the above (commit, stash, or discard as appropriate) and try again." >&2
  exit 1
fi

# --- 1. Make sure a real, plain Chrome is running with the persistent profile ---
if curl -sf "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo "Reusing already-running Chrome (port ${CDP_PORT})."
else
  echo "Starting Chrome — this is a real, unmodified browser window. Sign into"
  echo "Google there if/when asked (only needed the first time, or after the"
  echo "session eventually expires)."
  mkdir -p "$PROFILE_DIR"
  open -na "Google Chrome" --args \
    --remote-debugging-port="${CDP_PORT}" \
    --user-data-dir="${PROFILE_DIR}" \
    --no-first-run --no-default-browser-check \
    "$SCRIPT_URL"
  for i in $(seq 1 20); do
    curl -sf "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1 && break
    sleep 1
  done
fi

# --- 2. Wait until the tab has actually reached the portal (past sign-in) ---
echo "Waiting for the portal to be ready (up to 10 min — sign in now if prompted)…"
READY=false
for i in $(seq 1 120); do
  URL=$(curl -s "http://localhost:${CDP_PORT}/json" 2>/dev/null | python3 -c "
import json, sys
try:
    tabs = json.load(sys.stdin)
except Exception:
    print('')
    raise SystemExit
for t in tabs:
    if t.get('type') == 'page' and 'script.google.com' in (t.get('url') or ''):
        print(t.get('url'))
        break
" 2>/dev/null)
  if [[ "$URL" == https://script.google.com* ]]; then
    READY=true
    break
  fi
  sleep 5
done

if [ "$READY" != true ]; then
  echo "Gave up waiting after 10 minutes — no tab reached the portal (still on" >&2
  echo "the sign-in screen, or Chrome/the tab isn't there). Check the Chrome" >&2
  echo "window and run this script again once signed in." >&2
  exit 1
fi

echo "Portal ready — fetching (this normally takes a few minutes)…"

# --- 3. Run the actual fetch — the exact code path CI normally uses -------
FETCH_CDP_ENDPOINT="http://localhost:${CDP_PORT}" python3 scripts/fetch_schedule.py
FETCH_EXIT=$?

if [ "$FETCH_EXIT" -ne 0 ]; then
  echo "Fetch failed — see output above. Chrome is left running at" >&2
  echo "http://localhost:${CDP_PORT} in case you want to check it manually." >&2
  exit 1
fi

python3 scripts/generate_flight_data.py

# --- 4. Commit + push + trigger CMDV2 --------------------------------------
git add data/flight_schedule.json flight-data.js flight-data-recent.js \
  data/portal_fingerprint.json data/backoff_state.json
if git diff --cached --quiet; then
  echo "No data changes — nothing to push."
  echo "=== Manual refresh complete (already up to date) ==="
  exit 0
fi

git commit -m "chore: update flight data $(date -u +%Y-%m-%dT%H:%M:%SZ) (manual refresh)"

pushed=false
for attempt in 1 2 3 4 5; do
  if git push origin main; then
    echo "Pushed on attempt $attempt"
    pushed=true
    break
  fi
  echo "Push rejected — syncing with remote (attempt $attempt)…"
  git fetch origin main
  git rebase -X theirs origin/main || { git rebase --abort; break; }
  sleep $((attempt * 3))
done

if [ "$pushed" != true ]; then
  echo "Push failed after 5 attempts — data is committed locally. Push manually with 'git push' once resolved." >&2
  exit 1
fi

echo "Triggering CMDV2 refresh…"
if gh api -X POST repos/AP127CMD/CMDV2/actions/workflows/refresh-data.yml/dispatches -f ref=main >/dev/null 2>&1; then
  echo "Done — CMDV2 will show fresh data within about a minute."
else
  echo "WARNING: couldn't trigger CMDV2's refresh (non-fatal — its own hourly cron will pick this up regardless)." >&2
fi

echo "=== Manual refresh complete ==="
