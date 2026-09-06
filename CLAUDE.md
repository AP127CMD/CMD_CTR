# CMD CTR — Claude Code Context

## ⚠️ Data plane — READ FIRST (2026-09-06)

**The browser no longer loads `flight-data.js` from the Pages deploy — it loads it from the
`ap127-data` Worker** (`https://ap127-data.anusorn-tanmetha.workers.dev/flight-data.js`), a
stateless proxy in `data-worker/` that re-serves the git-committed data files from
`raw.githubusercontent.com` with a JS `Content-Type` + 60 s edge cache. Redeploy it with
`cd data-worker && npx wrangler deploy` (not git-integrated).

- **Data commits still happen** (`data/flight_schedule.json`, `flight-data*.js`, etc., every
  cycle — history + shared state intact) but every data-commit message ends with **`[CI Skip]`**,
  which makes Cloudflare Pages skip the build (status `idle`, doesn't count against the 500/mo
  free cap). A real code push must NOT contain `[CI Skip]` or it won't deploy.
- **Backend Workers (`watchdog`, `dispatcher`) still read `raw.githubusercontent.com` directly**
  — a Worker can't fetch a same-account `*.workers.dev` URL (CF 1042). The `ap127-data` Worker is
  for browsers + GitHub-Actions consumers only.
- `run_fetch.sh` and `fetch_schedule.yml` `POST` to the watchdog's `/notify` (key
  `WATCHDOG_NOTIFY_KEY` = the watchdog's `NOTIFY_KEY` secret) after a publish, so a schedule
  change reaches Telegram in seconds instead of on the watchdog's `*/2` cron.
- Full design + rollout: `docs/superpowers/specs/2026-09-06-r2-data-plane-decoupling-design.md`,
  `docs/superpowers/plans/2026-09-06-r2-data-plane-decoupling.md`.
- **Phase 2 (LIVE 2026-09-06):** the per-date `getStudentSchedule` loop runs
  `FETCH_RPC_CONCURRENCY` (default 4) dates at once — `_gather_dates_bounded()` + a FIFO
  semaphore; `=1` is exact serial. The Pi's `.env` sets it to 4. The Pi timer is `3min`
  (`pi-native/ap127-fetch.timer`) and `STANDBY_MAX_AGE_MIN` default is `3`. Full window went
  ~7.5 min → ~3 min; effective cadence ~3–6 min. Verified live: concurrency 1 and 4 both produce
  byte-identical output (404/18 dates, 6117 total). **Revert if Google bot-detection reacts:**
  `FETCH_RPC_CONCURRENCY=1` in `pi-native/.env`, and/or `OnUnitActiveSec=5min` +
  `STANDBY_MAX_AGE_MIN=6` — each independent.

## ⚠️ Fetch-path roles — READ FIRST (changed 2026-09-02)

**The Orange Pi Zero 2W is the PRIMARY scraper. GitHub Actions is the automatic fallback.**
This is the reverse of the 2026-08-30→09-02 arrangement, so older notes below describing CI as
"the primary fetch path again" are historical, not current.

| | Threshold | File |
|---|---|---|
| Pi fetches when data is ≥ | **6 min** (`STANDBY_MAX_AGE_MIN`) | `pi-native/run_fetch.sh` |
| Cloud takes over when data is ≥ | **35 min** (`STALE_TAKEOVER_MIN`) | `DB001/dispatcher/worker.js` |
| Telegram pages when data is ≥ | **60 min** (`DATA_STALE_LIMIT_MIN`) | `CMDV2/watchdog-monitor/src/index.js` |

