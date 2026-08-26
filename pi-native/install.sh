#!/bin/bash
# Run this ON the Orange Pi Zero 2W (not your Mac), as the normal user
# (not root — it uses sudo itself where needed). See README.md for the full
# picture; this just automates the mechanical steps.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THIS_USER="$(whoami)"
THIS_HOME="$HOME"

if [ "$THIS_USER" = "root" ]; then
  echo "Don't run this as root — run as your normal user (it uses sudo itself where needed)." >&2
  exit 1
fi

echo "=== Installing packages ==="
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  chromium chromium-sandbox xvfb x11vnc \
  python3 python3-pip python3-venv git curl

echo "=== Installing the playwright Python package (NOT its browser download — ==="
echo "=== we only ever attach to the system chromium above, never launch our own) ==="
pip3 install --break-system-packages playwright>=1.50.0 2>&1 || pip3 install playwright>=1.50.0

echo "=== zram check ==="
if swapon --show 2>/dev/null | grep -q zram; then
  echo "zram already active — good."
else
  echo "WARNING: no zram/swap detected. On 1GB RAM this matters — see README.md's"
  echo "'Memory cushion' section for how to enable it (DietPi: dietpi-config >"
  echo "Advanced Options > ZRAM). Continuing installation regardless, but do this"
  echo "before trusting the setup long-term."
fi

echo "=== Installing systemd units ==="
for unit in ap127-chromium.service ap127-fetch.service; do
  sed -e "s#__USER__#${THIS_USER}#g" -e "s#__HOME__#${THIS_HOME}#g" \
    "${REPO_ROOT}/pi-native/${unit}" | sudo tee "/etc/systemd/system/${unit}" >/dev/null
done
sudo cp "${REPO_ROOT}/pi-native/ap127-fetch.timer" /etc/systemd/system/

if [ ! -f "${REPO_ROOT}/pi-native/.env" ]; then
  echo "=== No pi-native/.env found — creating from example ==="
  cp "${REPO_ROOT}/pi-native/.env.example" "${REPO_ROOT}/pi-native/.env"
  chmod 600 "${REPO_ROOT}/pi-native/.env"
  echo ">>> Edit ${REPO_ROOT}/pi-native/.env now and paste your GH_PAT before continuing. <<<"
  echo ">>> (See .env.example's comments for the exact token scopes needed.)          <<<"
  read -rp "Press Enter once that's done… "
fi

sudo systemctl daemon-reload
sudo systemctl enable --now ap127-chromium.service
sudo systemctl enable --now ap127-fetch.timer

echo
echo "=== Done. Chromium is starting (may take ~10s). ==="
echo
echo "NEXT: sign into Google — see README.md's 'One-time login' section."
echo "Quick version: run"
echo "    x11vnc -display :99 -nopw -listen 0.0.0.0 -once"
echo "then connect from your Mac with Screen Sharing"
echo "(Finder > Go > Connect to Server > vnc://<pi-ip>) and sign in normally."
echo
echo "Check status any time with:"
echo "  systemctl status ap127-chromium ap127-fetch.timer"
echo "  journalctl -u ap127-fetch -n 50"
