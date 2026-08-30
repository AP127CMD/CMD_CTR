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
# Dedup/close match on the TITLE PREFIX below, deliberately NOT on the
# `fetch-failure-pi` label. Found 2026-08-31: this Pi's fine-grained GH_PAT
# creates issues fine but GitHub SILENTLY DROPS the `labels` field from its
# POSTs (verified: issues #11/#12/#13 all came out with labels=[], while the
# identical POST from a full-permission token applies the label correctly).
# Label-based dedup therefore always matched zero, so every failed cycle
# opened ANOTHER issue and no success ever auto-closed one — the exact
# silent-alerting failure this whole mechanism exists to prevent. Title
# matching needs no permission beyond reading issues, so it can't regress the
# same way if the token is ever rotated to a narrower scope.
PI_ISSUE_PREFIX="[Pi Fetch] Run failed"

# Echoes the open issue numbers whose title starts with PI_ISSUE_PREFIX.
# Excludes pull requests — GitHub's /issues endpoint returns PRs too.
_pi_open_issue_numbers() {
  curl -sf -H "Authorization: Bearer ${GH_PAT}" \
    "https://api.github.com/repos/AP127CMD/CMD_CTR/issues?state=open&per_page=100" 2>/dev/null \
    | python3 -c '
import json, sys
try:
    items = json.load(sys.stdin)
except Exception:
    sys.exit(0)
prefix = sys.argv[1]
print(" ".join(
    str(i["number"]) for i in items
    if "pull_request" not in i and (i.get("title") or "").startswith(prefix)
))' "$PI_ISSUE_PREFIX" 2>/dev/null || true
}

report_pi_failure() {
  local existing
  existing="$(_pi_open_issue_numbers)"
  if [ -n "$existing" ]; then
    echo "Pi-failure issue already open (#${existing// /, #}) — not opening another."
    return 0
  fi
  local now title body
  now="$(date -u +%Y-%m-%dT%H:%MZ)"
  title="${PI_ISSUE_PREFIX} – ${now} UTC"
  body="Orange Pi Zero 2W fetch cycle failed at ${now} UTC.

Check: \`ssh dietpi@DietPi.local journalctl -u ap127-fetch -n 50\` or the Mac monitor dashboard.
(Note: the Pi's journal is RAM-only, so logs do not survive a reboot — investigate before power-cycling.)

GitHub Actions' own fetch keeps running independently — check ap127-cmd-ctr.pages.dev's fetchedAt if you need to know whether data is still current regardless."
  curl -sf -X POST -H "Authorization: Bearer ${GH_PAT}" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/AP127CMD/CMD_CTR/issues" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"title": sys.argv[1], "body": sys.argv[2], "labels": ["fetch-failure-pi"]}))' "$title" "$body")" \
    >/dev/null 2>&1 && echo "Opened Pi-failure issue." || echo "WARNING: could not open failure issue." >&2
}

# NOTE on permissions (verified live 2026-08-31): this Pi's fine-grained
# GH_PAT can CREATE and READ issues, but CANNOT comment on or close them —
# both return `403 Resource not accessible by personal access token`. That is
# also why its issue POSTs come out with labels=[]: applying a label is an
# issue *modification*, which the same 403 covers.
#
# So auto-close cannot work from the Pi with this token. Rather than silently
# pretend (the first version of this function printed "Auto-closed #N" without
# checking any HTTP status — it was lying every single time), close is
# attempted and the REAL outcome is reported. The dedup guard in
# report_pi_failure still works (it only needs read), so a failing Pi opens at
# most one issue instead of one per cycle, which was the main bug.
#
# To make auto-close actually work, grant the PAT `Issues: Read and write` on
# AP127CMD/CMD_CTR (github.com/settings/personal-access-tokens) — no code
# change needed, this function starts succeeding immediately. Until then the
# issue is closed by hand, or by the CI-side staleness watchdog if that lands.
close_pi_failure_if_open() {
  local issues code
  issues="$(_pi_open_issue_numbers)"
  [ -n "$issues" ] || return 0
  for n in $issues; do
    curl -s -o /dev/null -X POST -H "Authorization: Bearer ${GH_PAT}" \
      "https://api.github.com/repos/AP127CMD/CMD_CTR/issues/${n}/comments" \
      -d '{"body":"Resolved — Pi fetch succeeded again. Auto-closing."}' 2>/dev/null || true
    code="$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
      -H "Authorization: Bearer ${GH_PAT}" \
      -H "Accept: application/vnd.github.v3+json" \
      "https://api.github.com/repos/AP127CMD/CMD_CTR/issues/${n}" \
      -d '{"state":"closed"}' 2>/dev/null)" || code="000"
    if [ "$code" = "200" ]; then
      echo "Auto-closed Pi-failure issue #${n}."
    else
      echo "NOTE: could not auto-close Pi-failure issue #${n} (HTTP ${code}) —" \
           "GH_PAT lacks Issues:write. Close it by hand; alerting still works" \
           "(dedup prevents duplicates)." >&2
    fi
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
