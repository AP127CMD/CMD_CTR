#!/bin/bash
# Runs Xvfb on a FIXED, known display (:99) rather than xvfb-run's dynamic
# picking, specifically so the one-time (and occasional re-) login step has
# a predictable `x11vnc -display :99` to point at — see README.md.
set -e
export DISPLAY=:99
rm -f /tmp/.X99-lock   # stale lock from an unclean previous shutdown, if any

Xvfb :99 -screen 0 1280x800x24 &
sleep 2   # give Xvfb a moment to actually be ready before Chromium connects

exec /usr/bin/chromium \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$HOME/.ap127-chromium-profile" \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-dev-shm-usage \
  --disable-extensions \
  --disable-sync \
  --disable-background-networking \
  --disable-default-apps \
  --metrics-recording-only \
  --mute-audio \
  --no-first-run \
  --no-default-browser-check \
  https://script.google.com/macros/s/AKfycbx-8p8MWbDAeJkTBPt4Yy_6cH0azSv-5VXcrzVhIUGM6XEJRtMBQNku-WybzNlhq9zN/exec
