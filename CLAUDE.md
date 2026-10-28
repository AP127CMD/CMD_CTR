# CMD CTR — Claude Code Context

@~/AP127_Docs/claude/ap127-ecosystem.md

> Keep ≤ 200 lines; state only what is true now and edit lines in place. Dated notes / per-version
> write-ups go to `docs/NOTES.md` (and AP127_Docs §10) — never here.

## What this project is
Real-time flight-schedule dashboard. 8 views: Day Glance · Board · Gantt · Weekly · Analytics · Roster · Slot Finder · Auto Slot Finder.
GitHub: `AP127CMD/CMD_CTR` | Live: https://ap127-cmd-ctr.pages.dev | Local: `/Users/nugui/flight-schedule-feed/`

## Current state
- Browser cache token `?v=r47` (2026-09-24). Next bump: **r48**. Per-version history: `docs/NOTES.md`.

## ⚠️ Update rule — do this after EVERY code change
1. Bump cache token in `index.html` — next must be `r48`
2. Update the **Current state** line above (token + one-line summary), in place; any longer write-up goes in `docs/NOTES.md`
3. Update `/Users/nugui/AP127_Docs/README.md` §2.1 (add to §10 log) — then push AP127_Docs
4. `git add . && git commit -m "rNN: <what changed>" && git pull --rebase && git push`


## Verify actual state — run before starting
```bash
grep -o '?v=r[0-9]*' index.html | sort -u
git log --oneline | grep -v "chore: update flight data" | head -6
gh workflow list -R AP127CMD/CMD_CTR --all   # fetch_schedule.yml is ENABLED again as of 2026-08-29 (was disabled 2026-08-26) — see below

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
- **Phase 2 (2026-09-06, partially reverted 2026-09-07):** the per-date `getStudentSchedule`
  loop runs `FETCH_RPC_CONCURRENCY` dates at once — `_gather_dates_bounded()` + a FIFO
  semaphore; `=1` is exact serial. **This parallel scrape is KEPT** (the real speedup, ~12 min →
  ~6 min serial-equivalent). The Pi `.env` now sets it to **2** (was 4).
  **The paired 3-min timer was REVERTED to 5-min** and `STANDBY_MAX_AGE_MIN` default back to
  **6** (was 3), on 2026-09-07 after the Pi **hard-hung** (board powered but 100% unresponsive —
  no SSH/ping/network — for ~17 h) about 4 h into the 3-min cadence. No crash logs survived
  (no RTC, RAMlog wiped on the power-cycle); circumstantial read is an OOM/lockout from
  memory-spike *frequency* on a 1 GB board also running CUPS, not the parallelism itself.
  **Cloud fallback covered the whole outage** — the dispatcher's `STALE_TAKEOVER_MIN=35` kept
  `github-actions[bot]` refreshing the feed every ~40 min (max gap 44 min, 0 gaps >60 min, so
  the 60-min Telegram-staleness page never tripped).
  Effective cadence now: parallel scrape at a 5-min timer ≈ a fetch every ~6–8 min.
  A [claude.ai cloud routine](https://claude.ai/code/routines) `trig_0166opottzeQnRm8nzKMzxXC`
  watches Pi commit cadence + fetch issues every 2 h.

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



## Readiness Planner Worker (2026-10-03)
`readiness-worker/` is the Cloudflare Worker `ap127-readiness` (https://ap127-readiness.anusorn-tanmetha.workers.dev, KV `READINESS_KV`). It relays between the owner's **private** Garmin FR570 Readiness Planner watch app and the Pi job (`pi-native/readiness/`) — it is **not** an AP127 dashboard and nothing in the dashboards reads it.
- Routes: `PUT /plan` (PI_KEY) · `GET /plan` (WATCH_KEY) · `POST /apply` (WATCH_KEY) · `GET /apply/pending` (PI_KEY) · `POST /apply/result` (PI_KEY). Auth via `X-Key` header.
- Keys: `~/.ap127-readiness/{pi,watch}.key` (Mac), never in git; Worker secrets `PI_KEY`, `WATCH_KEY`.
- Test `cd readiness-worker && npm test` (30 tests) · deploy `npx wrangler deploy`. Apply queue uses `kv.list` (eventually consistent, ~60 s lag).
- **Pi job (live 2026-10-04):** `ap127-readiness.timer` (07/22/37/52) -> `ap127-readiness.service`, user `dietpi`, Nice 10, MemoryMax 150M (measured peak ~83 MB), dry_run=true. Garmin tokens `/home/dietpi/.garminconnect` (700). Sign in: `ssh -t root@DietPi.local 'cd /home/dietpi/flight-schedule-feed/pi-native/readiness && sudo -u dietpi -H .venv/bin/python -m readiness login'`. Verify: `ssh root@DietPi.local 'journalctl -u ap127-readiness -n 5 --no-pager'` shows `published NNNN B (HTTP 204)`; `curl -H "X-Key: $(cat ~/.ap127-readiness/watch.key)" https://ap127-readiness.anusorn-tanmetha.workers.dev/plan`. Dry print: `systemd-run --wait --collect --pipe -p User=dietpi -p WorkingDirectory=<dir> .venv/bin/python -m readiness --print` (no /usr/bin/time on DietPi).

