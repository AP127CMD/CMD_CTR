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

# Failure alerting — mirrors .github/workflows/fetch_schedule.yml's own
# "Report/Close fetch-failure issue" steps, so a Pi-side failure surfaces the
# same way a CI-side one does (a GitHub issue → normal GitHub notification/
# email, if you're watching this repo). Deliberately a DIFFERENT label
# (`fetch-failure-pi`, not `fetch-failure`) — the two systems fail
# independently for different reasons (Chromium/session/RAM on the Pi vs.
# runner/portal issues in CI), so conflating them under one label would hide
# "only one of the two is actually down."
report_pi_failure() {
  local existing
  existing=$(curl -sf -H "Authorization: Bearer ${GH_PAT}" \
    "https://api.github.com/repos/AP127CMD/CMD_CTR/issues?state=open&labels=fetch-failure-pi" \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null) || existing=0
  if [ "${existing:-0}" -gt 0 ]; then
    return 0  # already an open issue — don't spam a new one every 5 min
  fi
  local now title body
  now="$(date -u +%Y-%m-%dT%H:%MZ)"
  title="[Pi Fetch] Run failed – ${now} UTC"
  body="Orange Pi Zero 2W fetch cycle failed at ${now} UTC.\\n\\nCheck: \`ssh dietpi@<pi-ip> journalctl -u ap127-fetch -n 50\` or the Mac monitor dashboard.\\n\\nGitHub Actions' own fetch keeps running independently — check ap127-cmd-ctr.pages.dev's fetchedAt if you need to know whether data is still current regardless."
  curl -sf -X POST -H "Authorization: Bearer ${GH_PAT}" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/AP127CMD/CMD_CTR/issues" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"title": sys.argv[1], "body": sys.argv[2].replace("\\n", "\n"), "labels": ["fetch-failure-pi"]}))' "$title" "$body")" \
    >/dev/null 2>&1 && echo "Opened fetch-failure-pi issue." || echo "WARNING: could not open failure issue." >&2
}

close_pi_failure_if_open() {
  local issues
  issues=$(curl -sf -H "Authorization: Bearer ${GH_PAT}" \
    "https://api.github.com/repos/AP127CMD/CMD_CTR/issues?state=open&labels=fetch-failure-pi" \
    | python3 -c 'import json,sys; print(" ".join(str(i["number"]) for i in json.load(sys.stdin)))' 2>/dev/null) || return 0
  for n in $issues; do
    curl -sf -X POST -H "Authorization: Bearer ${GH_PAT}" \
      "https://api.github.com/repos/AP127CMD/CMD_CTR/issues/${n}/comments" \
      -d '{"body":"Resolved — Pi fetch succeeded again. Auto-closing."}' >/dev/null 2>&1
    curl -sf -X PATCH -H "Authorization: Bearer ${GH_PAT}" \
      "https://api.github.com/repos/AP127CMD/CMD_CTR/issues/${n}" \
      -d '{"state":"closed"}' >/dev/null 2>&1
  done
}

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) — starting fetch ==="

# A failed cycle leaves an uncommitted backoff_state.json bump behind (this
# script only commits on the success path) — without this, EVERY cycle
# after a failure would fail again immediately on git pull, forever. It's
# pure bookkeeping, not precious; this run's own outcome rewrites it anyway.
git checkout -- data/backoff_state.json 2>/dev/null || true

if ! git pull --rebase origin main; then
  echo "git pull failed — skipping this cycle" >&2
  report_pi_failure
  exit 1
fi

if ! python3 scripts/fetch_schedule.py; then
  echo "Fetch failed — see fetch_schedule.py's own retry/backoff-state output above."
  echo "If this keeps happening across many cycles, the Chromium session"
  echo "likely needs re-authenticating — see 'Session expired' in README.md."
  report_pi_failure
  exit 1
fi

python3 scripts/generate_flight_data.py

git add data/flight_schedule.json flight-data.js flight-data-recent.js \
  data/portal_fingerprint.json data/backoff_state.json
if git diff --cached --quiet; then
  echo "No data changes — nothing to commit."
  close_pi_failure_if_open
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
  report_pi_failure
  exit 1
fi

close_pi_failure_if_open

echo "Triggering CMDV2 refresh…"
curl -sf -X POST \
  -H "Authorization: Bearer ${GH_PAT}" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/AP127CMD/CMDV2/actions/workflows/refresh-data.yml/dispatches \
  -d '{"ref":"main"}' \
  && echo "CMDV2 refresh-data.yml dispatched" \
  || echo "WARNING: CMDV2 refresh dispatch failed (non-fatal)" >&2
