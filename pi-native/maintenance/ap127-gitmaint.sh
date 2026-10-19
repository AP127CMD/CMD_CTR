#!/bin/bash
# Bounded, incremental git maintenance for the Pi's clone.
#
# WHY: every fetch cycle commits several multi-MB JSON blobs (flight_schedule.json is ~7.8 MB,
# plus its backup and the two flight-data*.js files), each stored as a LOOSE object. After
# ~6,700 loose objects git runs `gc --auto` INSIDE the fetch's `git pull`, with default pack
# settings (4 threads, unlimited delta window). Packing 1.5 GB of near-identical JSON that
# way peaked at 430-536 MB of RAM on this 1 GB board (already holding Chromium ~600 MB),
# filled the 484 MB zram swap, and locked the board (2026-10-19, twice; it retried every
# 5-min cycle). Auto-gc is now OFF in this repo (gc.auto=0) and this job does the same work
# in small, memory-capped nightly steps instead, so the backlog never builds up again.
#
# Run as root by ap127-gitmaint.service (hard caps come from the unit); safe to run by hand.
set -u
REPO="${REPO:-/home/dietpi/flight-schedule-feed}"
cd "$REPO" || exit 1
pgrep -f 'git-core/git (gc|repack)' >/dev/null && { echo "another git maintenance is running — skipping"; exit 0; }
# Wait (up to 10 min) for an in-flight fetch cycle to finish rather than racing its commit/push.
for _ in $(seq 1 120); do
  st="$(systemctl is-active ap127-fetch.service 2>/dev/null)"
  [ "$st" != "activating" ] && [ "$st" != "active" ] && break
  sleep 5
done
before="$(git count-objects -v | awk '/^count:/{print $2}')"
echo "$(date -u +%FT%TZ) loose objects before: $before"
# Delta window of 4 is plenty: successive versions of one JSON file sort adjacently.
# -d drops the loose copies once they are packed; -l ignores alternates.
git -c pack.threads=1 -c pack.windowMemory=48m -c pack.window=4 -c pack.depth=50 \
    -c core.deltaBaseCacheLimit=48m repack -d -l --no-write-bitmap-index
rc=$?
git prune-packed 2>/dev/null
echo "$(date -u +%FT%TZ) repack exit $rc; loose objects after: $(git count-objects -v | awk '/^count:/{print $2}')"
exit $rc
