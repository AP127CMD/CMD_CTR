# Pi system hardening (installed by hand on the Orange Pi Zero 2W)

These live on the board, not in git — this folder is the reproducible record.
Install: copy each file to the path in its first comment, then
`systemctl daemon-reload && systemctl daemon-reexec && systemctl restart cups ssh`.

Added 2026-10-19/20 after the board locked up twice (journal files added 2026-10-28 after a hang left no evidence) (see AP127_Docs §5.5.1):

| File | Why |
|---|---|
| `10-watchdog.conf` | Arms the hardware watchdog so a lockup becomes a ~16 s reboot, not a manual power-cycle. |
| `cups-limits.conf` | Caps the AirPrint print renderer so it can't starve the scraper/sshd. |
| `ssh-oom.conf` | Keeps sshd off the OOM killer's list. |
| `var-log-journal.mount` | Bind-mounts `/var/lib/ap127-journal` (SD card) over `/var/log/journal`, because DietPi RAMlog makes `/var/log` a RAM tmpfs. **Create the source dir first:** `install -d -m 2755 -o root -g systemd-journal /var/lib/ap127-journal`, then `systemctl enable --now var-log-journal.mount`. |
| `journald-persist.conf` | Size-capped persistent journal (48 MB, 30 s sync). Install to `/etc/systemd/journald.conf.d/10-ap127-persist.conf`, then `systemctl restart systemd-journald`. |
| `ramlog-journal-stubs.conf` | Drop-in for `dietpi-ramlog.service` that deletes the 0-byte journal stubs RAMlog restores after a clean shutdown. |

Git-repo hygiene lives in `../maintenance/` (nightly bounded repack; `gc.auto=0` on the clone).
