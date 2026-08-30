# AP127 fetch pipeline — Orange Pi Zero 2W (native) deployment

**Status as of 2026-08-29: DEPLOYED and verified live.** Running 24/7 on a
DietPi Orange Pi Zero 2W, hostname `DietPi`, currently `192.168.1.123`
(DHCP-reserved on the router). `ap127-fetch.timer` fires every 5 min; verified
end-to-end: real fetches (280 flights / 18 dates) committed + pushed to
`AP127CMD/CMD_CTR`, CMDV2 `refresh-data.yml` dispatched, both Pages sites
picking up the new `fetchedAt`.

**UPDATE 2026-08-31 — the Pi is now a TRUE STANDBY, not a second primary.**
It was fetching unconditionally every 5 min and landing commits 10-20 *seconds*
apart from GitHub Actions' own: identical work twice, doubling load on a GAS
backend known to degrade under repeated requests, doubling CMDV2 dispatches,
and causing constant push races. Now `run_fetch.sh` checks the last committed
`fetched_at` first:

| Condition | Behaviour |
|---|---|
| Data younger than `STANDBY_MAX_AGE_MIN` (20) | **Stand by** — exits immediately. No portal hit, no commit, no CMDV2 trigger. |
| Data `>=` 20 min old | **Take over** — the primary looks down; fetch for real. Unattended failover within one cycle. |
| Primary healthy but Pi hasn't fetched in `PROOF_RUN_INTERVAL_H` (6) | **Proof run** — one real fetch, so the standby stays *proven* rather than first exercised during an actual outage. |

Both knobs are env-overridable. Fails safe: an unreadable/missing/malformed
`fetched_at` yields a huge age, so the Pi fetches rather than standing by
forever on bad state. `~/.ap127-last-pi-fetch` (local, never committed) tracks
the last successful fetch for the proof-run timer.

**Known limitation — Pi failure alerts cannot auto-close.** The Pi's
fine-grained `GH_PAT` can create and read issues but gets
`403 Resource not accessible by personal access token` on closing or
commenting (this is also why its issue POSTs come out unlabelled — applying a
label is an issue *modification*). Dedup works (read-only), so a failing Pi
opens **one** issue rather than one per cycle. To enable auto-close, grant the
PAT `Issues: Read and write` on AP127CMD/CMD_CTR at
github.com/settings/personal-access-tokens — no code change needed.

**Earlier the same week: `fetch_schedule.yml` re-enabled, runs PERMANENTLY
alongside the Pi, not disabled.** A live `workflow_dispatch -f force=true`
test proved GitHub Actions' own fetch works again too (same "anonymous portal
access" finding below applies equally to a fresh Playwright-launched
browser, not just a real Chromium) — 280 flights/18 dates, clean commit
(correctly absorbed a genuine concurrent push-conflict against the Pi's own
commit via the existing rebase-retry loop), CMDV2 dispatched. **User's
explicit call: keep both running** — deliberate redundancy, not a
fallback-only relationship. Added `fetch-failure-pi`-labeled GitHub-issue
alerting to `run_fetch.sh` (mirrors `fetch_schedule.yml`'s own
`fetch-failure` mechanism, kept as a separate label so a Pi-only or
CI-only outage stays distinguishable) — see "Failure alerting" below.

**Surprise finding: the Google sign-in step (old step 5) was NOT needed.** A
real, OS-launched Chromium loads the Ops Portal anonymously — no login, no
session to expire. The 2025 incident was Google's bot-detection flagging a
*Playwright-launched* browser specifically; a genuine Chromium never trips it.
Step 5 below is kept only as a fallback in case Google ever starts gating
anonymous Apps Script access.

## Failure alerting (added 2026-08-29)

`run_fetch.sh` opens a `fetch-failure-pi`-labeled GitHub issue (via raw
`curl` + the REST API, using `GH_PAT` — no `gh` CLI on the Pi) the first time
a cycle fails, and won't open a second one while that issue stays open (same
dedup pattern as CI's `fetch-failure` label). It auto-closes (with a comment)
the next time a cycle succeeds. **Deliberately a different label from CI's**
— the two fetch paths fail independently (Chromium/session/RAM issues here
vs. runner/portal issues in CI), so a single shared label would hide "only
one of the two is actually down." Requires `Issues: read/write` on `GH_PAT`
(see `.env.example`) — the Pi's current token already covers this
(`admin: true` on the repo permissions check, broader than the documented
minimum). You'll see these as normal GitHub issue notifications/emails if
you're watching this repo, same channel as CI's own failure alerts.

**Mac-side monitoring:** `mac-monitor/` — a localhost dashboard
(`~/Desktop/AP127-PiMonitor.command`) showing fetch health, Pi vitals, live-site
timestamps, and buttons for run-fetch-now / SSH / Screen Sharing. See
`mac-monitor/README.md`.

