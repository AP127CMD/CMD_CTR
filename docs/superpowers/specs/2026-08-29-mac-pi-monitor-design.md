# AP127 Pi Monitor — design

**Date:** 2026-08-29
**Status:** approved, ready for implementation
**Author:** Claude Code session (Pi deployment handoff)

## Purpose

A small always-on-demand dashboard on the Mac to see, at a glance, whether the
Orange Pi Zero 2W (`192.168.1.123`, DietPi) is successfully running the AP127
flight-schedule fetch pipeline — the job that replaced the Mac `launchd`
auto-refresh and the (now permanently disabled) `fetch_schedule.yml` GitHub
Action.

It is a **read/monitor** tool with three convenience actions (run fetch now,
SSH shell, Screen Sharing). It is not an alerting system and keeps no history.

## Form

Local web dashboard, mirroring the existing `~/Desktop/RedAlert2-ControlCenter.command`
pattern: a `.command` launcher starts a single-file Python stdlib HTTP server
bound to `127.0.0.1`, opens the browser, and stops when the Terminal window is
closed.

## Files

All version-controlled in the repo for reproducibility:

```
flight-schedule-feed/pi-native/mac-monitor/
├── server.py              # Python 3 stdlib http.server, single file
├── config.json            # committed — LAN IP is not a secret
├── AP127-PiMonitor.command # launcher; install step symlinks it to ~/Desktop
└── README.md              # what it is, how to install, how to change the Pi address
```

`config.json`:

```json
{
  "pi_host": "root@192.168.1.123",
  "pi_ip": "192.168.1.123",
  "port": 8766,
  "repo": "AP127CMD/CMD_CTR",
  "cmdv2_repo": "AP127CMD/CMDV2",
  "sites": ["https://ap127-cmd-ctr.pages.dev", "https://ap127-ngt2.pages.dev"],
  "vnc_password": "ap127vnc"
}
```

## Launcher behaviour

- `PORT` read from `config.json` (fallback 8766).
- Kill any process already bound to the port (stale run), then start `server.py`.
- `python3` resolved via `command -v`; clear error if missing.
- `open http://127.0.0.1:$PORT` after a 1 s delay.
- `wait` on the server pid; closing the window / Ctrl-C stops it.

## HTTP surface (server.py)

| Route | Method | Action |
|-------|--------|--------|
| `/` | GET | the single-page dashboard (HTML/CSS/JS inline in server.py) |
| `/api/status` | GET | JSON blob with all collected signals (see below) |
| `/api/fetch-now` | POST | SSH `systemctl start ap127-fetch.service` on the Pi |
| `/api/ssh` | POST | `osascript` opens Terminal.app running `ssh <pi_host>` |
| `/api/vnc` | POST | SSH starts `x11vnc -display :99 -rfbauth <pwfile> -once -timeout 60` on the Pi, then `open vnc://<pi_ip>` |
| `/api/refresh` | POST | no-op endpoint the UI calls to force an immediate `/api/status` poll |

All routes serve only on `127.0.0.1`. No auth (single-user Mac, localhost only).

## Data collection (`/api/status`)

Each collector is independent and wrapped so one failure never blanks the page.

### 1. Pi, via one combined SSH call

`ssh -o BatchMode=yes -o ConnectTimeout=5 <pi_host> '<script>'` where `<script>`
emits a simple `key=value` block (one round trip):

- `uptime` (pretty), load average
- `free -m` → total / used / available MiB
- `/proc/swaps` → zram size + used
- `df -P /` → root free / used %
- `/sys/class/thermal/thermal_zone*/temp` → CPU °C (first zone that reads)
- `iw dev wlan0 link` → SSID + signal dBm
- `systemctl is-active ap127-chromium.service ap127-fetch.timer`
- `systemctl show ap127-fetch.timer -p NextElapseUSecRealtime` → next run
- `systemctl show ap127-fetch.service -p ExecMainStatus -p ExecMainExitTimestamp -p ActiveState`
- `curl -sf --max-time 3 http://127.0.0.1:9222/json/version` → CDP browser string or empty
- `journalctl -u ap127-fetch -n 60 --no-pager -o cat` → last run: parse the
  `Fetched N flights across M date(s).` line, the `Saved →` / `Pushed on attempt`
  / `No data changes` / `Fetch failed` outcome markers, and keep the last ~15
  lines verbatim for the collapsible tail.

SSH timeout / failure → `pi.reachable = false`; the rest of the JSON still
returns (GitHub + sites).

### 2. GitHub, via `gh api` (uses the Mac's existing authenticated `gh`)