## Key facts
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
- **Print priority + one-heavy-job-at-a-time (2026-10-20).** While a CUPS render runs, `ap127-printprio` freezes the
  fetch/readiness/repack cgroups (`cgroup.freeze` written directly — **`systemctl freeze` silently fails on a starting
  oneshot unit**, i.e. a running fetch) and thaws 6 s after; fetch, readiness and git repack take turns on
  `/run/lock/ap127-heavy.lock`. CUPS has a hard `MemoryMax=450M` + `MemorySwapMax=250M` and **no `MemoryHigh`** (a
  throttle livelocked a 48 MP job). Measured: 48 MP page 310 MB/26 s; 94 MB 8-page PDF 434 MB/3.5 min — PDF *file size*
  drives memory, not megapixels or page count; ~17-27 s CPU per page. Install: `sudo bash pi-native/printprio/install.sh`.
  Event log: `/var/log/ap127-printprio.log`. The Telegram watchdog is a Cloudflare Worker, not Pi load. AP127_Docs §5.5.2.
  **Detection gotcha (found 2026-10-20):** cupsd launches filters with `argv[0]` = the printer name, so match by
  process NAME (`pgrep -x 'pdftopdf|gstoraster|pdftoraster|mupdftoraster|rastertogutenpr|gs'`), never by the
  `/usr/lib/cups/filter/...` path — in `ap127-printprio.sh` and the `run_fetch.sh` guard. Filters DO run inside
  `cups.service`'s cgroup (limits apply); sample while a job is running, not idle. Verified with a real `lp` job.
- **The Pi's 2026-10-19 lockups were `git gc --auto`, not printing (2026-10-20).** 8,613 loose objects (1.57 GB,
  `.git` 1.7 GB) → auto-gc inside each fetch's `git pull` peaked 430-536 MB on top of Chromium, filled zram
  swap, and locked the board (retried every 5-min cycle). Fixed: `gc.auto=0` + bounded `pack.*` on the Pi's
  clone, nightly capped repack (`pi-native/maintenance/`), fresh 99 MB clone (build it on the Mac — `index-pack`
  on the Pi is CPU-bound 10+ min), hardware watchdog armed (16 s max — longer is silently rejected;
  `pi-native/system/`), `run_fetch.sh` skips a cycle during a print render/repack and clears stale `.git`
  locks. **Do not let a data-bloated clone's loose objects pile up again; do not re-enable `gc.auto` on the
  Pi.** Full detail: AP127_Docs §5.5.1.
- **The Pi's journal is on the SD card, size-capped** (`pi-native/system/`: `var-log-journal.mount` bind-mounts
  `/var/lib/ap127-journal` over `/var/log/journal`; `journald-persist.conf`: 48 MB cap, 30 s sync). DietPi's RAMlog
  makes `/var/log` a 50 MB tmpfs, so `Storage=persistent` alone is still RAM and a hang/reset leaves no evidence.
  After a hang: `ssh root@DietPi.local journalctl -b -1` (clock reads stale for the first minutes of a boot — no RTC —
  so trust order, not timestamps). Don't order this mount after `dietpi-ramlog.service` (dependency cycle).
- **`run_fetch.sh` now sends a heartbeat, unconditionally, on every timer firing (2026-09-12).** Found
  live: the Pi went hard-down for ~1h49m with nothing noticing, because the cloud fallback above kept
  the feed fresh throughout — masking "Pi dead" as identical to "Pi correctly standing by." A `POST` to
  `ap127-watchdog-monitor`'s `/pi-heartbeat` (needs `PI_HEARTBEAT_KEY` in `pi-native/.env`) now fires
  regardless of whether that cycle fetches or skips — a gap means the systemd timer itself stopped.
  Full detail (detector logic, KV write-rate-gating, live verification): **AP127_Docs §6.9** +
  `AP127_V2/CLAUDE.md`'s 2026-09-12 watchdog-monitor entry.

## Where history lives
- `docs/NOTES.md` — the 2026-10-04 Pi-scraper incident, the full per-version "Last known" history, and the
  July 2026 Ops-Portal-migration notes, moved verbatim out of this file on 2026-10-24. Code comments that say
  "see CLAUDE.md" for an incident now mean `docs/NOTES.md`.
- AP127_Docs §2.1 and §10 — master reference + incident log: https://ap127-docs.pages.dev