## Deviations from the original plan (all applied)

- **Headless first-boot config was done from the Mac before flashing**, not via
  post-boot `dietpi-config`: `dietpi.txt` + `dietpi-wifi.txt` + an
  `Automation_Custom_Script.sh` written onto the SD card's FAT config partition.
  WiFi country `TH` (critical — the `GB` default silently fails to associate on
  Thai 2.4 GHz channels), tz `Asia/Bangkok`, 4 WiFi networks, `AUTO_SETUP_AUTOMATED=1`.
- **SSH server = OpenSSH (`AUTO_SETUP_SSH_SERVER_INDEX=-2`)**, not `-1`. The old
  step 2 note said `-1` = OpenSSH — wrong. `-1` = Dropbear, `-2` = OpenSSH.
- **zram = 50 % of RAM (~484 MiB), not 100 %.** DietPi's `dietpi-set_swapfile`
  refuses a zram-swap larger than 50 % of RAM ("Insufficient RAM size for
  desired zram-swap size"). Set via `AUTO_SETUP_SWAPFILE_SIZE=1`
  (auto) + `AUTO_SETUP_SWAPFILE_LOCATION=zram`. Persistent via a udev rule.
- **DietPi image:** `DietPi_OrangePiZero2W-ARMv8-Trixie` (v10.6, 2026-08-08) —
  its release notes specifically fix "stability issues on the Orange Pi Zero 2W
  caused by its onboard WiFi driver" (AIC8800). Use this version or newer.
- **avahi-daemon** (software ID 152) added to the auto-install so `DietPi.local`
  resolves. (mDNS still may not cross a wired↔WiFi bridge on some routers — the
  DHCP reservation is the reliable path.)
- **install.sh** run as the `dietpi` user (it refuses root); repo cloned to
  `/home/dietpi/flight-schedule-feed`, git identity set for the commit step.
- Two install.sh bugs fixed this round: `playwright>=1.50.0` was unquoted (shell
  read `>=` as a redirect, made a junk `=1.50.0` file); the zram check used
  `swapon` which isn't on `dietpi`'s PATH → false "no zram" warning. Now
  `grep zram /proc/swaps`.

**Original setup steps below are kept for reference / rebuild-from-scratch.**

## Why native, not Docker

`docker/` (this repo's sibling folder) has a Docker-based version of this
same idea, originally scoped for a 4GB Orange Pi 4 Pro. The user decided to
use a **1GB Orange Pi Zero 2W** for this job instead — on a board that
tight, and dedicated to exactly one job, Docker's own daemon/containerd
overhead is real weight worth skipping. This folder runs the same
underlying idea (persistent authenticated Chromium + a periodic fetch)
directly as systemd services instead.

## Why this exists at all

The Ops Portal now requires Google sign-in, and Google's bot-detection
permanently blocks a Playwright-launched Chromium from ever completing
that sign-in. GitHub Actions can't pass this — `fetch_schedule.yml` is
disabled (`CLAUDE.md`'s 2026-08-26 entry) until this (or the Docker
equivalent) is live. Full incident: `CLAUDE.md` and `AP127_Docs` README §10.

## One-time setup

### 1. Flash DietPi

Not Armbian, not the vendor image — **DietPi**, specifically because it's
the leanest option for a 1GB board (idle RAM usage in the ~100MB range vs.
meaningfully more for a general Debian/Armbian desktop-capable image).
Download the Orange Pi Zero 2W image from https://dietpi.com/#download —
flash with Raspberry Pi Imager or balenaEtcher, same as any other SD image.

**The Zero 2W's WiFi chip is 2.4GHz-only** — must use the 2.4GHz SSID, not a
5GHz network, or it'll never associate.

Before first boot, edit `dietpi.txt` on the boot partition to pre-configure
WiFi + SSH so it comes up headless (no monitor/keyboard needed):
```
AUTO_SETUP_NET_WIFI_ENABLED=1
AUTO_SETUP_NET_ETHERNET_ENABLED=0
AUTO_SETUP_SSH_SERVER_INDEX=-1
```
(`-2` = OpenSSH, `-1` = Dropbear — use **`-2`**; `ssh-copy-id` and install.sh
expect OpenSSH. Enabled automatically — reachable with zero monitor/keyboard.
`AUTO_SETUP_NET_HOSTNAME` left at DietPi's default, `DietPi` — reachable at
`DietPi.local` via mDNS *if* avahi-daemon is installed, ID 152, see deviations.)

And in `dietpi-wifi.txt` (same partition):
```
aWIFI_SSID[0]='<your 2.4GHz WiFi SSID>'
aWIFI_KEY[0]='<your WiFi password>'
aWIFI_KEYMGR[0]='WPA-PSK'
```

Boot it. First boot runs DietPi's setup automatically (a few minutes) — try
`ssh root@dietpi.local` (default password `dietpi`, forced change on first
login), or check your router's DHCP list if `.local` doesn't resolve.

### 2. First SSH + user setup

Default login: `root` / password `dietpi` — DietPi will prompt you to
change it on first login. Then set up key-based auth from your Mac:
```bash
ssh-copy-id root@<pi-ip>
```
(or `dietpi.local` if mDNS resolves — check before hunting for the IP)

### 3. Enable zram (do this before anything else — see "Memory cushion" below)

```bash
ssh dietpi@<pi-ip>
sudo dietpi-config
# Advanced Options > ZRAM > enable, size = 100% of RAM (DietPi's own
# recommendation for low-RAM boards) > Apply
```
Verify: `swapon --show` should list a `/dev/zram0` entry.

### 4. Clone the repo and run the installer

```bash
git clone https://github.com/AP127CMD/CMD_CTR ~/flight-schedule-feed
cd ~/flight-schedule-feed/pi-native
./install.sh
```
This installs Chromium + Xvfb + x11vnc + Python deps, sets up the two
systemd units (`ap127-chromium.service`, `ap127-fetch.timer`), and prompts
for your `GH_PAT` (see `.env.example`'s instructions for the exact scopes)
before enabling everything.

### 5. One-time login — NOT NEEDED in practice (fallback only)

As deployed 2026-08-29 the portal loads fully **without** signing in — a real
Chromium isn't bot-flagged the way Playwright's was. Only do this if
`journalctl -u ap127-fetch` starts showing `userHtmlFrame never appeared` /
empty fetches that a page reload doesn't fix, i.e. Google has begun gating
anonymous Apps Script access.

Chromium runs headless on Xvfb display `:99`. To see and use it:

```bash
# On the Pi (a second SSH session, or after install.sh finishes):
x11vnc -display :99 -nopw -listen 0.0.0.0 -once
```
`-once` means it serves exactly one connection then exits — no persistent
VNC server left running, saving RAM the rest of the time.

Then from your Mac: **Finder → Go → Connect to Server → `vnc://<pi-ip>`**
(macOS's Screen Sharing is a real VNC client, no extra app needed). Sign
into Google normally — this is a real, unmodified Chromium instance,
Google has no reason to flag it. Once you land on "Flight Student Portal"
(may take 20-30s to render — it's just a slow app), close Screen Sharing.
`x11vnc` has already exited on its own (the `-once` flag).

### 6. Verify

```bash
systemctl status ap127-chromium ap127-fetch.timer
journalctl -u ap127-fetch -n 50 --no-pager
```
Should show a fetch completing within 5 minutes, ending in `Saved →` and
(if there was new data) `Pushed on attempt N` + `CMDV2 refresh-data.yml
dispatched`.

## Memory cushion — why this matters and isn't optional

Chromium alone typically holds 300-500MB+ RSS even idle. On a 1GB board
that leaves genuinely little margin. Two things make this workable instead
of a constant OOM risk:
1. **zram** (step 3 above) — compressed swap in RAM. Not a substitute for
   having enough real RAM, but a real cushion against transient spikes
   (e.g. a heavier page during the portal's own slow renders) that would
   otherwise trigger an OOM-kill outright.
2. **The launch flags already baked into `start-chromium.sh`**
   (`--disable-gpu`, `--disable-dev-shm-usage`, `--disable-extensions`,
   etc.) — trims background work a single-purpose kiosk instance never
   needs.

If you see `journalctl -u ap127-chromium` showing repeated restarts, that's
likely an OOM-kill — check `dmesg | grep -i oom` to confirm, and consider
increasing the zram size (`dietpi-config` again) or, if it persists,
revisit whether this board has enough headroom for this job after all.

## Session expired

Same signature as the original incident: `journalctl -u ap127-fetch` shows
repeated `RuntimeError('userHtmlFrame never appeared')` after running fine
for a while. Fix: repeat step 5 above (the VNC login). Nothing else needs
touching.

## Security notes

- `pi-native/.env` (the PAT) is gitignored — never commit it. `chmod 600`
  it (the installer does this for you).
- CDP (port 9222) is bound to `127.0.0.1` only (`--remote-debugging-address`
  in `start-chromium.sh`) — never reachable from the network, only from
  `ap127-fetch.service` running on the same box.
- `x11vnc` is only ever run with `-once` and started manually when actually
  needed for a (re-)login — it is never a persistently-running service, so
  there's no standing unauthenticated VNC exposure on your network. If you
  want it password-protected too for extra safety during the brief window
  it's up, add `-passwd <something>` to the command in step 5.
