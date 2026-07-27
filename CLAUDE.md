# CMD CTR — Claude Code Context

## 🔴 HANDOFF (2026-07-27, ~15:30 UTC) — read this first, then §"Last known" below for full history

**User explicitly asked to hand this investigation off to a new session — read this whole block before
touching anything.** Telegram notifications for AP127 (in AP127_V2/watchdog) are **currently turned OFF
by the user** as a stopgap — do not tell them it's safe to re-enable until you've verified stability
yourself (see "How to check current state" below). This is the live end of a same-day chain of fixes; do
not re-litigate the earlier ones (concurrency guard, regression-guard escape hatch) — they're confirmed
correct and deployed. This handoff is about the LAST, still-open piece.

**The open bug:** `2026-07-31` (currently the busiest near-future date, 30 real bookings) has been
intermittently flip-flopping its `status` between all-Pending and all-Canceled across scrapes — count
stays at exactly 30 the whole time, only `status` changes, and it changes for all 30 bookings together.
This is a genuinely different bug from the two fixed earlier today (the `fetch_schedule.yml` concurrency
race, and the regression guard's missing escape hatch) — neither of those mechanisms can produce a
same-count status flip, and both are confirmed working correctly.

**Root cause (strong evidence, not fully proven live):** `_fetch_one_date()` in `scripts/fetch_schedule.py`
validates `window.G.date` and that every returned flight matches that date, but never validated
`window.G.mode`. The Canceled-mode second pass (`scrape_window()`) switches Timeline into Canceled mode
ONCE before its whole date loop, on a documented-but-never-verified assumption that the switch "stays
sticky across date changes... no per-date re-click needed." If that assumption breaks for even one date —
plausibly the busiest one, likely the slowest to settle — a stale Canceled-mode read for that date passes
the existing date/flights check completely undetected, since Canceled mode returns the SAME real bookings
for that date, just all re-labeled Canceled by that view. That exactly matches the observed symptom.

**What's been done about it (commits, newest first, all pushed to `main`):**
- `f1f9051a0` — **temporary diagnostic logging** (still live). Prints `window.G.mode` on every accepted
  Plan-mode read and a message whenever the guard rejects a leaked-mode read. **Remove this once the fix
  is confirmed stable** — it adds ~10-90 extra log lines per run.
- `a13f075a7` — **the actual fix**: `_fetch_one_date()` gained `forbidden_mode`/`recovery_selector`
  params. The Plan-mode pass now rejects (and retries, re-clicking `#gantt-mode-plan`) any read caught
  still in Canceled mode instead of trusting it. The Canceled-mode pass is deliberately left unguarded —
  a stray Plan-mode leak there is harmless (the merge step only keeps entries not already in that date's
  Plan-mode schedule, so it just gets filtered out). Verified with a standalone Python simulation of the
  retry control-flow (no live Playwright access) — NOT yet verified against a real triggering event live.
- Confirmed via run `30279156647`'s logs: `window.G.mode` really is the right property, and `'plan'` is a
  real observed value (`2026-07-31: accepted read, window.G.mode='plan'`) — the property-name hypothesis
  is now directly confirmed, not just circumstantial.
- **Not yet confirmed:** whether the fix actually *catches* a leak when one happens — no rejection has
  been logged yet in any post-fix run. Two consecutive post-fix reads of `2026-07-31` came back Pending
  (clean), which is encouraging but not proof — the bug is intermittent and a clean run doesn't rule it
  out recurring.

**How to check current state (run these before doing anything else):**
```bash
# Is it still flapping? Pull latest and check 2026-07-31's status + count.
cd /Users/nugui/flight-schedule-feed && git pull --rebase -q
python3 -c "
import json
from collections import Counter
t = open('flight-data.js', encoding='utf-8').read()
i = t.index('window.FLIGHT_DATA =')
s = t[i+len('window.FLIGHT_DATA ='):].strip().rstrip(';')
d = json.loads(s)
jul31 = [f for f in d['flights'] if f['date']=='2026-07-31']
print('count=', len(jul31), 'status=', dict(Counter(f['status'] for f in jul31)), 'fetchedAt=', d.get('fetchedAt'))
"
# Has the guard ever actually caught a leak? (look for "rejected a read still in")
gh api "repos/AP127CMD/CMD_CTR/actions/workflows/fetch_schedule.yml/runs?per_page=10" \
  -q '.workflow_runs[] | select(.conclusion=="success") | "\(.id) \(.run_started_at)"' | \
  while read id ts; do gh run view "$id" --repo AP127CMD/CMD_CTR --log 2>&1 | grep -H "rejected a read still in\|2026-07-31: accepted" | sed "s/^/$ts: /"; done
```
If several consecutive runs show `status={'Pending': 30}` AND you've seen at least one real
"rejected a read still in 'canceled' mode" log line (proving the guard caught a genuine leak and
corrected it), the patch is confirmed working — safe to tell the user they can re-enable notifications,
and worth removing the temporary diagnostic logging (`f1f9051a0`) at that point.

**The proposed next step, NOT YET STARTED — user's own idea, already validated by prior investigation:**
Switch the core per-date fetch from Timeline (`window.G`, needs mode-switching) to Daily Schedule
(`window.SD`) instead. This was independently investigated and confirmed viable the day before all of
today's incidents — see the `ee5d829df` commit / CLAUDE.md's "Last known" history below: `window.SD.flights`
returns Pending + Completed + Canceled + Meeting **together in one query per date**, same field shape as
Timeline, verified against 3 real dates matching known counts exactly. It was flagged as "not yet wired
into the scraper... pending decision on whether to take on that refactor" — that refactor was never done.

Doing this would eliminate the ENTIRE mode-switching bug class structurally (no second mode to leak from,
since there's no Canceled-mode pass needed at all), AND roughly halve every run's duration (one query per
date instead of two), which also reduces exposure to the original concurrency-race class of issue.

**Scope/risk if you take this on:** `_fetch_one_date()`'s Daily Schedule equivalent doesn't exist yet —
only a lightweight presence check (`#sched-date` exists) was ever built, never real per-date fetching. You
cannot test against the live Playwright/Ops Portal session directly (no such access) — a wrong selector
or wrong settling assumption could break EVERY date's fetch, not just one, which is a worse failure mode
than the current bug. **Recommended approach discussed with the user but not yet approved in detail:**
implement the Daily Schedule fetch as primary, with automatic fallback to the existing Timeline-based
fetch per-date if the Daily Schedule read fails for that date — don't delete the Timeline path outright.
Confirm this approach (or your own risk-mitigation plan) with the user before implementing, given the
blast radius if something goes wrong.

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
```
**Last known:** token = `r44` (2026-07-27 — **regression guard given an escape hatch + a stuck date manually
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
- React 18 CDN UMD + Babel Standalone — no build step; `<script type="text/babel">`
- `flight-data.js` is AUTO-GENERATED by GHA cron — **never edit manually**
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
