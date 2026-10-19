#!/bin/bash
# Idempotent. Run as root on the Pi:  sudo bash pi-native/printprio/install.sh
set -e
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 0644 "$D/ap127.tmpfiles.conf" /etc/tmpfiles.d/ap127.conf
systemd-tmpfiles --create /etc/tmpfiles.d/ap127.conf
for u in readiness gitmaint; do
  mkdir -p "/etc/systemd/system/ap127-$u.service.d"
  install -m 0644 "$D/$u-lock.conf" "/etc/systemd/system/ap127-$u.service.d/lock.conf"
done
install -m 0644 "$D/ap127-printprio.service" /etc/systemd/system/ap127-printprio.service
chmod +x "$D/ap127-printprio.sh"
systemctl daemon-reload
systemctl enable --now ap127-printprio.service
echo "installed: lock file, readiness+gitmaint drop-ins, print-priority arbiter"
systemctl is-active ap127-printprio.service
