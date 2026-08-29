# AP127 Pi Monitor (Mac-side)

A localhost dashboard to see, at a glance, whether the Orange Pi Zero 2W
(`192.168.1.123`, DietPi) is successfully running the flight-schedule fetch
pipeline — the job that replaced the Mac `launchd` auto-refresh and the
permanently-disabled `fetch_schedule.yml` GitHub Action.

Read-only monitoring plus three actions: **Run fetch now**, **SSH shell**,
**Screen Sharing**. Single-file Python 3 stdlib server, binds `127.0.0.1` only.

## Install

```bash
ln -sf "$HOME/flight-schedule-feed/pi-native/mac-monitor/AP127-PiMonitor.command" "$HOME/Desktop/AP127-PiMonitor.command"
chmod +x "$HOME/flight-schedule-feed/pi-native/mac-monitor/AP127-PiMonitor.command"
```

Then double-click **AP127-PiMonitor** on the Desktop. It starts the server,
opens `http://127.0.0.1:8766`, and stops when you close the Terminal window.

Requirements: `python3` (stdlib only) and an authenticated `gh` CLI (already set
up on this Mac — used for the GitHub panels; the dashboard still works without
it, those cards just show "unavailable"). Key-based SSH to `root@192.168.1.123`
must work (the Pi's first-boot script installed this Mac's `id_ed25519.pub`).

## What it shows

| Panel | Source |
|-------|--------|
| Headline dot (green / yellow / red) | derived — see below |
| Fetch pipeline: last-run outcome, flight/date counts, timer last fired, head + `(orangepi-zero2w)` commits | one SSH call + `gh api` |
| Pi health: reachable, uptime, RAM avail, zram used, disk, CPU temp, WiFi dBm, `ap127-chromium` / CDP / `ap127-fetch.timer` states | one SSH call |
| Live sites: `fetchedAt` on `ap127-cmd-ctr` / `ap127-ngt2` | `curl` |
| CMDV2 trigger: last `refresh-data.yml` run | `gh api` |
| `journalctl -u ap127-fetch` tail (collapsible) | the SSH call |

Auto-refreshes every 30 s (pauses while the mouse is over the page).

**Headline logic**
- **RED**: Pi unreachable · `ap127-chromium.service` not active · last fetch run exited non-zero
- **YELLOW**: last `(orangepi-zero2w)` push > 20 min ago · CDP not responding · `ap127-fetch.timer` not active · a live site lags the last push by > 15 min · Pi RAM avail < 60 MiB · disk > 90 % full
- **GREEN**: otherwise

(A stale push alone is only *yellow*, not red — the fetch legitimately commits
nothing when portal data is unchanged. The journal outcome marker is the hard
signal.)

## Buttons

- **Run fetch now** — `systemctl start --no-block ap127-fetch.service` on the Pi; the page re-polls ~9 s later.
- **SSH shell** — opens Terminal.app running `ssh root@192.168.1.123`.
- **Screen Sharing** — starts `x11vnc -once -timeout 60` on the Pi and opens `vnc://192.168.1.123`. Password: **`ap127vnc`**. It self-stops when you disconnect or after 60 s idle.

## Config

Edit `config.json` (same folder). `pi_host` / `pi_ip` if the Pi's address
changes, `port` for the dashboard, `vnc_password` for the Screen Sharing button.

## Test

```bash
python3 server.py --selftest   # run all collectors once, print JSON, exit
```
