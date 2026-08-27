#!/bin/bash
# Stops and removes both LaunchAgents. Does NOT touch the Chrome profile
# (~/.ap127-manual-chrome-profile) or quit the running Chrome window —
# run `pkill -f ap127-manual-chrome-profile` separately if you want that too.
set -uo pipefail

uid=$(id -u)
for label in com.ap127.chromium com.ap127.chromium-hide com.ap127.fetch; do
  launchctl bootout "gui/${uid}/${label}" 2>/dev/null && echo "Stopped $label" || echo "$label was not running"
  rm -f "$HOME/Library/LaunchAgents/${label}.plist"
done

echo "Done. Auto-refresh is now OFF — use scripts/manual_refresh.sh directly,"
echo "or the Desktop launcher, whenever you want fresh data."
