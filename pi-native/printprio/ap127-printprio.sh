#!/bin/bash
# Print-priority arbiter.
#
# A print is the one thing on this 1 GB board that a person is standing next to waiting for, and
# it needs a big, uninterrupted slice of RAM (render peaks ~270 MB and is held for the whole time
# the printer is printing). Everything else (fetch, readiness planner, git repack) is repeatable
# background work. So: while a CUPS render is active, FREEZE the background units (cgroup freezer —
# nothing is killed, no state is lost, the kernel can swap their idle pages out for the print), and
# THAW them when the print is done.
#
# Chromium is deliberately NOT frozen: the fetch talks to it over a local CDP socket and its
# signed-in session must stay alive. A frozen fetch resumes where it left off.
#
# Guard rails: a print that "stays active" longer than MAX_FREEZE (printer jammed, filters waiting
# forever) can never starve the fetch — background work is thawed and left alone until that print
# goes idle. On stop/crash everything is thawed (trap + ExecStopPost).
set -u
POLL="${POLL:-2}"
IDLE_POLLS="${IDLE_POLLS:-3}"              # consecutive idle polls before thawing (debounce)
MAX_FREEZE="${MAX_FREEZE:-600}"
read -r -a BG_UNITS <<< "${BG_UNITS:-ap127-fetch.service ap127-readiness.service ap127-gitmaint.service}"
PAT='/usr/lib/cups/filter/(pdftoraster|rastertogutenprint|pdftopdf|gstoraster|mupdftoraster)'

frozen=(); since=0; idle=0; gave_up=0
log() { echo "$(date +%T) $*"; }
print_active() { pgrep -f "$PAT" >/dev/null 2>&1; }
is_frozen() { local u; for u in "${frozen[@]:-}"; do [ "$u" = "$1" ] && return 0; done; return 1; }
thaw_all() {
  local u
  for u in "${frozen[@]:-}"; do [ -n "$u" ] && systemctl thaw "$u" >/dev/null 2>&1; done
  frozen=(); since=0
}
trap 'thaw_all; log "stopped — everything thawed"; exit 0' TERM INT

log "arbiter up: watching for CUPS renders; background units: ${BG_UNITS[*]}"
while true; do
  if print_active; then
    idle=0
    now=$(date +%s)
    if [ "$gave_up" -eq 0 ]; then
      for u in "${BG_UNITS[@]}"; do
        is_frozen "$u" && continue
        st="$(systemctl is-active "$u" 2>/dev/null)"
        if [ "$st" = "activating" ] || [ "$st" = "active" ]; then
          if systemctl freeze "$u" >/dev/null 2>&1; then
            [ "${#frozen[@]}" -eq 0 ] && since=$now
            frozen+=("$u"); log "print active -> froze $u"
          fi
        fi
      done
      if [ "${#frozen[@]}" -gt 0 ] && [ $((now - since)) -ge "$MAX_FREEZE" ]; then
        log "print still active after ${MAX_FREEZE}s (stuck?) -> thawing; will not freeze again until it goes idle"
        thaw_all; gave_up=1
      fi
    fi
  else
    idle=$((idle + 1))
    if [ "$idle" -ge "$IDLE_POLLS" ]; then
      [ "${#frozen[@]}" -gt 0 ] && { log "print done -> thawing ${frozen[*]}"; thaw_all; }
      gave_up=0
    fi
  fi
  sleep "$POLL"
done