- `gh api repos/<repo>/commits/main` → last commit sha + committer date; also
  walk `repos/<repo>/commits?per_page=20` to find the most recent commit whose
  message contains `(orangepi-zero2w)` → "last successful data push".
- `gh api repos/<cmdv2_repo>/actions/workflows/refresh-data.yml/runs?per_page=1`
  → last run status + conclusion + createdAt.
- Cached in-process for 120 s. If `gh` is missing or errors → `github.available = false`,
  those cards show "GitHub API unavailable" (dashboard still renders).

### 3. Live sites, via `curl`

For each site: `curl -sf --max-time 5 "<site>/flight-data.js?_=<ts>"`, regex
`"fetchedAt":"([^"]+)"`. Cached 60 s. Compared against the Pi's last-push time
to compute lag.

## Headline status logic

- **RED** if: `pi.reachable == false`, OR `ap127-chromium.service` not active,
  OR last fetch run `ExecMainStatus != 0` (an actual failure).
- **YELLOW** if (and not already red): last `(orangepi-zero2w)` push > 20 min ago,
  OR CDP string empty, OR `ap127-fetch.timer` not active, OR a live site's
  `fetchedAt` lags the last push by > 15 min, OR Pi available MiB < 60,
  OR root disk used > 90%.
- **GREEN** otherwise.

Rationale for yellow-not-red on a stale push: the fetch legitimately commits
nothing when the portal data is unchanged, so "no recent commit" is a soft
signal, not proof of failure — the journal outcome marker is the hard signal.

## UI

Single dark page, no framework, inline in `server.py`:

- Header: large status dot (green/yellow/red) + "Last fetch: N min ago" +
  a spinning-free countdown to next auto-refresh (pauses while the mouse is over
  the page).
- Card grid:
  - **Fetch Pipeline** — last run outcome, flight/date counts, next timer run,
    last commit (sha short + relative time), CMDV2 last run.
  - **Pi Health** — reachable, uptime, RAM avail, zram used, disk free, CPU °C,
    WiFi dBm, `ap127-chromium` / CDP / timer states.
  - **Live Sites** — each site's `fetchedAt` + lag vs. push, coloured.
- Collapsible **journalctl tail** (last ~15 lines) at the bottom.
- Button row: **Run fetch now** · **SSH shell** · **Screen Sharing** · **Refresh now**.
  Each POSTs its endpoint and shows a transient toast with the result
  (`fetch-now` toast then triggers a poll ~10 s later).
- Auto-refresh every 30 s via `fetch('/api/status')`; never reloads the page.

## Error handling

- Every collector returns `{ ok: false, error: "..." }` on failure; the
  corresponding card renders the error inline, greyed, and does not affect
  other cards or the headline (except where the headline logic explicitly keys
  off a reachable/active signal).
- Launcher handles: missing `python3`, missing `config.json`, port already bound.
- `/api/vnc` and `/api/fetch-now` return the SSH exit status + stderr to the
  toast; they never block the status poller.

## Testing

- `python3 server.py --selftest` — runs all three collectors once, prints the
  assembled JSON, exits 0 (no server, no browser). Used to sanity-check
  connectivity and parsing.
- Manual matrix:
  - Pi powered on, pipeline healthy → GREEN, all cards populated.
  - Pi powered off → RED within ~5 s, "Pi unreachable", GitHub + sites cards
    still populate, no traceback.
  - `systemctl stop ap127-fetch.timer` on the Pi → YELLOW, timer card red.
  - `gh` logged out / PATH-hidden → GitHub cards show unavailable, page still
    works.
  - Buttons: Run fetch now → journal shows a new run; SSH shell → Terminal opens
    connected; Screen Sharing → `vnc://` opens and x11vnc self-stops after
    disconnect / 60 s.

## Out of scope (YAGNI)

- Historical trends / graphs / a database.
- Desktop notifications or any push alerting.
- Editing the Pi's configuration or the fetch cadence from the UI.
- Managing the (permanently disabled) `fetch_schedule.yml` workflow.
- Multi-Pi support.

## Install

`pi-native/mac-monitor/README.md` documents:

```bash
ln -sf "$HOME/flight-schedule-feed/pi-native/mac-monitor/AP127-PiMonitor.command" "$HOME/Desktop/AP127-PiMonitor.command"
chmod +x "$HOME/flight-schedule-feed/pi-native/mac-monitor/AP127-PiMonitor.command"
```

Then double-click the Desktop icon. To change the Pi's address, edit
`pi-native/mac-monitor/config.json`.
