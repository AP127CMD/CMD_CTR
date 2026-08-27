# AP127 auto-refresh — background on this Mac

Keeps `scripts/manual_refresh.sh` running every 5 minutes automatically,
for as long as this Mac is on — without interrupting normal use.

## How it works

Two macOS `launchd` LaunchAgents (the native background-service mechanism —
same idea as `systemd` on Linux, or the Pi's own `pi-native/` setup):

- **`com.ap127.chromium`** — keeps ONE real, plain Chrome window alive,
  signed into Google, restarting it automatically if it ever crashes or
  gets quit. It hides its own window about 8 seconds after starting (`set
  visible of window 1 to false` — Chrome's `miniaturized` AppleScript
  property doesn't work on current Chrome versions, tested 2026-08-27) so
  it stays out of your way entirely; from then on it just sits in the
  background holding the authenticated session, using CDP (not visible
  interaction) for everything.
- **`com.ap127.fetch`** — runs `manual_refresh.sh` every 5 minutes. Almost
  always just attaches to the already-running Chrome above over CDP — no
  window, no interruption, no visible activity at all in the normal case.

Both run as your normal user (not root, not a hidden system service) —
LaunchAgents specifically run inside your logged-in session so they have
normal keychain/network access. They stop when you log out or shut down,
and resume automatically next time you log in (`RunAtLoad`).

## Install

```bash
./scripts/launchd/install.sh
```
If Chrome isn't already signed in (fresh profile, or the session expired),
a window will appear within a few seconds — sign into Google there, same
as any normal sign-in. After that it runs itself.

## Check it's working

```bash
launchctl list | grep ap127          # both should show a PID, not "-"
tail -f ~/Library/Logs/ap127-fetch.log
```
A healthy cycle ends with `=== Manual refresh complete ===`. If data hasn't
changed since the last check, it'll say `No data changes — nothing to
push.` — that's normal, not a failure.

## Uninstall / pause

```bash
./scripts/launchd/uninstall.sh
```
Stops both agents and removes them from `~/Library/LaunchAgents`. The
signed-in Chrome profile and window are left alone — quit Chrome yourself
if you want, or leave it (harmless, just idle). Re-running `install.sh`
turns auto-refresh back on without needing to sign in again, as long as
you didn't also clear the profile.

## Notes

- **Overlap-safe**: `manual_refresh.sh` has its own lock (added 2026-08-27
  specifically for this) — if a cycle somehow takes longer than 5 minutes,
  the next trigger skips instead of racing the same Chrome tab.
- **Session expiry**: same as everywhere else — `~/Library/Logs/ap127-fetch.log`
  will show repeated `userHtmlFrame never appeared` errors if the Google
  session itself expired. Fix: the Chrome window is still there, just
  hidden — bring it back with:
  ```bash
  osascript -e 'tell application "Google Chrome" to set visible of window 1 to true'
  ```
  Sign in again, then hide it again the same way with `to false` (the
  auto-hide only fires once, right after Chrome itself (re)starts — not
  every time you happen to show the window).
- **The Desktop launcher** (`AP127-ManualRefresh.command`) still works
  fine alongside this — running it manually just does one extra cycle on
  top of the automatic ones, no conflict (same lock guards both).
- Logs live in `~/Library/Logs/` (standard macOS convention), not inside
  the repo — they're not committed and grow unbounded over time; delete
  them periodically if that ever matters (`> ~/Library/Logs/ap127-fetch.log`
  truncates without needing to stop the agent first).
