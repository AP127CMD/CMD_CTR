# RPC-based schedule fetch — design

Status: approved, ready for implementation planning
Date: 2026-07-27

## Background

The CMD_CTR scraper (`scripts/fetch_schedule.py`) currently fetches the per-date flight
schedule by driving the Ops Portal's Timeline UI (`window.G`) with Playwright: fill the
`#gantt-date` input, poll until `window.G` settles on that date, then do a **second full
pass over every date** with the Timeline switched into Canceled mode (`window.G.mode
='canceled'`) to pick up cancelled bookings, which Plan mode never shows.

This is the root cause of a same-day incident chain (2026-07-27): `2026-07-31` intermittently
flip-flopped its `status` between all-Pending and all-Canceled across scrapes, with the count
staying at exactly 30 the whole time. Root cause: the Canceled-mode pass switches mode ONCE
before its whole date loop on the assumption the switch stays sticky across every date
change — never verified, and apparently false under some timing condition. When it breaks,
a stale Canceled-mode read passes every existing validation check completely undetected
(same date, same count, real bookings — just mislabeled), because nothing validated
`window.G.mode`. A same-day fix (`a13f075a7`) added a `forbidden_mode` guard that rejects
and retries a read caught in the wrong mode — confirmed correct in code, but never caught
a live rejection event in production before this redesign started (the leak is intermittent
and hard to force on demand — confirmed live: 12 consecutive date-changes across both mode
directions in a fresh audit produced zero leaks).

Downstream, the AP127_V2 Watchdog (a separate Cloudflare Worker that diffs the published
feed and sends Telegram notifications) accumulated five independent defensive patches over
the preceding weeks — `stabilizeCancelledFlights()`, an anomaly-drop guard, a
bookingId-reassignment detector, `suppressActualPairs()`, an ADDED+Canceled classification
fix — all compensating for the *same* upstream problem: the scraper's Timeline-based fetch
is structurally flaky. AP127 Telegram notifications are currently OFF as a stopgap.

## Investigation

A live audit (2026-07-27, via a local Playwright instance reusing this project's own proven
navigation helpers from `fetch_schedule.py`) found:

- **No portal structural drift** since the 2026-07-26 audit (RPC function list, Timeline mode
  tabs, Cancel Flight reasons, Leave Request types all unchanged).
- **An undocumented RPC, `getStudentSchedule({date})`,** returns the exact same per-date
  schedule as clean JSON — no DOM, no UI, no mode concept. Verified against 4 dates
  (`2026-07-08`, `2026-07-16`, `2026-07-27`, `2026-07-31`), matching known-good Daily
  Schedule counts **exactly** every time (e.g. `2026-07-08`: 61 total = 40 Completed / 17
  Canceled / 4 Pending), including the `actual{}` post-flight block on Completed entries,
  same shape as Timeline's.
- Latency: 20–27s on a "cold" (never-touched-this-session) date, 1.1–1.4s on repeats, zero
  count/status variance across 3 back-to-back repeat calls on `2026-07-31`.
- Failure mode on a bad/empty input is a **timeout or exception** (loud, catchable, retriable)
  — not a silently-wrong-but-valid-shaped result. This is the key structural win: the entire
  Timeline mode-leak bug class is a *silent* failure that passes every existing check: it
  can't happen to an RPC call the same way.
- `Daily Schedule` (`window.SD`) was also verified as a viable alternative (same accuracy),
  but has its own gotcha (`#sched-date`'s `change` event doesn't trigger a reload — requires
  directly calling the page's `loadSchedule()` JS function) and still depends on DOM/UI
  state. Decision: go directly to the RPC, skip the Daily Schedule refactor entirely.

## Decision

Replace the Timeline-based per-date fetch with `getStudentSchedule({date})` RPC calls as the
**sole** fetch mechanism. No Timeline fallback — per explicit direction, a future RPC failure
gets fixed rather than silently falling back to the flaky mechanism being removed.

## Design

### 1. Architecture / data flow

`scrape_window()`'s per-date loop changes from *open Timeline → fill date → poll `window.G`
until settled → switch to Canceled mode → repeat the whole date loop → merge* to a single
flat loop:

```
for each date in [today-DAYS_BACK, today+DAYS_FORWARD]:
    call getStudentSchedule({date}) via RPC, with retry
    normalize_entry() each returned flight (unchanged — same field shape)
```

One RPC call per date instead of two DOM passes.

**Navigation simplification (verify during implementation, not asserted):** rosters/leaves/
cancel-records already call `_rpc()` without needing Timeline open first, since
`google.script.run` is available on `userHtmlFrame` as soon as the frame loads, independent
of which UI page is showing. It's likely `_open_timeline_view()` isn't needed at all for the
schedule fetch either. Try skipping it; if `getStudentSchedule` fails when called with no
navigation, fall back to opening Timeline first (cheap, low risk either way) before
concluding it's required.

### 2. Per-date fetch mechanics

Replace `_fetch_one_date()`'s polling logic (`MIN_SETTLE_WAIT_S`, `STABILITY_RECHECK_S`,
`DATE_SETTLE_TIMEOUT_S`, `forbidden_mode`/`recovery_selector`) with a plain `_rpc()` call.
Use a generous per-call timeout — **45s**, comfortably above the worst cold-start latency
observed (27s) — reusing the existing `DATE_FETCH_ATTEMPTS` retry-with-pacing pattern. A
date that still fails after retries is skipped exactly like today: previous data for that
date is kept as-is, and it self-heals on the next 5-minute run. This part of the design is
unchanged from today's behavior.

