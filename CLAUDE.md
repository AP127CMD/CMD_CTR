# CMD CTR — Claude Code Context

## ⚠️ Update rule — do this after EVERY code change
1. Bump cache token in `index.html` — next must be `r44`
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
gh workflow list -R AP127CMD/CMD_CTR --all   # fetch_schedule.yml is DISABLED as of 2026-08-26 — see below
```
**Last known:** token = `r44` (2026-08-26 — **manual-refresh tool + Orange Pi Zero 2W pivot** (scraper/
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

## Master reference
Full architecture, deploy steps, secrets: https://ap127-docs.pages.dev  (§2.1)