- The CF dispatcher **no longer dispatches `fetch_schedule.yml` every 5 min** — only on a stale feed.
  It reads `fetchedAt` with a 600-byte `Range` request against `flight-data-recent.js` and **fails open**
  (dispatches when the age can't be determined).
- `fetch_schedule.yml`'s own cron is `0 */12 * * *` — an **unguarded cloud proof run**, not a fallback
  cadence. Do not "fix" it back to hourly; a fallback that never runs is one nobody knows is broken.
- The Pi's gate is no longer a *standby* gate, it's a **duplicate-work guard**: at 6 min against a 5-min
  timer it fetches whenever it's free to, and only skips when another writer just committed.
- **The timer interval is NOT the fetch interval.** The timer fires every 5 min; a real fetch takes
  **~12 min** (measured 2026-09-02: 10:02:19 → 10:14:27, 18 dates + leave/cancel backfill). `Type=oneshot`
  means cycles never overlap — the timer re-fires, sees fresh data, and skips. **Effective cadence is a
  fetch every ~12–18 min**, on par with CI's old ~13 min. Don't read "5-minute timer" as "5-minute data".
  This is also why 35 min is the cloud threshold: ~2 missed Pi fetches of headroom, not six.
- **To hand primary back to CI:** raise `STANDBY_MAX_AGE_MIN` on the Pi (one env var in
  `pi-native/.env`) and drop `STALE_TAKEOVER_MIN` in the dispatcher. That's the whole switch.
- Verify who is fetching: `git log --format='%an %s' -5` — Pi commits are authored
  `AP127 Pi` and suffixed `(orangepi-zero2w)`; CI commits are `github-actions[bot]`.


## ⚠️ Update rule — do this after EVERY code change
1. Bump cache token in `index.html` — next must be `r46`
2. Update the Verify section below with the new token + change summary
3. Update `/Users/nugui/AP127_Docs/README.md` §2.1 (add to §10 log) — then push AP127_Docs
4. `git add . && git commit -m "rNN: <what changed>" && git pull --rebase && git push`

## What this project is
Real-time flight-schedule dashboard. 8 views: Day Glance · Board · Gantt · Weekly · Analytics · Roster · Slot Finder · Auto Slot Finder.
GitHub: `AP127CMD/CMD_CTR` | Live: https://ap127-cmd-ctr.pages.dev | Local: `/Users/nugui/flight-schedule-feed/`

## Verify actual state — run before starting
```bash
grep -o '?v=r[0-9]*' index.html | sort -u
git log --oneline | grep -v "chore: update flight data" | head -6
gh workflow list -R AP127CMD/CMD_CTR --all   # fetch_schedule.yml is ENABLED again as of 2026-08-29 (was disabled 2026-08-26) — see below
```
**Last known:** token = `r46` (2026-09-06 — **`index.html` loads `flight-data.js`
from the `ap127-data` Worker instead of the local file** (r46 — token bumped, all
10 `?v=r45` → `?v=r46`). Part of the data-plane decoupling — see the "Data plane"
section at the top of this file. Data commits now carry `[CI Skip]` so they no
longer trigger Pages builds; the Worker serves the data. Next → `r47`.)
(2026-08-31 — **meetings/ground school excluded
from flight hours** (r45 — token BUMPED, view code changed). User: "Yes, exclude
Ground School and Meeting from flight hours." The portal schedules them in the
same feed as flights, each with a real `durMin` and no aircraft. Source side:
`generate_flight_data.py` now emits `isNonFlight` per flight (see the entry
below for the `bookingKind` capture that made this possible). Consumer side:
new `fMin()`/`fHrs()` in `js/app-shared.js`; all 26 sites summing `f.durMin`
directly route through them, plus `brdFlownMin`/`calFlownMin`/the Gantt row
total. Same change shipped to CMDV2 (`p176`) and CMDV3 — all three agree.
**Two signals, and the second is load-bearing:** `bookingKind` is authoritative
but only populates on fetches from today; the lesson-name fallback covers
history, because everything on or before 2026-07-09 lives in the frozen
pre-migration archive that is re-applied every run and NEVER re-fetched —
without it the exclusion would silently miss nearly all historical meetings
while appearing to work. The fallback is gated on "no aircraft at all" so a
genuine flight whose lesson merely mentions a meeting can't be dropped.
**Scoped exactly to what was asked** — ground-based briefings (C172 Training,
Long Brief AUPRT, Night Flying Long Briefing, ~29h) are deliberately NOT swept
in. **Impact is narrower than the raw 253.8h figure suggests, and worth being
precise about: ALL meeting/ground hours are status `Pending`, so every
Completed-gated metric (flown hours, Ops Analytics HOURS) was already
unaffected — this changes SCHEDULED-hours figures only.** Verified live in the
browser on both dashboards: May 2026 scheduled hours drop by the identical
105.5h in each. Meetings remain VISIBLE on schedules (p116's fix preserved);
row counts unchanged. 79 tests.)
(2026-08-31 — **full fetch-system audit: 6 real
bugs found and fixed, Pi demoted to a true standby** (scraper/infra-only —
token not bumped). User: "Audit and check all the fetching system thoroughly.
I want consistency and reliable system."
**Verified healthy first (evidence, not assumption):** zero status flip-flops
across 431 bookings × 35 commits (the 2026-07-27 failure mode is genuinely
gone — the RPC rewrite fixed it); flight count stable at 5784/138 dates, zero
regression streaks; both writers producing byte-identical data; Pi healthy
(zram active, 474 MB free, 28% disk).
**Bugs found and fixed:**
(1) **Pi failure alerts were completely broken** — issues #11/#12/#13 were
triplicates that never auto-closed. Root cause, verified live: the Pi's
fine-grained PAT gets `403 Resource not accessible by personal access token`
on issue close/comment, and silently drops `labels` on create (applying a
label is an issue *modification*). Label-based dedup therefore always matched
zero. Dedup now matches on **title prefix** (read-only, can't regress that
way). Auto-close still 403s — that is now **reported honestly**; the first
version printed "Auto-closed #N" with no status check, i.e. it lied on every
single call. Fix needs `Issues: Read and write` on the PAT (user action).
(2) **DB001 `update-cache.yml` had no auto-close step** — issue #5 sat open
since 08-26, so its dedup swallowed every alert for 5 days. Added; **verified
live** (#5 auto-closed on the next run).
(3) **`schema-drift` had the same gap** — third instance of this identical
ecosystem-wide pattern (after `fetch-failure` 07-25 and `dispatcher-failure`
08-30). Added an auto-close whose condition is "ran AND found no drift", not
plain `success()`.
(4) **Booking-id validator rejected legitimate ids** — the portal now embeds
the flight type (`BK-AP FAM-…`, `BK-Skill Test-…`, `BK-Recurrent-W-TH-…`);
the old `[A-Z0-9-]+` allowed neither spaces nor lowercase, so dozens of bogus
warnings per run **saturated the drift alert**, which (via 3) then masked
everything else.
(5) **Real drift, revealed once (4) stopped drowning it:** the portal marks
non-syllabus bookings `MEETING|Pending` / `GROUND|Pending` /
`TESTFLIGHT|Pending` and added `bookingType`/`leg` fields. The kind marker was
being **discarded** — it fell through `status if status in VALID_STATUSES else
"Pending"` — so a 3-hour CATC meeting or a 60-min Ground School slot was
indistinguishable downstream from a real training flight (both carry a
durationMin, neither an aircraft). Now captured as **`bookingKind`**;
`bookingType`/`leg` passed through. **Deliberately additive — no consumer
changed, so no reported number moved.** ⚠️ **Open question for the user:
should MEETING/GROUND be excluded from flight-hours KPIs?** They currently
inflate them. 24 new tests (55 total, was 31).
(6) **Local repo was wedged mid-rebase** with UU conflicts, 5 h behind — the
Mac launchd agents are (correctly) unloaded, so it was inert, but any manual
run would have failed. Reset to origin.
**Architecture change (user's call):** the Pi was NOT a backup — it fetched
unconditionally every 5 min, landing commits **10-20 seconds** from CI's,
doubling portal load, CMDV2 dispatches and push contention. `run_fetch.sh`
now gates on the committed `fetched_at`: <20 min → stand by (no portal hit at
all); ≥20 min → take over unattended; plus a forced **proof run** every 6 h so
the standby stays proven rather than first exercised during an outage. Fails
safe (bad/missing timestamp → fetch, never silent standby). Unit-tested: 7
age-parser cases incl. every error path, 8 gate-decision cases.
**Verified live end-to-end:** drift cleared → `schema-drift` #10 auto-closed
itself → **CMD_CTR now has zero open issues**.)
(2026-08-29 — **GitHub Actions confirmed working
again + Pi failure-alerting added — both fetch paths now run permanently in
parallel** (infra-only — token not bumped). User: "the portal site seem to
change some permission setting? check if it's no longer an issue with github
auto action" — tested for real rather than guessing: a fresh, non-persistent,
headless Playwright-launched Chromium (`test_gha_style.py`, exactly what GHA
uses) reached `userHtmlFrame` anonymously from a local run, then a live
`workflow_dispatch -f force=true` on the actual disabled workflow confirmed it
end-to-end on GitHub's own runners — **280 flights/18 dates fetched, committed
(with a live push-conflict against the Pi's own concurrent commit, correctly
absorbed by the existing rebase-retry loop), CMDV2 dispatched.** Root cause
now understood precisely: the portal was never permanently gated — Google's
bot-detection was flagging Playwright's browser fingerprint specifically
during the *interactive sign-in* flow; the portal serves data to an anonymous
visitor (no sign-in) without ever tripping that check, for both a real
Chromium (Pi, see 2026-08-29 entry below) AND, it turns out, a fresh Playwright
one (GHA). Left `fetch_schedule.yml` **enabled** (was `disabled_manually`
since 2026-08-26). **User's call: keep BOTH GitHub Actions and the Pi running
permanently** — redundant, not conflicting (proven by the very push-conflict
above resolving cleanly). Then: **added failure alerting to the Pi side**,
which previously had none (GHA already opens a `fetch-failure`-labeled issue
on any failed run, auto-closing on next success — see `.github/workflows/
fetch_schedule.yml`). `pi-native/run_fetch.sh` now mirrors that exact
open-once/dedup/auto-close pattern via raw `curl`+GitHub REST calls (no `gh`
CLI on the Pi) — deliberately a DIFFERENT label, `fetch-failure-pi`, so the
two systems' failures stay distinguishable (one being down doesn't mask the
other, and vice versa). Needs `Issues: read/write` on the Pi's `GH_PAT` —
verified the Pi's current token already has it (`admin: true` on the repo
permissions check) — `.env.example` updated to document the requirement for
any future token rotation. Deployed live: pulled onto the Pi via SSH,
confirmed present in the running file — takes effect next 5-min cycle, no
service restart needed (`run_fetch.sh` runs fresh each time). Not yet
verified against a REAL failure (would need to simulate one) — the
open/close logic itself was exercised read-only (issue list HTTP 200) but not
a live create+close round-trip.)
(2026-08-29 — **Orange Pi Zero 2W: DEPLOYED +
verified live, and a Mac-side monitor tool added** (infra/tooling-only — token
not bumped). The Pi (DietPi, hostname `DietPi`, `192.168.1.123` DHCP-reserved)
now runs the fetch pipeline 24/7: `ap127-fetch.timer` every 5 min → real
fetches committed+pushed to `AP127CMD/CMD_CTR` → CMDV2 `refresh-data.yml`
dispatched → both Pages sites pick up the new `fetchedAt`. Verified end-to-end
multiple cycles. **`fetch_schedule.yml` stays PERMANENTLY disabled** — no CI
fallback, the Pi is the system (user's explicit call). **Key finding: the
Google sign-in step was never needed** — a real OS Chromium loads the Ops
Portal anonymously; the 2025 incident was bot-detection against
*Playwright-launched* browsers specifically. Deployment deviations from
`pi-native/README.md`'s original plan (all now documented there): headless
first-boot via SD-card `dietpi.txt`/`dietpi-wifi.txt`/`Automation_Custom_Script.sh`
written from the Mac pre-flash (WiFi country `TH` is critical — `GB` default
won't associate on Thai ch.12-13); SSH = OpenSSH (`-2`, not `-1`=Dropbear);
zram = 50% RAM (~484 MiB, DietPi refuses >50%); DietPi image
`OrangePiZero2W-ARMv8-Trixie` v10.6 (fixes the AIC8800 WiFi driver);
avahi-daemon (ID 152) auto-installed; `install.sh` runs as `dietpi`, repo at
`/home/dietpi/flight-schedule-feed`. Fixed 2 `install.sh` bugs: unquoted
`playwright>=1.50.0` (shell redirect → junk `=1.50.0` file), and a false
"no zram" warning (`swapon` not on `dietpi`'s PATH → now `grep zram /proc/swaps`).
**New: `pi-native/mac-monitor/`** — single-file Python stdlib localhost
dashboard (`~/Desktop/AP127-PiMonitor.command` → `http://127.0.0.1:8766`):
headline green/yellow/red, fetch-pipeline + Pi-vitals + live-site + CMDV2
panels via one SSH call + `gh api` + `curl`, `journalctl` tail, and buttons for
run-fetch-now / SSH shell / Screen-Sharing(x11vnc `-once`). `--selftest` flag.
Design spec: `docs/superpowers/specs/2026-08-29-mac-pi-monitor-design.md`.)
(2026-08-29 — **Orange Pi Zero 2W hardware
setup started** (infra-only — token not bumped). User has no LAN port and no
monitor on the Zero 2W — resolved via DietPi's headless first-boot config:
`dietpi-wifi.txt` (SSID/key/`WPA-PSK`) + `dietpi.txt`
`dietpi-wifi.txt` (SSID/key/`WPA-PSK`) + `dietpi.txt`
(`AUTO_SETUP_NET_WIFI_ENABLED=1`, `AUTO_SETUP_NET_ETHERNET_ENABLED=0`,
`AUTO_SETUP_SSH_SERVER_INDEX=-1` for OpenSSH auto-enabled) dropped onto the
SD card's boot partition from the Mac before first boot — no screen/keyboard
ever needed, reachable at `root@dietpi.local` (password `dietpi`, forced
change on first login) once it's up. **Noted: the Zero 2W's WiFi chip is
2.4GHz-only** — must use the 2.4GHz SSID (`NuGuitar 2.4G` here), not the 5GHz
network, or it'll never associate; `pi-native/README.md` step 1 updated to
call this out explicitly and to correct the default-login user from `dietpi`
to `root` (matches current DietPi behavior). `pi-native/README.md`'s status
line updated to "hardware setup in progress." **Handoff:** a fresh Claude
Code session was given a self-contained prompt (this repo, `pi-native/`,
current state, DietPi flash already done, don't touch `docker/` or
re-architect the CDP-attach approach, don't re-enable `fetch_schedule.yml`
without asking) to carry the rest through: SSH in, run `pi-native/install.sh`,
get Chrome signed in over VNC (`pi-native/README.md` step 5), verify the
5-min timer produces real fetches, update docs again once proven. Not yet
verified live at time of writing — first boot/SSH not yet confirmed.)
(2026-08-27 — **`scripts/launchd/` — background auto-refresh on the Mac**
(scraper/infra-only — token not bumped). User: "keep it auto refresh on my macbook... run it in
background... as long as my mac is turned on, keep the fetching alive" (and separately asked about an
iOS app for this — declined: Apple requires WebKit not Chromium, and iOS deliberately suspends
background apps, making a persistent authenticated-session poller impossible there — the Pi remains the
right tool if "always on regardless of the Mac" is the real goal). Built with three `launchd`
LaunchAgents (macOS's native background-service system): `com.ap127.chromium` (persistent, auto-
restarting signed-in Chrome, direct `ProgramArguments` at the binary — no wrapper needed),
`com.ap127.chromium-hide` (a SEPARATE one-shot agent that hides the window ~8s after each restart —
tried backgrounding this step inside the chromium job first, confirmed live it never actually ran under
launchd, no error, just silently didn't fire), `com.ap127.fetch` (runs `manual_refresh.sh` every 5 min,
`EnvironmentVariables.PATH` set explicitly since launchd jobs don't source shell rc files). `install.sh`/
`uninstall.sh` + `README.md`. Two real bugs found only by testing live, not assumed: (1) Chrome's
`miniaturized` AppleScript property errors on current Chrome ("Can't make miniaturized of window 1 into
type specifier") — `visible` works and is what's used. (2) `launchctl bootstrap` right after `bootout`
of the same label reliably fails ("Input/output error") without a real pause — needs 3s + a retry, 1s
wasn't enough. Added a lock guard (mkdir-based mutex, stale-PID aware) to `manual_refresh.sh` itself so
overlapping timer-triggered runs can't race the same Chrome tab. **Verified live end-to-end multiple
times**, including a full clean reinstall: hidden window confirmed, 300+ flights fetched and pushed,
CMDV2 triggered, all clean.)
(2026-08-27 — **Timeline View opening removed from the critical path
entirely — it was vestigial** (scraper-only — token not bumped). User asked, correctly: "we no longer
use the method of Timeline view clicking anymore?" — checked, and every actual data fetch (the date
loop, rosters, leaves, cancel records) is a pure `google.script.run` RPC call; none of them read
Timeline's DOM or need any view open. The entire reload/wrong-element/mouse-coordinate-click saga just
below this entry was all spent keeping alive a step nothing downstream actually needed. Fix: `scrape_window()`
no longer opens Timeline View at all. The one thing that genuinely still needs it — Timeline mode-tab
visibility, a minor structural-drift signal — moved into `_capture_expensive_fingerprint()`, already
throttled to once/`STRUCTURE_CHECK_INTERVAL_HOURS` (24h) — so this fragility now matters once a day
instead of every single run. Verified live: clean run, first attempt, no Timeline-related output at all
in the log. `check_portal_structure()`'s diff logic and `_return_to_home()`'s warning message updated
to match (the latter is no longer a predictor of the next step failing — the date loop doesn't care).)
(2026-08-27 — **three real reliability fixes to the CDP-attach path, found
via `manual_refresh.sh`'s first several real-world runs** (scraper-only — token not bumped). All apply
equally to `pi-native/`'s and `docker/`'s deployments (same `fetch_schedule.py`), not just manual runs.
(1) A tab left open for many hours (the normal state for ANY persistent-Chromium deployment — the whole
point of the Pi setups) can go internally stale: still authenticated, still on the right URL, but
`userHtmlFrame` never reappears. Fix: `scrape_window()` now ALWAYS reloads the page when
`FETCH_CDP_ENDPOINT` is set, never trusts an already-open tab is still healthy. (2) After that reload,
`_open_timeline_view()`'s "Timeline View" click (`get_by_text(...).click()`) reported success but the
app silently stayed on the Home screen — traced to Playwright resolving the click to the `<h3>` text
node, which has no click handler; the real handler lives on a `button.landing-btn` several levels up.
Fixed to target that button specifically. (3) Even targeting the right element wasn't enough — a normal
Playwright mouse-coordinate `.click()` on that button STILL silently no-op'd (correct element, correct
bounding box, reported success, app never navigated). Root cause: coordinate translation through this
portal's two levels of nested iframes (page → sandboxFrame → userHtmlFrame) is a known trickier case
specifically for a browser attached via `connect_over_cdp` (the whole reason CDP mode exists) vs. one
Playwright launched itself. Fixed by dispatching the click via JS (`element.evaluate("el => el.click()")`,
bypassing screen-coordinate simulation entirely) instead — confirmed reliable across several real runs.
Verified end-to-end multiple times same day: fetched 300+ flights across 18 dates each time, pushed,
CMDV2 triggered, all clean. **`check_portal_structure()`'s other `get_by_text(...).click()` calls**
(View Daily Schedule, Submit Forms, Cancel Flight, Leave Request) may have the same latent fragility —
not yet hit in practice (that check is throttled to once/24h and didn't fire during this debugging), left
as-is since that function already treats any failure there as non-fatal/best-effort — revisit if one of
those ever actually fails.)
(2026-08-26 — **manual-refresh tool + Orange Pi Zero 2W pivot** (scraper/
infra-only — token not bumped). Two changes: (1) `scripts/manual_refresh.sh` — one command
(`./scripts/manual_refresh.sh`) that does the entire 2026-08-25 manual-fix dance automatically: opens/
reuses a persistent, real, unmodified Chrome window (`~/.ap127-manual-chrome-profile` — sign into Google
once, ever, not once per run), waits for it to reach the portal, runs `fetch_schedule.py` against it
over CDP, commits+pushes any changes, triggers CMDV2's refresh. Requires Chrome + an authenticated `gh`
CLI, nothing else. Verified live the same day it was written — see AP127_Docs §10 for the run's actual
numbers. (2) **User decided to dedicate an Orange Pi Zero 2W (1GB) to this job instead of the Orange Pi
4 Pro** (that board stays for its other general home-server plans — see `/Users/nugui/CLAUDE/HomeServer/`
— just no longer tied to AP127 specifically) — new `pi-native/` folder, a **native** (no Docker)
systemd-based port of the same idea, deliberately leaner than `docker/`'s approach since Docker's own
daemon overhead is real weight a dedicated 1GB board can't spare: `ap127-chromium.service` (Xvfb on a
fixed `:99` + Chromium with memory-conscious flags) + `ap127-fetch.timer` (5-min cadence) +
`install.sh`. OS choice: **DietPi**, not Armbian — leaner idle footprint than Armbian, which matters
more here than it did for the (still-Armbian-planned) Pi 4 Pro. `docker/` is left in place, unused for
now — still valid if ever revisited. **Status: written, NOT yet deployed** — hardware not yet flashed/
set up. Full setup: `pi-native/README.md`.)
(2026-08-26 — **`fetch_schedule.yml` DISABLED, dispatcher paused — stopping
the failing fetch until the Orange Pi 4 Pro is live** (scraper/workflow/infra-only — token not bumped).
Every run has been failing on the Google sign-in wall (see the entry below) since 2026-08-25 04:29 UTC;
the backoff fix throttled it to a run every 15-30 min, but it was still failing every time it ran, for
no benefit — nothing will succeed until either the Pi is live or someone manually re-authenticates.
Stopped cleanly rather than left to keep failing quietly: `gh workflow disable "Fetch Flight Schedule &
Deploy" -R AP127CMD/CMD_CTR` (stops both the hourly `schedule:` fallback and any `workflow_dispatch`
call — reversible with `gh workflow enable`, same command). The 3 in-flight/queued runs at the time were
cancelled (`gh run cancel`) rather than left to finish and fail. **Also paused the CF dispatcher's own
trigger** — `AP127CMD/DB001`'s `dispatcher/worker.js` had this workflow as a `workflow_dispatch` target
on its 5-min cron; left in place it would have kept POSTing to a disabled workflow's dispatch endpoint
(a 403), which the dispatcher's own failure-handling would treat as "failed to trigger" and open a
`dispatcher-failure` issue on DB001 — commented out (not deleted, with a clear re-enable note) instead,
redeployed via the existing `deploy-dispatcher.yml` auto-deploy-on-push. CMDV2's own downstream trigger
(dispatched by this workflow on success) is correspondingly quiet too now — noted in that comment.
**To re-enable once the Pi is live and proven:** uncomment the target in `dispatcher/worker.js` (push to
redeploy), then `gh workflow enable "Fetch Flight Schedule & Deploy" -R AP127CMD/CMD_CTR`. Nothing about
the fetch code itself changed this round — `docker/` from the entry below is still the actual fix, this
was just stopping the now-pointless CI churn while it isn't live yet.)
(2026-08-25 — **`docker/` — Orange Pi 4 Pro deployment prepared, NOT YET
LIVE** (scraper/infra-only — token not bumped). Root cause of the whole day's outage turned out to be
deeper than portal slowness: the Ops Portal now requires Google sign-in, and Google's bot-detection
permanently blocks a Playwright-launched Chromium from completing that sign-in (confirmed, not a
timeout issue — tested up to a 300s budget). GitHub Actions can never pass this, so the backoff fix
above (still correct and still deployed) can throttle the damage but not cure it. Durable fix: a
persistent, real, manually-signed-in Chromium on dedicated hardware (an Orange Pi 4 Pro, 4GB, arriving
2026-08-26) that `fetch_schedule.py` attaches to over CDP via `FETCH_CDP_ENDPOINT` (added same day —
see the `_get_content_frame()` docstring) — the exact code path proven working in a manual run that
fetched 358 flights across 18 dates on the first try. `docker/` (compose file, `fetch-cron/` Dockerfile
+ `run_fetch.sh`, `README.md`) is written and reviewed but **unverified end-to-end** — the hardware
hasn't arrived yet. Full setup runbook at `/Users/nugui/CLAUDE/HomeServer/RUNBOOK.md`. Does not disable
or replace the CI workflow — that keeps running as a fallback, now cheap thanks to the backoff fix.)
(2026-08-25 — **portal-outage backoff + stale-issue cleanup**
(scraper/workflow-only — token not bumped). Real incident: the Ops Portal itself went unresponsive
(`userHtmlFrame never appeared`, 90s×3 attempts) for **7.5+ hours straight** (04:29→~12:00 UTC), and
the CF dispatcher kept firing `fetch_schedule.yml` every 5 min the whole time regardless — ~90
consecutive failed runs, each burning a fresh Playwright session against an already-unresponsive
portal, which is exactly the kind of load an outage doesn't need more of. Also found: the workflow's
own `fetch-failure` issue-dedup (`if (issues.length === 0)`) had been silently defeated for over a
month — issue #8 sat open since 2026-07-18 (never closed, nobody's job to close it), so this entire
7.5h incident generated **zero** fresh GitHub issues, only raw per-run Actions failure emails (which
is what actually got noticed). Same stale-issue gap found in CMD_CTR #7 (schema-drift) and DB001
#3/#4 (dispatcher/update-cache) — all four closed manually as a one-time cleanup.
Fix, `.github/workflows/fetch_schedule.yml`: (1) **new "Check portal-outage backoff" step**, first in
the job (before checkout, so a skip costs ~nothing) — queries the last 30 completed runs of this same
workflow via `gh api`, counts the consecutive-failure streak at the head of the list; under 6
(<~30 min down) retries normally every trigger, 6–17 (~30–90 min down) throttles to ~once per 15 min,
18+ (90+ min down) throttles to ~once per 30 min — all computed by comparing elapsed time since the
last attempt against a tier-based `MIN_GAP_S`, no new state/KV needed since GH Actions run history IS
the state. All steps from Checkout through Commit/Trigger-CMDV2 gated
`if: steps.backoff.outputs.skip != 'true'`. New `workflow_dispatch` input `force` (boolean, default
false) bypasses backoff entirely for a manual run — the CF dispatcher's API call never sets it, so only
a human clicking "Run workflow" with the box checked can force through. (2) **new "Close stale
fetch-failure issue on success" step** — on a successful (non-skipped) run, auto-closes+comments any
open `fetch-failure` issue, so the dedup check can never again be silently defeated by an issue nobody
closed. New permission `actions: read` added (needed for the `gh api .../runs` call in the backoff
step). Verified: YAML parses, `if:` conditions on every gated step, and the streak/elapsed-gap boundary
math (all 6/18-streak and 900s/1800s-gap edge cases) checked against a standalone simulation before
deploying — not yet observed live against a real recovery (today's outage was still ongoing at deploy
time). **`REGRESSION_GUARD_MAX_STREAK`(=3, per-date, inside `fetch_schedule.py`) is a different, unrelated
guard** — that one decides whether to trust a single date's fresh-vs-existing flight count within one
run; this new backoff decides whether to attempt a run **at all**, at the workflow level, across runs.)
**CORRECTION, same day: the GH-Actions-run-history design above had a real bug — replaced with
persisted state before it ever got wide exposure.** Live proof, ~25 min after the first deploy: the
first backoff-triggered skip at 12:25 UTC worked exactly as designed (job finished in 14s), but the
VERY NEXT trigger (12:30) went right back to a full 3-min failing attempt, and every 5-min trigger
after that did too — the throttling lasted exactly one cycle. Root cause: a **skipped** run's own
GitHub Actions conclusion is `"success"` (no step failed) — completely indistinguishable, when read
back via `gh api .../runs`, from a genuinely successful fetch. The streak-counting loop stopped at the
first non-`"failure"` conclusion, so the 12:25 skip itself reset the apparent streak to 0 for 12:30's
read, and backoff never re-armed. **Fix:** moved the state out of GH Actions run history entirely,
into a small persisted file, `data/backoff_state.json` (`{consecutiveFailures, lastAttemptAt}`) —
matches the existing `portal_fingerprint.json` precedent. `scripts/fetch_schedule.py`'s
`main_with_retry()` now writes it directly: reset to 0 on success (but ONLY if a streak actually
existed to clear — writing every healthy run would defeat "Commit updated data"'s skip-if-unchanged
fast path, since the timestamp differs every run), incremented on a fully-exhausted failure. The
workflow's "Check portal-outage backoff" step now just reads this file via `jq` (no `gh api`/`GH_TOKEN`
needed any more — `actions: read` permission removed). Checkout moved to the very first step
(unconditional now — the backoff check needs the file from the repo). "Commit updated data" changed
to `if: always() && ...` (was implicitly success-only) so the incremented counter gets committed+pushed
even when the fetch itself failed — safe, because the OTHER data files it also stages are provably
untouched on this failure mode (the scraper never reaches its output-write call when `userHtmlFrame`
never appears). 7 new tests in `scripts/tests/test_backoff_state.py` (31 total passing) cover the
missing-file/malformed-JSON/round-trip cases and, critically, both `main_with_retry()` branches this
bug came from: success-resets-an-existing-streak and failure-increments-from-prior-state. Not yet
re-verified live at time of writing (deploying now) — watch the next few dispatcher cycles.)
(2026-08-06 — **restored `recover_vanished_bookings()`, removed during
the RPC migration below, for bookings that vanish via a portal path other than the Cancel Flight form**
(scraper-only — token not bumped). Real user report, notifications had just been turned back on:
recent Watchdog cancel notices showed no reason. Traced 4 real bookings (e.g. `BK-AP-127-TEER-FKTRW`)
that went Pending → absent between two consecutive scrapes with `getStudentSchedule` never showing
them as Canceled and no Cancel Record ever submitted for them — most likely removed via the portal's
Edit Request "delete this record entirely" option, a path that never surfaces as status=Canceled
anywhere. The RPC migration's removal of `recover_vanished_bookings()` assumed `getStudentSchedule`
always shows Canceled inline, which is true for Cancel-Flight cancellations but not this path.
Restored the same diff-based safety net (pure, no Playwright dependency — it never actually needed
removing) with a new `recovered` flag, true only when no cancel reason is found anywhere; the
existing retroactive cancelReason-backfill sweep in `main()` now also clears it if a matching Cancel
Record eventually appears. `generate_flight_data.py` passes `recovered` through when true.
AP127_V2/watchdog renders `recovered` entries as a distinct "🗑️ Removed" notice (with an explanatory
line) instead of a normal "❌ Cancelled" one, per explicit user request to not mix the two up — scoped
to the notification only, dashboards still show these as Canceled (lowest-risk option, doesn't touch
any dashboard's status-rendering logic). 8 new tests. Live commit: `4bc893bf7`.) (2026-07-27 — **root
cause of the 2026-07-31 status flip-flop fixed:
scraper switched from Timeline mode-switching to the `getStudentSchedule` RPC** (scraper-only — token
not bumped, per the b8e0544c precedent below). The flip-flop was traced to `scrape_window()`'s
Canceled-mode second pass assuming the Timeline's mode switch stays sticky across every date change in
its loop — never verified, confirmed broken live for `2026-07-31`. A live audit (same day) found an
undocumented RPC, `getStudentSchedule({date})`, that returns Pending/Completed/Canceled/Meeting for a
date in one clean JSON call — verified against 4 known dates matching exact counts, `actual{}` intact.
Replaced the entire Timeline DOM-polling fetch (`_fetch_one_date()`, the Canceled-mode pass,
`recover_vanished_bookings()`, the `forbidden_mode` guard from earlier today) with this RPC as the sole
fetch mechanism — no Timeline fallback, per explicit decision (a future RPC failure gets fixed, not
silently degraded around). RPC failures are now loud (timeout/exception) instead of silently-wrong-data,
which is why the fallback machinery could be deleted rather than kept. Also added a fatal check
(`CriticalRPCMissingError`) in `check_portal_structure()` — if `getStudentSchedule` ever disappears from
the portal's RPC surface, the run now aborts loudly instead of silently fetching nothing; ordinary
structural drift stays non-fatal (warn-and-continue) as before. New unit tests in `scripts/tests/`
(this repo's first test suite — `requirements-dev.txt`, `pytest.ini`). See
`docs/superpowers/specs/2026-07-27-rpc-based-schedule-fetch-design.md` for the full investigation and
design.) (2026-07-27 — **regression guard given an escape hatch + a stuck date manually
corrected** (scraper/data-only — token not bumped). Follow-on same day: found the earlier concurrency
fix (below) didn't actually cause any new problem, but tracing it exposed a SEPARATE, pre-existing bug —
the regression guard (added 2026-07-11, `existing→fresh count dropped sharply` check) had no escape
hatch. Once triggered for a date, `existing_schedules[date]` never gets refreshed again (each run
compares fresh data against that same frozen baseline forever), so a date stuck this way could NEVER
self-correct. Confirmed live via the run logs: `2026-07-31` tripped the guard intermittently from ~10:00,
then permanently from **12:40 onward — 50 minutes before the concurrency fix even deployed** — continuing
to reject every fresh fetch for hours, frozen at "30 flights, all Canceled" even after user confirmed
against the actual Ops Portal that it genuinely shows 30 **Pending** flights. Fix: `scripts/fetch_schedule.py`
now tracks a per-date consecutive-rejection streak (`_regressionStreaks`, persisted in
`data/flight_schedule.json`, internal only); after `REGRESSION_GUARD_MAX_STREAK`=3 in a row, it accepts
the fresh data instead of freezing forever — still absorbs a genuine short blip (1-2 bad reads), just
can't get stuck permanently once the underlying cause clears. Verified via a standalone simulation of
the exact logic (6-consecutive-bad-reads scenario + an interrupted-streak scenario) before deploying.
**Also found a separate, real inconsistency** while manually correcting the frozen date: the SAME commit
had `data/flight_schedule.json` already correctly showing Pending (self-corrected) while the derived
public `flight-data.js` — the file CMDV2/CMDV3/DB001/watchdog all actually read — still showed Canceled;
root cause not fully forensically pinned down (plausibly a rebase-conflict-resolution artifact from the
earlier overlapping-runs period), fixed by regenerating `flight-data.js` fresh from the now-correct
source and verifying the diff was scoped to exactly the expected changes before committing. Live:
`9c6a9cca6` (guard fix), `c41b6fe3f` (data correction).) (2026-07-27 — **fixed overlapping `fetch_schedule.yml` runs corrupting live status data** (scraper/workflow-only — token not bumped). Real incident: AP127_V2/watchdog reported 36+ bookings firing duplicate Pending↔Canceled notifications all day, none actually re-cancelled. Traced one booking (BK-MS2WDMXN) through 72 consecutive live commits — its raw `status` genuinely flipped in `flight-data.js` itself, dozens of times, zero matching cancellation record. Checked the workflow's own GitHub Actions run history via the API: runs #14111/#14112 started 2 seconds apart, and every consecutive run's duration (6–11 min, confirmed all day) exceeded the 5-min CF Worker dispatcher trigger interval — meaning 2–3 independent Playwright scraper instances were **always** running in parallel, each reading its own possibly-stale `window.G.flights` snapshot for the same dates. The existing "push with retry to survive concurrent runs" step lands every commit via rebase but does nothing to stop the underlying race — it just guarantees each racy snapshot successfully overwrites the last. Fix: added `concurrency: {group: fetch-schedule, cancel-in-progress: false}` to `.github/workflows/fetch_schedule.yml` — a new trigger arriving mid-run now queues instead of starting a second scrape against the same file. `cancel-in-progress: false` deliberate: cancelling the in-progress run instead would mean a run this length practically never finishes. Live: `e360711d5`.) (2026-07-17 — ASF rank-data primary URL repointed to `https://ap127-db001.pages.dev/cache.json`: the old primary `ap127cmd.github.io/DB001/cache.json` froze 2026-06-03 when DB001's Pages deploy job was removed but still returns 200 with June data, so the fresh fallback never fired and ASF rankings ran on 6-week-old progress). 2026-07-16: post-flight actuals restored from the new portal's `actual{}` (scraper-only — token not bumped, per the b8e0544c precedent for changes that touch no browser-cached asset). Prior r43: 2026-06-21 — hours always use block time durMin, not airborne, across all ops views. Next → `r45`.

## Key facts
> Several bullets below (mentioning `_fetch_one_date()`, a Timeline "Canceled-mode" second
> pass, or `recover_vanished_bookings()`) describe the pre-2026-07-27 fetch mechanism —
> superseded by the `getStudentSchedule` RPC (see the Verify section's `**Last known:**` entry
> and `docs/superpowers/specs/2026-07-27-rpc-based-schedule-fetch-design.md`). Left as
> historical record, not current architecture.
- React 18 CDN UMD + Babel Standalone — no build step; `<script type="text/babel">`
- `flight-data.js` is AUTO-GENERATED by GHA cron — **never edit manually**
- **`flight-data-recent.js` (2026-08-16, new, also AUTO-GENERATED — never edit manually):**
  watchdog-ONLY, small pre-windowed sibling of `flight-data.js` — `scripts/generate_flight_data.py`'s
  `filter_recent()` filters the same transformed data to a generous rolling `-4d/+15d` window
  (vs. AP127_V2/watchdog's own exact `-3d/+14d` window) and omits `instructors`/`resources`/`leaves`
  entirely (the watchdog never reads them). Cuts ~2 MB/5000+ flights down to tens of KB/a few hundred
  flights — fixes ap127-watchdog's recurring "Exceeded CPU Limit" cron kills (Workers Free plan, hard
  ~10ms/invocation CPU cap): a full `JSON.parse` of the whole feed, every 5 min, before the watchdog's
  own window filter could even run, was the dominant CPU cost. `cancellations` is kept in full
  (unwindowed — small array, only ever looked up by an id already in the watchdog's own windowed
  snapshot). **Do not point any other consumer at this file** — it's deliberately incomplete for
  everyone except the watchdog. **The `.github/workflows/fetch_schedule.yml` commit step's `git add`
  list is explicit** (not `git add -A`) — if you ever add another auto-generated output file, remember
  to add it there too, or it'll be generated on every CI run and never committed (this exact gap
  happened once here, caught before it shipped — see AP127_Docs §10, 2026-08-16).
- Hosting: CF Pages Git-integrated — push to main auto-deploys
- Local preview: `python3 -m http.server 7420 --directory /Users/nugui/flight-schedule-feed`
- Cache token format: `?v=rNN` on every `<script>` tag in `index.html` — bump all at once
- **CI (2026-06-29):** `fetch_schedule.yml` push step is race-proof — 5-attempt push loop with `git rebase -X theirs` (keeps our freshly generated data). Do NOT revert to plain `git pull --rebase`; overlapping cron/dispatcher/manual runs caused ~100 failures.
- **CI (2026-07-08):** `GH_PAT_WORKFLOW` had expired — the "Trigger CMDV2 refresh" step used plain `curl -s` with no `-f`, so it printed "dispatched" and reported job **success** even on a 401, hiding the failure for days while CMDV2 silently fell back to its own unreliable hourly cron. Now uses `curl -sf` so an auth failure fails the step loudly and trips the existing failure-issue step. See AP127_Docs §10.
- **PAT rotated to fine-grained (2026-07-09):** `GH_PAT_WORKFLOW` is now a dedicated fine-grained PAT (`ap127-cmdv2-trigger`, Actions R/W on `CMDV2` only) — not the broad stopgap token from 07-08. 1-year expiry, rotate by **2027-07-09**.
- **Ops Portal rebuilt from scratch (2026-07-10/11) — `scripts/fetch_schedule.py` fully rewritten:**
  - Old URL 404s permanently. New: `AKfycbx-8p8MWbDAeJkTBPt4Yy_6cH0azSv-5VXcrzVhIUGM6XEJRtMBQNku-WybzNlhq9zN`. Old single-shot `#sandboxFrame` → `window.flightCache` (all dates in one page load) is gone — new portal is a `google.script.run` SPA: `sandboxFrame` → nested `userHtmlFrame` → click "Timeline View" → `#gantt-date` picker → `window.G.flights` holds **one day at a time**.
  - **Field renames:** `rowIdx`→`bookingId`, `start`/`end`→`startTime`/`endTime`, `type`→`acType`, `tail`→`acReg`. New booking-id prefixes: `BK-` (normal) and `DR-` (seen ~1/8 of bookings) — both accepted.
  - **Originally believed gone for good** (checked Timeline View, Daily Schedule, and the Flight/Cancel Record submission schemas before concluding — see AP127_Docs §10): `isActual`/`realRowIdx` as distinct concepts (new model = one record per booking, `status` alone tracks lifecycle), `planDur`, `tkoff`/`ldgTime`/`airborne`/`to`/`ldg`/`inst`, `cancelReason`. All kept as always-`None` fields in the output shape for backward compat — frontend already degrades gracefully (`app-shared.js:718-727` conditionally renders only if present). **Correction:** `tkoff`/`ldgTime`/`airborne`/`to`/`ldg`/`inst` restored 2026-07-16 via `actual{}`; `cancelReason` restored 2026-07-26 via the portal RPC API (see entries below) — only `planDur`/`isActual`/`realRowIdx` genuinely remain unavailable, an intentional model change rather than a missing field.
  - **New:** status can carry `"Pending [OVERRIDE: <note>]"` — split into `status` (normalized to Pending/Completed/Canceled) + new `statusOverride` field, not yet surfaced in any view.
  - Fetches a **rolling window** (`FETCH_DAYS_BACK=7`/`FETCH_DAYS_FORWARD=10`, env-overridable) day-by-day instead of one multi-month dump; merge-with-existing-file logic (unchanged) keeps the rest of history.
  - **Upstream GAS is flaky under rapid successive date changes** (~25% of naive requests silently return stale/empty data, not an error) — `_fetch_one_date()` uses trusted `locator.fill()` (not raw `dispatchEvent`, which the app sometimes silently ignores), a minimum-wait floor + stability re-check before trusting an empty result, per-date retry (`FETCH_DATE_ATTEMPTS=3`), and a 1s pacing delay between dates. A date that still fails gets skipped (previous data kept) rather than failing the whole run — self-heals on the next 5-min cycle.
  - **Retry bug fixed:** `main_with_retry()` previously only caught `SystemExit`, so an uncaught `PlaywrightTimeoutError` (the actual cause of the 2026-07-10 18-hour outage) bypassed retries entirely on attempt 1 every time. Now catches any exception.
  - **New: schema-drift alerting.** `validate_raw_cache()` rebased against the new schema; on new/unexpected fields, statuses, or booking-id prefixes, the run still succeeds but opens a (deduped, non-blocking) `schema-drift`-labeled issue via `GITHUB_OUTPUT` → new workflow step — so the next portal change gets noticed instead of silently breaking again.
  - `scripts/backfill_history.py` is now **stale** (old URL/schema) — do not run as-is if historical backfill is ever needed again.
- **Old data frozen at the cutover (2026-07-11, per explicit request):** `data/flight_schedule.pre_migration_archive.json` holds the OLD portal's rich-schema data for every date through **2026-07-09** (`2026-04-20`..`2026-07-09`, 75 dates, 3937 flights — extracted from commit `ba51822d`, the last old-schema data commit). `2026-07-10` was NOT frozen — the old scraper's last run (06:33 UTC that day) caught it mid-day with 23 of 94 flights still `Pending`, so it's genuinely incomplete and needed the new scraper to keep tracking it to resolution (now down to 1 Pending). `scrape_window()` skips frozen dates entirely (never fetched from the new portal); `main()` re-applies the archive as a final override on the merged output regardless, so frozen dates can never drift even if the fetch window logic changes later. **Do not delete or hand-edit the archive file** — it's the only remaining copy of the pre-migration `tkoff`/`ldgTime`/`airborne`/`planDur`/`isActual`/`cancelReason` data for those 75 days.
- **`resources`/`instructors`/`leaves` restored after going empty at the portal migration (2026-07-16, two passes):** the rewritten scraper hardcoded all three to `[]` (`cache = {...}` in `main()`) — this silently broke every RESOURCES consumer downstream: **Auto Slot Finder in CMD_CTR, CMDV2 and CMDV3 found 0 slot combos for every SP** (candidate-tail list built from `RESOURCES` was empty; confirmed by injecting a roster → 815 combos instantly). **Pass 1** added `derive_resources()` (heuristic roster from flight data — kept as FALLBACK) + `#gantt-instructor` dropdown scrape (also fallback). **Pass 2 (same day) switched the primary source to the portal's internal RPC API** (`google.script.run` server functions, callable from `userHtmlFrame` via `_rpc()` — full read-only inventory in AP127_Docs §4.1): `getScheduleRegs()` = authoritative 31-tail fleet; `getStatusBoardData(today)` = per-tail `unavail`/`unavailReason` → real `isMaint` (+ new `maintReason` field); `getInstructors()` = 22 instructors with REAL `type` (`Flight Instructor` vs `Simulator Instructor` — ATHINAT H./CHAWIN K./JIRAT R./ATIDTAN P. are sim-only); **leaves RESTORED** via `getMySubmissions({studentName,batch})` (lists all ~385 Leave Requests) + `getSubmissionDetail({id})` (name/batch/startDate/endDate/duration/leaveType/reason/role) — incremental backfill keyed by submission id persisted inside `data/flight_schedule.json` `leaves[]`, capped `LEAVE_DETAIL_MAX_PER_RUN`=60/run (historical backfill ≈7 cron cycles; an upstream-EDITED leave record is not re-fetched — accepted trade-off). **NEVER call the mutating RPCs** (`submit*`/`write*`/`fix*`/`backfill*`/`ensure*`). Other read RPCs available but not yet wired: `getBatches` (incl. batch endDate), `getStudents` (defAcType + defInstr per SP), `getCurriculumLessons`, `getStudentProgressMatrixPortal({batch})`, `getSofForDate({date})` (Supervisor of Flying), `getAircraftForFlightPlan`, `getFlightPlanTemplates`.
- **Post-flight actuals RESTORED from the new portal's `actual{}` (2026-07-16):** `G.flights[n].actual` (present on Completed flights only) carries blockOff/blockOn, takeoff/landing, `tis` (airborne), numTakeoffs/numLandings, instApp, routeFrom/routeTo, flightType, remark — most of the fields the migration notes declared "gone for good". `normalize_entry()` now maps it back onto the old output names: `tkoff`←takeoff, `ldgTime`←landing, `airborne`←tis (zero-padded H:MM→HH:MM), `actualType`←actual.acType, `to`←numTakeoffs, `ldg`←numLandings, `inst`←instApp, plus NEW fields `blockOff`/`blockOn` (actual block times — no old equivalent; forwarded by generate_flight_data.py but not yet rendered anywhere). `actual` added to KNOWN_ENTRY_FIELDS + new `KNOWN_ACTUAL_FIELDS` inner-field drift check (a new field inside `actual{}` warns as `actual.<name>`). Old `actualType` semantics changed: pre-migration it held flight type (Dual/SPIC — that's now `actual.flightType`, unmapped); post-restore it holds aircraft type, consistent with post-migration top-level `type`. Not restored: `planDur` (intentional model change, not a missing field — see below for `cancelReason`, restored separately). Verified in-browser 2026-07-16: Completed-flight drawer (app-shared.js:718-735) shows ACTUAL TIMES + T/O·LDG·INST again. **Hours KPIs stay block-time `durMin`** — airborne/tis is display detail only (r43 rule).
- **`cancelReason` RESTORED (2026-07-26)** via the same portal RPC API used for leaves — Cancel Record submissions ARE readable (`getMySubmissions`/`getSubmissionDetail`; the 2026-07-11 "no read view echoes it" note predates the RPC API discovery). `_fetch_cancel_records()` backfills incrementally (`CANCEL_DETAIL_MAX_PER_RUN`=60/run, ~343 total) into a bookingId-keyed cache persisted as `cancelRecords[]` in `data/flight_schedule.json`. Also exposed wholesale as `window.FLIGHT_DATA.cancellations` (mirrors `.leaves`) by `generate_flight_data.py`. `reason` values: `Weather (WX)`, `Aircraft Trouble`, `Student Sick`, `Instructor Sick`, `Other`; `remarks` is free text (often Thai).
- **Cancelled flights were vanishing from the schedule entirely instead of showing as cancelled (found + fixed 2026-07-26, same day as the line above)** — reported by the user right after `cancelReason` landed. Root cause: the new portal's live Timeline never keeps a cancelled booking visible with `status=Canceled` — it's removed from `window.G.flights` entirely (confirmed: 201 Canceled rows across the 75 frozen pre-migration dates where the OLD portal DID keep them visible, **zero** ever returned live post-migration). `main()`'s merge (`{**existing_schedules, **new_schedules}`) replaces a date's WHOLE entry list with the fresh one, so a booking's real `start`/`end`/`tail`/etc — captured moments earlier while still Pending — was being **permanently discarded** the instant it disappeared upstream, rather than being preserved as a visible Canceled slot. Proved with git history + exact timing: bookingId `BK-MRZTU5CV` was Pending with full time-slot data across 3 consecutive scrapes on 2026-07-25, then absent 6 minutes after its Cancel Record was submitted (~07:29 UTC cancel → gone by the 07:35 UTC scrape). Fix: `recover_vanished_bookings()` (standalone, unit-tested pure function) diffs prior-vs-fresh bookingIds per re-fetched date; anything vanished (and not already Canceled) is re-inserted using its last-known full record with status forced to Canceled — so it keeps appearing on the schedule instead of vanishing. `cancelReason` attaches immediately if that booking's Cancel Record has backfilled already; otherwise it lands on a later run via the retroactive sweep (same mechanism, so a booking recovered before its Cancel Record backfills still gets the reason eventually). Verified idempotent (a recovered booking isn't re-processed on the next run) and verified live (recovered a real vanished MEETING-type booking on first run). **This means the inline `cancelReason`/`cancelRemarks` join now DOES fire regularly for post-migration dates** — via this recovery mechanism, not because the portal ever returns `status=Canceled` directly (it doesn't). The earlier "join rarely fires" note in the commit that added `cancelReason` is superseded by this fix.
- **CORRECTION, same day: the Timeline has a dedicated Canceled mode — the "portal never returns Canceled" conclusion above was wrong.** User pointed out the Timeline actually has THREE mode tabs (📅 Plan / ✅ Actual / ❌ Canceled), not the two (Plan/Actual) previously found. `#gantt-mode-canceled` (`window.G.mode='canceled'`) returns the **complete real cancelled-booking list for a date directly from the source** — full `startTime`/`endTime`/`instructor`/`acReg`/`duration`/`condition`, `status` already `"Canceled"` — ground truth, not the diff-based guess `recover_vanished_bookings()` had to make. Verified against `BK-MRZTU5CV` (the exact booking that fix reconstructed via git history): Canceled mode returns the IDENTICAL record (10:00–11:15, HS-TPV) directly. Also found 17 real cancelled bookings on 2026-07-08 and, critically, a SECOND distinct cancelled booking for AKARAVIT K.'s CSPGL 37 on 2026-07-27 (`BK-MS19IQ58`, 06:30–07:45) that the diff-based approach could never have caught — it never existed in a Pending state anyone had scraped. Fix: `scrape_window()` now does one extra full pass over the date range with mode switched to Canceled (confirmed sticky across date changes — no per-date re-click needed), reusing `_fetch_one_date()` completely unchanged (it only reads `window.G.date`/`.flights`, doesn't care what mode produced them), merged into `schedules[date]` by `bookingId`. `recover_vanished_bookings()` is demoted to a fallback (kept, cheap when idle) for if the Canceled-mode fetch itself fails. Verified live: 4 real cancelled bookings recovered with correct time slots + `cancelReason` join, zero duplicates, diff-based fallback correctly found nothing left to do.
  - **Also investigated Actual mode fully** (the user asked to check all three): confirmed it's a **pure UI filter, not a separate data source** — same-date comparison showed it returns exactly the Plan-mode `Completed` flights that already have a recorded `actual{}` block (byte-identical field values), minus any Completed flight still awaiting actual-data entry by staff (found one: `BK-AP-126-PATC-IUM05`, Completed but no `actual` key at all). No new fields, no different values, nothing to capture — the existing `actual{}` mapping in `normalize_entry()` already covers everything this mode would show.
- **"View Daily Schedule" returns ALL statuses in ONE query (2026-07-26)** — user asked directly: "there is Daily Schedule which show all kind of flight?" Confirmed: `window.SD.flights` (unlike Timeline's `window.G`, which needs mode-switching to see cancelled bookings) includes Pending + Completed + Canceled + `MEETING|Pending` together for a single date, same field shape as Timeline, `actual{}` present when recorded. Verified against 3 dates matching known counts exactly (07-27: 29 total = 24 Pending + 2 Canceled + 3 Meeting; 07-08: 61 = 40 Completed + 4 Pending + 17 Canceled; 07-16: 64 = 51 Completed + 11 Canceled + 2 Pending). **Not yet wired into the scraper** — `_fetch_one_date()` reads `window.G`, not `window.SD`; switching the core per-date fetch to Daily Schedule would let the Canceled-mode second pass be dropped entirely (one query instead of two per date). Proposed but not yet implemented — pending decision on whether to take on that refactor.
- **Comprehensive portal re-audit + automated structural-drift detection (2026-07-26)** — user: "the Ops Portal is changing frequently... we should have a way to check whether the Ops Portal is changed or not regularly." Ran a full sweep (RPC inventory, all 3 Timeline modes, Daily Schedule, Submit Forms field lists) against everything documented 10 days earlier: **19/21 checks passed clean**; the 2 non-passes were a probe-script bug (Leave Request locator collided with the Submit Forms menu's own subtitle text containing "leave request" lowercase — the real form works fine, re-verified with a precise locator) and one genuine, expected finding — **6 new RPC functions** had appeared since 2026-07-16: `checkDuplicateFlightRecord` (duplicate-submission guard, read-only), `getInstructorAvailableDates`/`getPartTimeInstructorsForAvailability` (a new part-time-instructor availability feature — 5 part-time instructors listed, but nobody's submitted any dates yet, so currently empty/unused) and 3 mutating (`fixBlankBookingIds`, `fixPendingEditRequestFingerprints`, `saveInstructorAvailableDates` — never call these). Also noted a routine new batch (`PPL-38`) in the Leave Request form's batch dropdown — expected roster growth, not drift. **Built `check_portal_structure()`** (in `fetch_schedule.py`) so this class of change gets caught automatically going forward instead of needing another manual audit: cheap checks (RPC function list, Timeline mode tabs) run every scrape; expensive checks (Submit Forms field options, Daily Schedule presence) throttled to `STRUCTURE_CHECK_INTERVAL_HOURS` (default 24h) since they need real extra navigation. Fingerprint persisted in `data/portal_fingerprint.json` (now committed by CI — see `.github/workflows/fetch_schedule.yml`'s `git add`, otherwise a fresh runner would never have a prior state to diff against). Deliberately does NOT track batch/student/instructor lists (routine growth would make it noisy). Feeds into the existing `_report_schema_drift()` GitHub-issue mechanism — same non-fatal, deduped path as data-shape drift, not a new alerting system. **Found and fixed a real bug while verifying this live**: the post-expensive-check restore-to-Timeline assumed one Back click reaches Home, but the Leave Request form is two levels deep, which broke the ENTIRE subsequent date-loop fetch on the first real test run (caught locally before ever reaching production) — `_return_to_home()` now clicks Back repeatedly until Timeline is actually reachable. Verified end-to-end: first run establishes baseline silently; unchanged runs stay silent; a simulated real drift (RPC list + Timeline modes) is correctly detected, reported once, and self-heals; the 24h throttle correctly skips and correctly fires when due, with the full pipeline (Canceled-mode fetch, date loop, merge) completing normally either way.
- **GitHub Actions runner IPs got rate-limited/blocked by the Ops Portal (found 2026-07-11, ~1h after the freeze deploy above):** 3 consecutive CI runs returned a "stable empty" result (passed `_fetch_one_date()`'s own consistency check, so not caught as a failure) for every date in the window, and the existing merge logic overwrote real populated schedules with those empty arrays — **actual data loss**, worsening each run (07-10 first, then 07-11 too). Confirmed the portal worked fine from a normal (non-Actions) network at the same moment, so this looks like Google throttling/blocking the Actions runner IP pool specifically, not a real outage. **Fix:** a regression guard in `main()`'s merge step — a date whose existing count is ≥5 but whose fresh count drops below 20% of that is treated as a suspected bad response and keeps its existing data, surfaced as a warning via the same `schema-drift` GitHub-issue mechanism. Also had to manually restore `data/flight_schedule.json` from git history (the 3 bad runs had already committed wiped data before this landed) — **watch for this again**: if `git log -- data/flight_schedule.json` ever shows a commit with a large unexplained *decrease* in total flight count, that's this failure mode, not a real schedule change. **Recurred 2026-07-16** (ongoing at time of writing): every CI run gets stable-empty responses for PAST dates in the window (07-10→07-15, sometimes the whole window) while today/future dates fetch fine; the regression guard is containing it (no data loss, warnings on issue #3), but past dates' statuses/actuals don't refresh from CI — a fetch from a normal network works fine and can backfill them manually.
- **`git rebase` inverts ours/theirs vs. a normal merge** — learned the hard way twice in one session. During `rebase`, `--ours` = the commit being rebased **onto** (usually `origin/main`'s latest auto-commit), `--theirs` = **your own** commit being replayed. This is the opposite of `git merge`. When resolving a conflict on `data/flight_schedule.json`/`flight-data.js` against a routine `chore: update flight data` auto-commit, you almost always want to keep your own (larger/more deliberate) change — that means `git checkout --theirs <file>` during a rebase, not `--ours`.

- **The Pi is shared hardware now — it also runs a CUPS AirPrint server (2026-09-03).** The Orange Pi
  Zero 2W that runs `pi-native/` also shares a USB Canon PIXMA E410 to Apple devices via CUPS. Two
  consequences for anyone working on the fetch pipeline:
  - **The board's boot config was changed.** Its USB-C data port ships as `dr_mode = "peripheral"` with
    the companion EHCI/OHCI disabled, so a custom H616 device-tree overlay was added
    (`/boot/overlay-user/usb-otg-host.dtbo`, enabled via `user_overlays=` in `/boot/dietpiEnv.txt`).
    A kernel upgrade that drops that overlay kills USB on the board silently — no error explains it.
  - **Install one package group at a time.** A single `apt-get update && apt-get install` run alongside
    the persistent headless Chromium **crash-rebooted the board** (watchdog/brownout, 1 GB RAM) and
    installed nothing; `/var/log` is RAMlog so the apt history was lost with it. This is a property of
    the board under load, not of printing.
  - Cost to this pipeline: `cupsd` idles at ~15 MB, and a rasterizing print job may briefly slow one
    scrape cycle — absorbed by the existing freshness thresholds and the ≥35 min cloud takeover.
  - Full detail (queue name, driver, device URI, admin URL) is in **AP127_Docs §5.4** — deliberately not
    repeated here, since this repo is public.

## Master reference
Full architecture, deploy steps, secrets: https://ap127-docs.pages.dev  (§2.1)