### 3. What gets removed

Since RPC failures are loud instead of silently wrong, the defensive layers that existed
*specifically* to catch Timeline's silent failure mode become dead weight:

- `forbidden_mode`/`recovery_selector` params and the whole mode-switch guard (`a13f075a7`)
- The Canceled-mode second pass in `scrape_window()`
- `recover_vanished_bookings()` — existed as a fallback for "the Canceled-mode fetch itself
  failed for this run"; RPC returns Canceled status inline every time, so the gap it patches
  isn't reachable anymore. **Decision: remove entirely, not kept as a fallback.**
- The temporary diagnostic logging (`f1f9051a0` — `window.G.mode` print statements)
- `DATE_SETTLE_TIMEOUT_S` / `MIN_SETTLE_WAIT_S` / `STABILITY_RECHECK_S` and the `window.G`
  polling loop in `_fetch_one_date()`

**Kept as-is:**
- The regression guard (existing→fresh count sharp-drop check in `main()`) — built for
  GitHub Actions runner IPs getting throttled by the portal, an infrastructure problem
  orthogonal to which fetch mechanism is used. Still applicable to a throttled/slow RPC
  response.
- `validate_raw_cache()`'s schema-drift checks (`REQUIRED_ENTRY_FIELDS`, status values,
  bookingId format, etc.) — apply to whatever the data source is, unchanged.
- Roster/leave/cancel-record RPC fetching — already RPC-based, untouched.

### 4. RPC drift detection

Already built and already covers this with **zero new code**: `check_portal_structure()`'s
cheap fingerprint diffs the full `google.script.run` function list on every run (near-zero
cost, confirmed live as unchanged vs. the stored fingerprint) and opens a deduped GitHub
issue on any add/remove. Once `getStudentSchedule` is a real dependency, its disappearance
is automatically caught.

**One enhancement:** today, structural drift is deliberately non-fatal (warn-and-continue).
That's correct for most RPCs, but `getStudentSchedule` disappearing means every date
silently fetches nothing. Make that one specific case fatal — if `getStudentSchedule` is
missing from the RPC function list, raise instead of warning, so `main_with_retry()`'s
existing retry/failure-alerting path takes over instead of a passive GitHub issue that
might sit unread while the schedule goes stale.

### Out of scope (explicitly deferred, not part of this change)

- AP127_V2 Watchdog's defensive patches (`stabilizeCancelledFlights()`, bookingId-reassignment
  guard, anomaly-drop guard, etc.) — these exist purely to compensate for scraper flakiness
  this change eliminates, but live in a different repo/project. No evidence they cause harm
  by staying as-is. Flagged as a future cleanup candidate, not touched here.
- The Daily Schedule (`window.SD`) refactor originally proposed in the handoff — superseded
  by going directly to the RPC.

## Testing

- Unit-testable: `getStudentSchedule` RPC failure/retry/timeout handling, using the same
  mocking approach as existing `_fetch_one_date` tests (if any exist) or fresh tests around
  the new fetch function.
- `validate_raw_cache()` and the regression guard already have their own coverage —
  unaffected by the fetch-mechanism swap, no new tests needed there.
- No live Playwright test access outside of manual local runs (as done for this
  investigation) or GitHub Actions. Rollout plan: implement, run locally against the live
  portal to confirm output matches current `data/flight_schedule.json` shape and counts for
  a handful of known dates (same spot-check method used in this investigation), then deploy
  and monitor the next several CI runs before removing the pre-migration safety nets
  entirely (they're cheap to leave one extra run cycle if there's any doubt).
