# Pi system hardening (installed by hand on the Orange Pi Zero 2W)

These live on the board, not in git — this folder is the reproducible record.
Install: copy each file to the path in its first comment, then
`systemctl daemon-reload && systemctl daemon-reexec && systemctl restart cups ssh`.

Added 2026-10-19/20 after the board locked up twice (see AP127_Docs §5.5.1):

| File | Why |
|---|---|
| `10-watchdog.conf` | Arms the hardware watchdog so a lockup becomes a ~16 s reboot, not a manual power-cycle. |
| `cups-limits.conf` | Caps the AirPrint print renderer so it can't starve the scraper/sshd. |
| `ssh-oom.conf` | Keeps sshd off the OOM killer's list. |

Git-repo hygiene lives in `../maintenance/` (nightly bounded repack; `gc.auto=0` on the clone).
