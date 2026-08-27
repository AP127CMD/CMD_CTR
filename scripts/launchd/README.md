# AP127 auto-refresh — background on this Mac

Keeps `scripts/manual_refresh.sh` running every 5 minutes automatically,
for as long as this Mac is on — without interrupting normal use.

## Managing it

```bash
./scripts/launchd/manage.sh start    # install (if needed) and start everything
./scripts/launchd/manage.sh stop     # fully stop + remove all 3 agents, Chrome quits too
./scripts/launchd/manage.sh pause    # stop just the fetch timer; Chrome stays running, signed in
./scripts/launchd/manage.sh resume   # re-enable the fetch timer after a pause — instant, no relaunch
./scripts/launchd/manage.sh status   # what's running + the last fetch's outcome
```
`pause`/`resume` is the lighter-weight option when you just want a break —
Chrome stays warm so there's nothing to wait on when you resume. `stop`
fully tears everything down (frees the RAM Chrome was using) but your
signed-in session is preserved on disk either way — `start` afterward just
needs a few seconds to relaunch Chrome, not a fresh sign-in.

## How it works

Three macOS `launchd` LaunchAgents (the native background-service mechanism —
same idea as `systemd` on Linux, or the Pi's own `pi-native/` setup):

- **`com.ap127.chromium`** — keeps ONE real, plain Chrome window alive,
  signed into Google, restarting it automatically if it ever crashes or
  gets quit.
- **`com.ap127.chromium-hide`** — a separate, independent one-shot job that
  hides that window about 8 seconds after each `com.ap127.chromium`
  (re)start (`set visible of window 1 to false` — Chrome's `miniaturized`
  AppleScript property doesn't work on current Chrome versions, tested
  2026-08-27; a delayed step backgrounded *inside* `com.ap127.chromium`
  itself was tried first and silently never ran under launchd, also tested
  2026-08-27 — a fully separate job is simple enough to trust). After
  hiding, Chrome just sits in the background holding the authenticated
  session, using CDP (not visible interaction) for everything.
- **`com.ap127.fetch`** — runs `manual_refresh.sh` every 5 minutes. Almost
  always just attaches to the already-running Chrome above over CDP — no
  window, no interruption, no visible activity at all in the normal case.

Both run as your normal user (not root, not a hidden system service) —
LaunchAgents specifically run inside your logged-in session so they have
normal keychain/network access. They stop when you log out or shut down,
and resume automatically next time you log in (`RunAtLoad`).

## First install

```bash
./scripts/launchd/manage.sh start
```
If Chrome isn't already signed in (fresh profile, or the session expired),
a window will appear within a few seconds — sign into Google there, same
as any normal sign-in. After that it runs itself.

## Check it's working

```bash
./scripts/launchd/manage.sh status
```
or watch it live: `tail -f ~/Library/Logs/ap127-fetch.log` — a healthy
cycle ends with `=== Manual refresh complete ===`. If data hasn't changed
since the last check, it'll say `No data changes — nothing to push.` —
that's normal, not a failure.

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
