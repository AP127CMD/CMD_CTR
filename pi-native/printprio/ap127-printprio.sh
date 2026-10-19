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
# WHY THE CGROUP FREEZER IS DRIVEN DIRECTLY, NOT VIA `systemctl freeze`: the fetch is a Type=oneshot
# unit, and `systemctl freeze` refuses a oneshot that is still starting ("Unit has a pending job")
# — which is exactly the state a running fetch is in. The first version used systemctl, the error
# was swallowed, and a real fetch was never frozen (caught by the end-to-end test on 2026-10-20;
# the stand-in unit tests all passed because a plain service has no pending job). Writing
# cgroup.freeze is what systemd does underneath, works on any state, and a frozen unit can still
# be stopped by systemd (verified), so a frozen fetch can never become unkillable.
#
# Guard rails: a print that "stays active" longer than MAX_FREEZE (printer jammed, filters waiting
# forever) can never starve the fetch — background work is thawed and left alone until that print
# goes idle. On stop/crash everything is thawed (trap + ExecStopPost).
set -u
POLL="${POLL:-2}"
IDLE_POLLS="${IDLE_POLLS:-3}"              # consecutive idle polls before thawing (debounce)
MAX_FREEZE="${MAX_FREEZE:-600}"
read -r -a BG_UNITS <<< "${BG_UNITS:-ap127-fetch.service ap127-readiness.service ap127-gitmaint.service}"
# Match by executable NAME (comm), NOT by command line. When cupsd launches a filter it sets argv[0] to the
# PRINTER NAME ("Canon_E410 137 root blank.pdf 1 ..."), so the filter's path never appears in `ps` args: the
# first version matched '/usr/lib/cups/filter/...', passed every stand-in test (which launched filters by
# path) and was blind to real prints. comm is the real binary name, truncated by the kernel to 15 chars
# (rastertogutenprint.5.3 -> "rastertogutenpr"). `gs` is Ghostscript, which gstoraster spawns to do the
# actual rendering — the memory-heavy process on this queue's real chain
# (pdftopdf -> gstoraster -> rastertogutenprint).
PAT='pdftopdf|gstoraster|pdftoraster|mupdftoraster|rastertogutenpr|gs'

frozen=(); since=0; idle=0; gave_up=0
# Own small event log: the board's journald is a tiny RAM log that churns (it lost these very lines
# minutes after they were written). /var/log is RAM too, but it is a separate budget and survives
# journal rotation; it is trimmed in place so it can never grow.
LOGFILE="${LOGFILE:-/var/log/ap127-printprio.log}"
log() {
  local l; l="$(date '+%F %T') $*"; echo "$l"; echo "$l" >> "$LOGFILE" 2>/dev/null
  if [ "$(stat -c %s "$LOGFILE" 2>/dev/null || echo 0)" -gt 100000 ]; then
    tail -n 200 "$LOGFILE" > "$LOGFILE.tmp" 2>/dev/null && mv "$LOGFILE.tmp" "$LOGFILE"
  fi
}
print_active() { pgrep -x "$PAT" >/dev/null 2>&1; }
cg_of() { echo "/sys/fs/cgroup/system.slice/$1"; }
is_frozen() { local u; for u in "${frozen[@]:-}"; do [ "$u" = "$1" ] && return 0; done; return 1; }
# cgroup.procs is a virtual file (size is always 0), so test for CONTENT, never `[ -s ]`.
has_procs() { grep -q . "$(cg_of "$1")/cgroup.procs" 2>/dev/null; }          # unit has processes now
freeze_unit() {
  local cg; cg="$(cg_of "$1")"
  [ -w "$cg/cgroup.freeze" ] || { log "WARN: cannot write $cg/cgroup.freeze"; return 1; }
  echo 1 > "$cg/cgroup.freeze" 2>/dev/null || { log "WARN: freeze write failed for $1"; return 1; }
  sleep 0.5
  grep -q "^frozen 1" "$cg/cgroup.events" 2>/dev/null || log "WARN: $1 asked to freeze but not yet reporting frozen"
  return 0
}
thaw_unit() { local cg; cg="$(cg_of "$1")"; [ -w "$cg/cgroup.freeze" ] && echo 0 > "$cg/cgroup.freeze" 2>/dev/null; return 0; }
thaw_all() {
  local u
  for u in "${frozen[@]:-}"; do [ -n "$u" ] && thaw_unit "$u"; done
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
        if has_procs "$u"; then
          if freeze_unit "$u"; then
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
