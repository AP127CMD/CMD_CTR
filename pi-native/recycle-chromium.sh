#!/bin/bash
# Nightly Chromium recycle — clears the memory bloat the persistent browser
# accumulates over a day of scraping (tab/renderer growth, fragmentation).
# The board is 1 GB and also runs CUPS; on 2026-09-07 it hard-hung ~17 h after
# ~4 h of tight-cadence scraping pushed it into swap thrash. This is the cheap
# guard against a repeat.
#
# Run as root by ap127-chromium-restart.service (nightly timer, 03:00 local —
# dead of night, the flight schedule is static so a skipped fetch beat costs
# nothing). The Google-signed-in session lives on disk in --user-data-dir, so
# restarting Chromium does NOT log us out.
set -u

CDP='http://127.0.0.1:9222/json/version'

log() { echo "[recycle-chromium] $*"; }

log "stopping fetch timer so no cycle starts mid-recycle"
systemctl stop ap127-fetch.timer || true

# If a fetch is running right now, let it finish (up to ~90 s) before we pull
# Chromium out from under it.
for _ in $(seq 1 45); do
  systemctl is-active --quiet ap127-fetch.service || break
  sleep 2
done

log "restarting ap127-chromium.service"
systemctl restart ap127-chromium.service

log "waiting for CDP on :9222"
ok=0
for _ in $(seq 1 60); do
  if curl -sf --max-time 3 "$CDP" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done

if [ "$ok" = 1 ]; then
  log "CDP is back — re-enabling fetch timer"
else
  log "WARNING: CDP did not come back within 120 s — re-enabling fetch timer anyway (Restart=on-failure on the chromium unit will keep trying; the cloud fallback covers gaps)"
fi

systemctl start ap127-fetch.timer
log "done"
