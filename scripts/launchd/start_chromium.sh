#!/bin/bash
# Launched by com.ap127.chromium.plist (a launchd LaunchAgent) — keeps ONE
# real, plain Chrome window alive for manual_refresh.sh's fetch cycles to
# attach to over CDP. `exec`s straight into the Chrome binary (not `open`,
# which detaches immediately) so launchd tracks Chrome's actual PID and its
# KeepAlive setting genuinely restarts it if it ever crashes/quits — a
# wrapper that forked-and-exited would leave Chrome orphaned and unmonitored.
#
# The minimize step runs as a detached background job BEFORE the exec (it
# has to — nothing after `exec` in this script ever runs) so the window
# tucks itself away ~8s after appearing rather than sitting in your way.

( sleep 8
  osascript -e 'tell application "Google Chrome" to set miniaturized of front window to true' \
    >/dev/null 2>&1
) &
disown

PROFILE_DIR="$HOME/.ap127-manual-chrome-profile"
mkdir -p "$PROFILE_DIR"

exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "https://script.google.com/macros/s/AKfycbx-8p8MWbDAeJkTBPt4Yy_6cH0azSv-5VXcrzVhIUGM6XEJRtMBQNku-WybzNlhq9zN/exec"
