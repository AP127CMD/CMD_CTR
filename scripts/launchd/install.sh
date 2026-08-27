#!/bin/bash
# Installs the two LaunchAgents that keep AP127 data auto-refreshing in the
# background on this Mac. See README.md in this folder for the full picture.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS_DIR" "$HOME/Library/Logs"

for f in start_chromium.sh; do
  chmod +x "$DIR/$f"
done
chmod +x "$DIR/../manual_refresh.sh"

for plist in com.ap127.chromium.plist com.ap127.fetch.plist; do
  cp "$DIR/$plist" "$AGENTS_DIR/$plist"
done

echo "Loading LaunchAgents…"
uid=$(id -u)
for label in com.ap127.chromium com.ap127.fetch; do
  # bootout first (ignore error if not already loaded) so re-running this
  # script after an edit picks up the change instead of silently no-op'ing.
  launchctl bootout "gui/${uid}/${label}" 2>/dev/null || true
  launchctl bootstrap "gui/${uid}" "$AGENTS_DIR/${label}.plist"
done

echo
echo "=== Installed ==="
echo "com.ap127.chromium — keeps a persistent, signed-in Chrome window alive"
echo "                     (hides its window ~8s after starting)"
echo "com.ap127.fetch    — runs scripts/manual_refresh.sh every 5 minutes"
echo
echo "Check status:"
echo "  launchctl list | grep ap127"
echo "Logs:"
echo "  tail -f ~/Library/Logs/ap127-chromium.log"
echo "  tail -f ~/Library/Logs/ap127-fetch.log"
echo
echo "If Chrome isn't already signed in, a window will appear shortly —"
echo "sign into Google there once. See README.md for details."
