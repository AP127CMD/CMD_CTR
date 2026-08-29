# AP127 fetch pipeline — Orange Pi Zero 2W (native) deployment

**Status as of 2026-08-29: hardware setup in progress** — SD card being flashed
with DietPi (headless WiFi pre-config, see step 1). Not yet booted/verified on
real hardware as of this note; a fresh Claude Code session is picking up from
here to finish install + verification (see `CLAUDE.md`'s 2026-08-29 entry for
the handoff prompt used).

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
(`-1` = OpenSSH, enabled automatically — this is what makes it reachable
with zero monitor/keyboard ever needed. `AUTO_SETUP_HOSTNAME` left at
DietPi's default, `dietpi` — reachable at `dietpi.local` via mDNS.)

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

### 5. One-time login (the one human step)

Chromium is now running headless on Xvfb display `:99`, already sitting on
the portal's sign-in screen. To see and use it:

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
