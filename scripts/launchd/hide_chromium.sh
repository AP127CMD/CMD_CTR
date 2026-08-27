#!/bin/bash
# Runs once (via com.ap127.chromium-hide.plist, RunAtLoad, no KeepAlive) to
# tuck the Chrome window out of the way shortly after login/boot. Kept as
# its OWN separate launchd job rather than a backgrounded step inside
# start_chromium.sh — tested 2026-08-27: a detached `(sleep 8; osascript
# ...) & disown` launched just before that script's `exec` into Chrome
# never actually ran under launchd (exactly why matters less than that it
# didn't — a plain, independent job removes the ambiguity entirely and is
# simple enough to trust).
sleep 8
osascript -e 'tell application "Google Chrome" to set visible of window 1 to false' >/dev/null 2>&1
