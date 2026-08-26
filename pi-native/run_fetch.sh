#!/bin/bash
set -uo pipefail

# One fetch cycle — invoked by ap127-fetch.timer every 5 min (systemd handles
# the repeating; this script just does one run and exits, unlike the Docker
# version's internal while-loop in ../docker/fetch-cron/run_fetch.sh, which
# this is otherwise a straight port of). Runs natively (no Docker) — chosen
# deliberately for the Orange Pi Zero 2W's 1GB RAM: Docker's own daemon/
# containerd overhead is real weight this board doesn't have to spare when
# it's dedicated to exactly one job. See ../README.md for the full picture.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -z "${GH_PAT:-}" ]; then
  echo "FATAL: GH_PAT not set — check pi-native/.env (see pi-native/README.md)" >&2
  exit 1
fi

git remote set-url origin "https://x-access-token:${GH_PAT}@github.com/AP127CMD/CMD_CTR"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) — starting fetch ==="

if ! git pull --rebase origin main; then
  echo "git pull failed — skipping this cycle" >&2
  exit 1
fi

if ! python3 scripts/fetch_schedule.py; then
  echo "Fetch failed — see fetch_schedule.py's own retry/backoff-state output above."
  echo "If this keeps happening across many cycles, the Chromium session"
  echo "likely needs re-authenticating — see 'Session expired' in README.md."
  exit 1
fi

python3 scripts/generate_flight_data.py

git add data/flight_schedule.json flight-data.js flight-data-recent.js \
  data/portal_fingerprint.json data/backoff_state.json
if git diff --cached --quiet; then
  echo "No data changes — nothing to commit."
  exit 0
fi

git commit -m "chore: update flight data $(date -u +%Y-%m-%dT%H:%M:%SZ) (orangepi-zero2w)"

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
  echo "WARNING: push failed after 5 attempts — will retry next cycle too." >&2
  exit 1
fi

echo "Triggering CMDV2 refresh…"
curl -sf -X POST \
  -H "Authorization: Bearer ${GH_PAT}" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/AP127CMD/CMDV2/actions/workflows/refresh-data.yml/dispatches \
  -d '{"ref":"main"}' \
  && echo "CMDV2 refresh-data.yml dispatched" \
  || echo "WARNING: CMDV2 refresh dispatch failed (non-fatal)" >&2
