#!/bin/bash
set -uo pipefail   # deliberately NOT -e — one failed cycle must not kill the loop

# Runs scripts/fetch_schedule.py against the sibling `chromium` service (see
# FETCH_CDP_ENDPOINT, set in ../docker-compose.yml) every
# $FETCH_INTERVAL_SECONDS, then commits+pushes any changed data and pings
# CMDV2's refresh workflow. See ../README.md for the full picture and setup.
#
# Simplification vs. .github/workflows/fetch_schedule.yml, deliberate: no
# portal-outage backoff here. That logic exists specifically because CI's
# Playwright-launched browser ALWAYS fails against the Ops Portal's Google
# sign-in wall, so throttling matters there (see fetch_schedule.py's
# _get_content_frame() docstring + CMD_CTR/CLAUDE.md's 2026-08-25 entries).
# This container instead uses a real, persistently-authenticated Chromium
# session and shouldn't hit that specific failure mode in normal operation.
# If it starts failing repeatedly, that's a different situation (the session
# itself needs attention — see "Session expired" in ../README.md) that
# backoff wouldn't meaningfully help with anyway. fetch_schedule.py's own
# internal MAX_ATTEMPTS/RETRY_DELAY_S retry (3 attempts, 20s/40s backoff)
# still applies within every single invocation regardless.

INTERVAL="${FETCH_INTERVAL_SECONDS:-300}"

if [ -z "${GH_PAT:-}" ]; then
  echo "FATAL: GH_PAT is not set — see ../README.md for how to create docker/.env" >&2
  exit 1
fi

# First run: clone if /repo is empty. Subsequent container restarts reuse
# whatever's already there (the ../repo bind mount persists it on the host).
if [ ! -d /repo/.git ]; then
  echo "No repo checked out yet — cloning…"
  git clone "https://x-access-token:${GH_PAT}@github.com/AP127CMD/CMD_CTR" /repo
fi

cd /repo
git config user.name "ap127-orangepi4"
git config user.email "ap127-orangepi4@users.noreply.github.com"
git remote set-url origin "https://x-access-token:${GH_PAT}@github.com/AP127CMD/CMD_CTR"

while true; do
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) — starting fetch ==="

  # A failed cycle leaves an uncommitted backoff_state.json bump behind
  # (only committed on the success path below) — without this, every cycle
  # after a failure would fail the pull forever. Pure bookkeeping, not
  # precious; this cycle's own outcome rewrites it anyway.
  git checkout -- data/backoff_state.json 2>/dev/null || true

  if ! git pull --rebase origin main; then
    echo "git pull failed — skipping this cycle" >&2
    sleep "$INTERVAL"
    continue
  fi

  if python3 scripts/fetch_schedule.py; then
    python3 scripts/generate_flight_data.py

    git add data/flight_schedule.json flight-data.js flight-data-recent.js \
      data/portal_fingerprint.json data/backoff_state.json
    if git diff --cached --quiet; then
      echo "No data changes — skipping commit."
    else
      git commit -m "chore: update flight data $(date -u +%Y-%m-%dT%H:%M:%SZ) (orangepi4)"
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

      if [ "$pushed" = true ]; then
        echo "Triggering CMDV2 refresh…"
        curl -sf -X POST \
          -H "Authorization: Bearer ${GH_PAT}" \
          -H "Accept: application/vnd.github.v3+json" \
          -H "Content-Type: application/json" \
          https://api.github.com/repos/AP127CMD/CMDV2/actions/workflows/refresh-data.yml/dispatches \
          -d '{"ref":"main"}' \
          && echo "CMDV2 refresh-data.yml dispatched" \
          || echo "WARNING: CMDV2 refresh dispatch failed (non-fatal)" >&2
      else
        echo "WARNING: push failed after 5 attempts — data committed locally, will retry pushing next cycle too" >&2
      fi
    fi
  else
    echo "Fetch failed — see fetch_schedule.py's own retry/backoff-state output above."
    echo "If this keeps happening, open http://<this-pi>:3000 and check the Chromium session is still signed in (see 'Session expired' in ../README.md)."
  fi

  echo "=== sleeping ${INTERVAL}s ==="
  sleep "$INTERVAL"
done
