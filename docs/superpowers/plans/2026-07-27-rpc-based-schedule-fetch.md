# RPC-based Schedule Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CMD_CTR's Timeline-based (mode-switching) per-date schedule fetch with the `getStudentSchedule({date})` RPC, eliminating the bug class that caused the 2026-07-31 status flip-flop, and add a fatal check so the pipeline stops loudly (instead of silently fetching nothing) if that RPC ever disappears from the portal.

**Architecture:** `scripts/fetch_schedule.py`'s `scrape_window()` currently does two full Playwright passes over every date (Plan mode, then Canceled mode) via `window.G` DOM polling. This plan replaces both with one RPC call per date (`getStudentSchedule`), deletes the now-dead Timeline mode-switching machinery, and adds a fatal guard in `check_portal_structure()` for the one RPC the pipeline now structurally depends on. Roster/leave/cancel-record fetching (already RPC-based) is untouched.

**Tech Stack:** Python 3.11, Playwright (`playwright.async_api`), pytest + pytest-asyncio for new unit tests.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-rpc-based-schedule-fetch-design.md` — read it before starting; every task below implements a specific section of it.
- No Timeline fallback for the schedule fetch. If `getStudentSchedule` breaks in production, that's a bug to fix, not a case to silently degrade around (explicit user direction).
- `recover_vanished_bookings()` is removed entirely, not kept as a fallback (explicit user direction — approved 2026-07-27).
- Watchdog (`AP127_V2/watchdog`) code is explicitly OUT OF SCOPE — do not modify `AP127_V2/watchdog/src/*`. Only `AP127_V2/CLAUDE.md` (documentation) is touched, in Task 7.
- This is a scraper/data-pipeline-only change — it touches no browser-cached asset (`index.html`, no `js/*.js`). Per this repo's own established precedent (see `CLAUDE.md`'s "2026-07-16... scraper-only — token not bumped, per the b8e0544c precedent"), do **not** bump the `?v=rNN` cache token.
- `flight-schedule-feed` and `AP127_V2` are live production repos (CF Pages Git-integrated deploy / manually-deployed Worker respectively) serving a real flight school. Per this plan's final task, commits happen locally throughout — **do not `git push` `flight-schedule-feed` or `AP127_V2` until the final task explicitly confirms with the user.** `AP127_Docs` is documentation-only (no deploy-triggered behavior change) and follows its own established push-on-every-change convention — push it directly in Task 8 as that repo's CLAUDE.md already directs.
- All new Python code needs a one-line comment only where the WHY is non-obvious (project convention — see existing `fetch_schedule.py`). Don't add multi-line docstring essays to small new helpers; match the terseness of `_null_dash`/`_int_or_none`-style helpers already in the file, not the long investigative docstrings on functions like `normalize_entry()` (those document historical incidents, not a pattern to repeat for new code).
- The design spec floated skipping `_open_timeline_view()` entirely before the RPC date loop, since roster/leave/cancel-record RPCs already work without it — flagged there as "verify during implementation, not asserted." This plan deliberately does NOT attempt that: it's an unverified optimization with no test coverage possible without a live portal hit per attempt, and "reliable is key" makes the proven-safe option (keep the existing `_open_timeline_view()` call, unchanged) the right call over an unverified speed optimization. Task 3 keeps it as-is; nothing in this plan removes it.

---

## Task 1: Test scaffold + failing tests for the RPC-based per-date fetch

**Files:**
- Create: `requirements-dev.txt`
- Create: `scripts/conftest.py`
- Create: `scripts/tests/test_fetch_schedule.py`

**Interfaces:**
- Produces: `FakeUserFrame` test double (in `scripts/tests/test_fetch_schedule.py`) — later tasks' tests reuse it. Constructor: `FakeUserFrame(responses: dict[str, Any])` where a value that's a `BaseException` instance simulates an RPC error (`{"__err": str(exc)}`), anything else simulates success (`{"__ok": value}`). Records calls in `self.calls: list[tuple[fn, args, timeout_s]]`.
- Consumes (from existing code, unchanged): `fetch_schedule._rpc(user_frame, fn, *args, timeout_s=45)` at `scripts/fetch_schedule.py:565`, which calls `await user_frame.evaluate(_RPC_JS, [fn, list(args), timeout_s])`.

This repo has zero existing tests — this task creates the whole scaffold, matching this project's own file-per-responsibility convention.

- [ ] **Step 1: Create `requirements-dev.txt`**

```
pytest>=8.0.0
pytest-asyncio>=0.24.0
```

- [ ] **Step 2: Create `scripts/conftest.py` so `scripts/tests/*` can `import fetch_schedule`**

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
```

- [ ] **Step 3: Create `scripts/tests/__init__.py` (empty file, makes the directory a package for clean collection)**

```python
```

- [ ] **Step 4: Create `pytest.ini` at the repo root**

```ini
[pytest]
asyncio_mode = auto
```

- [ ] **Step 5: Write the failing tests in `scripts/tests/test_fetch_schedule.py`**

```python
import fetch_schedule as fs
import pytest


class FakeUserFrame:
    """Stand-in for a Playwright Frame — only implements what _rpc() calls
    (evaluate). A response value that's a BaseException simulates an RPC
    error; anything else simulates a successful result."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    async def evaluate(self, js_string, arg):
        fn, call_args, timeout_s = arg
        self.calls.append((fn, call_args, timeout_s))
        if fn not in self.responses:
            raise AssertionError(f"unexpected RPC call: {fn!r}")
        result = self.responses[fn]
        if isinstance(result, BaseException):
            return {"__err": str(result)}
        return {"__ok": result}


async def test_fetch_schedule_for_date_returns_flights():
    frame = FakeUserFrame({"getStudentSchedule": [
        {"date": "2026-07-31", "bookingId": "BK-1", "status": "Pending"},
        {"date": "2026-07-31", "bookingId": "BK-2", "status": "Canceled"},
    ]})
    flights = await fs._fetch_schedule_for_date(frame, "2026-07-31")
    assert len(flights) == 2
    assert flights[0]["bookingId"] == "BK-1"
    assert flights[1]["status"] == "Canceled"


async def test_fetch_schedule_for_date_allows_empty():
    frame = FakeUserFrame({"getStudentSchedule": []})
    flights = await fs._fetch_schedule_for_date(frame, "2026-07-31")
    assert flights == []


async def test_fetch_schedule_for_date_rejects_mismatched_date():
    frame = FakeUserFrame({"getStudentSchedule": [
        {"date": "2026-08-01", "bookingId": "BK-9", "status": "Pending"},
    ]})
    with pytest.raises(ValueError):
        await fs._fetch_schedule_for_date(frame, "2026-07-31")


async def test_fetch_schedule_for_date_propagates_rpc_error():
    frame = FakeUserFrame({"getStudentSchedule": RuntimeError("timeout 45s")})
    with pytest.raises(RuntimeError):
        await fs._fetch_schedule_for_date(frame, "2026-07-31")


async def test_fetch_schedule_for_date_passes_date_and_timeout():
    frame = FakeUserFrame({"getStudentSchedule": []})
    await fs._fetch_schedule_for_date(frame, "2026-07-31", timeout_s=60)
    fn, call_args, timeout_s = frame.calls[0]
    assert fn == "getStudentSchedule"
    assert call_args == [{"date": "2026-07-31"}]
    assert timeout_s == 60
```

- [ ] **Step 6: Install dependencies and run the tests to verify they fail**

```bash
cd /Users/nugui/flight-schedule-feed
python3 -m pip install -r requirements.txt -r requirements-dev.txt
python3 -m pytest scripts/tests/test_fetch_schedule.py -v
```

Expected: every test in the file FAILS with `AttributeError: module 'fetch_schedule' has no attribute '_fetch_schedule_for_date'` — the function doesn't exist yet.

- [ ] **Step 7: Commit**

```bash
git add requirements-dev.txt pytest.ini scripts/conftest.py scripts/tests/__init__.py scripts/tests/test_fetch_schedule.py
git commit -m "test: add failing tests for RPC-based per-date schedule fetch"
```

---

## Task 2: Implement `_fetch_schedule_for_date()`

**Files:**
- Modify: `scripts/fetch_schedule.py` (insert after `_rpc()`, which ends at line 570)

**Interfaces:**
- Consumes: `_rpc(user_frame, fn, *args, timeout_s=45)` (existing, unchanged).
- Produces: `_fetch_schedule_for_date(user_frame, date_str, timeout_s=None) -> list[dict]` (async) — used by Task 3. `RPC_FETCH_TIMEOUT_S` module constant, env-overridable.

- [ ] **Step 1: Insert the new constant and function immediately after `_rpc()` (currently ends at line 570, right before `async def _fetch_rosters` at line 573)**

Find this exact block in `scripts/fetch_schedule.py`:

```python
async def _rpc(user_frame, fn, *args, timeout_s=45):
    """Call a portal server function; raises on failure/timeout."""
    res = await user_frame.evaluate(_RPC_JS, [fn, list(args), timeout_s])
    if not isinstance(res, dict) or "__err" in res:
        raise RuntimeError(f"{fn} RPC failed: {(res or {}).get('__err', res)}")
    return res.get("__ok")


async def _fetch_rosters(user_frame, today_iso):
```

Replace it with:

```python
async def _rpc(user_frame, fn, *args, timeout_s=45):
    """Call a portal server function; raises on failure/timeout."""
    res = await user_frame.evaluate(_RPC_JS, [fn, list(args), timeout_s])
    if not isinstance(res, dict) or "__err" in res:
        raise RuntimeError(f"{fn} RPC failed: {(res or {}).get('__err', res)}")
    return res.get("__ok")


# 2026-07-27: primary schedule fetch, replacing the Timeline (window.G) DOM
# approach entirely — see docs/superpowers/specs/2026-07-27-rpc-based-schedule-
# fetch-design.md. getStudentSchedule({date}) returns Pending/Completed/
# Canceled/Meeting for a date in one clean JSON response (no mode-switching,
# no DOM settling races), confirmed live to match Daily Schedule/Timeline
# counts exactly across 4 known dates including the actual{} post-flight
# block. Cold (never-touched-this-session) dates observed up to ~27s;
# repeats ~1-1.5s — timeout is set well above the worst cold case.
RPC_FETCH_TIMEOUT_S = int(os.environ.get("FETCH_RPC_TIMEOUT_S", "45"))


async def _fetch_schedule_for_date(user_frame, date_str, timeout_s=None):
    """Fetch one date's full schedule via getStudentSchedule. Raises (loud,
    retriable by the caller) on RPC failure/timeout, or if a returned entry's
    date doesn't match date_str — a wrong-date response would otherwise look
    like valid data and merge silently wrong, the same class of risk the old
    Timeline mode-leak had."""
    flights = await _rpc(user_frame, "getStudentSchedule", {"date": date_str},
                          timeout_s=timeout_s or RPC_FETCH_TIMEOUT_S)
    flights = flights or []
    bad_dates = {f.get("date") for f in flights} - {date_str}
    if bad_dates:
        raise ValueError(
            f"getStudentSchedule({date_str!r}) returned mismatched date(s): {sorted(bad_dates)!r}"
        )
    return flights


async def _fetch_rosters(user_frame, today_iso):
```

- [ ] **Step 2: Run the Task 1 tests to verify they now pass**

```bash
cd /Users/nugui/flight-schedule-feed
python3 -m pytest scripts/tests/test_fetch_schedule.py -v
```

Expected: all 5 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/fetch_schedule.py
git commit -m "feat: add _fetch_schedule_for_date() using the getStudentSchedule RPC"
```

---

## Task 3: Wire the RPC fetch into `scrape_window()`; delete the Timeline mode-switching machinery

**Files:**
- Modify: `scripts/fetch_schedule.py`

**Interfaces:**
- Consumes: `_fetch_schedule_for_date()` from Task 2.
- Removes: `_fetch_one_date()`, `recover_vanished_bookings()`, `DATE_SETTLE_TIMEOUT_S`, `MIN_SETTLE_WAIT_S`, `STABILITY_RECHECK_S`, the Canceled-mode second pass in `scrape_window()`, the `recover_vanished_bookings()` call site in `main()`.

This task is mechanical (swap + delete); no new automated tests, but includes explicit verification steps.

- [ ] **Step 1: Delete the `DATE_SETTLE_TIMEOUT_S` constant**

Find (near the top of the file, in the module-level constants block):

```python
DATE_SETTLE_TIMEOUT_S = 25  # observed per-date server round-trip: 1.5-12s, be generous
```

Delete this line entirely.

- [ ] **Step 2: Delete `recover_vanished_bookings()` entirely**

Find the function starting with:

```python
def recover_vanished_bookings(new_schedules, existing_schedules, cancel_lookup):
```

Delete the entire function, from its `def` line through its final `return recovered` line and the two blank lines after it, up to (but not including) `async def _get_content_frame(page):`.

- [ ] **Step 3: Delete `_fetch_one_date()` entirely, and the two constants only it uses**

Find this block:

```python
DATE_FETCH_ATTEMPTS = int(os.environ.get("FETCH_DATE_ATTEMPTS", "3"))


MIN_SETTLE_WAIT_S = 3   # a result (esp. an empty one) landing before this is
                        # almost certainly a stale-clear artifact, not real data
STABILITY_RECHECK_S = 2  # re-verify an apparently-settled EMPTY result is real,
                          # not the brief clear-state before the async reply lands


async def _fetch_one_date(page, user_frame, date_str, forbidden_mode=None, recovery_selector=None):
    """Set the Gantt date picker and wait for window.G to settle on that date.
    ...
    """
    date_input = user_frame.locator("#gantt-date")
    await date_input.fill(date_str)
    await date_input.dispatch_event("change")
    await page.wait_for_timeout(MIN_SETTLE_WAIT_S * 1000)

    for _ in range(DATE_SETTLE_TIMEOUT_S):
        g = await user_frame.evaluate("() => JSON.stringify(window.G)")
        data = json.loads(g)
        if forbidden_mode is not None and data.get("mode") == forbidden_mode:
            print(f"  {date_str}: rejected a read still in '{forbidden_mode}' mode — "
                  f"retrying{' (re-asserting mode)' if recovery_selector else ''}", file=sys.stderr)
            if recovery_selector:
                try:
                    await user_frame.locator(recovery_selector).click(timeout=5000)
                except Exception:
                    pass
            await page.wait_for_timeout(1000)
            continue
        if data.get("date") == date_str:
            flights = data.get("flights", [])
            flight_dates = {f["date"] for f in flights}
            if flight_dates <= {date_str}:
                if flights:
                    if forbidden_mode is not None:
                        # Diagnostic (2026-07-27, temporary): confirms window.G.mode is really the
                        # right property/values to guard on — remove once the fix is confirmed live.
                        print(f"  {date_str}: accepted read, window.G.mode={data.get('mode')!r}",
                              file=sys.stderr)
                    return flights
                # Empty — could be genuine or a not-yet-loaded artifact.
                # Re-check after a short pause; only trust it if it's stable.
                await page.wait_for_timeout(STABILITY_RECHECK_S * 1000)
                g2 = await user_frame.evaluate("() => JSON.stringify(window.G)")
                data2 = json.loads(g2)
                if data2.get("date") == date_str and not data2.get("flights"):
                    return []
                # It changed — loop again and re-evaluate from scratch.
                continue
        await page.wait_for_timeout(1000)
    raise TimeoutError(f"Ops Portal did not settle on date {date_str} within {DATE_SETTLE_TIMEOUT_S}s")


def _load_frozen_archive():
```

Replace it with:

```python
DATE_FETCH_ATTEMPTS = int(os.environ.get("FETCH_DATE_ATTEMPTS", "3"))


def _load_frozen_archive():
```

(This keeps `DATE_FETCH_ATTEMPTS` — still used by `scrape_window()`'s retry loop in Step 5 below — and removes everything Timeline-DOM-specific.)

- [ ] **Step 4: Delete the Canceled-mode second pass in `scrape_window()`**

Find this block (the whole `# ── Canceled mode: ground-truth cancelled-booking data ──` section, immediately after the main date loop's closing and before `finally:`):

```python
            # ── Canceled mode: ground-truth cancelled-booking data ──────────
            # Found 2026-07-26 (same day as the diff-based recover_vanished_
            # bookings() fix above): the Timeline has a THIRD mode tab, "❌
            # Canceled" (#gantt-mode-canceled, window.G.mode='canceled'), that
            # nobody on this project had ever clicked before. It returns the
            # complete, real cancelled-booking list for a date — full
            # startTime/endTime/instructor/acReg/duration/condition, status
            # already "Canceled" — not inferred from a vanished booking's
            # last-known state. Verified against BK-MRZTU5CV (the exact
            # booking recover_vanished_bookings() had reconstructed via git
            # history): Canceled mode returns the IDENTICAL real record
            # (10:00-11:15, HS-TPV) directly, no diffing needed. Also
            # confirmed on 2026-07-08 (17 real cancelled bookings) and
            # 2026-07-27 (2, including one recover_vanished_bookings() never
            # even had a chance to see). Earlier "the portal never returns
            # Canceled status" conclusion was simply wrong — Plan mode never
            # does, but this dedicated mode always did.
            #
            # Reuses _fetch_one_date() — one extra full pass over the same date list, mode switched
            # once beforehand. That switch WAS assumed sticky across every date change in this loop
            # with no per-date re-click needed — wrong (2026-07-27): see _fetch_one_date()'s
            # forbidden_mode docstring for the confirmed live failure this assumption caused on the
            # OTHER (Plan-mode) pass. Left unguarded here on purpose, not an oversight: a stray
            # Plan-mode read leaking into THIS pass is harmless — the merge below only keeps entries
            # whose bookingId ISN'T already in that date's Plan-mode schedule, so a Plan-mode leak
            # just re-reads data the Plan-mode pass already has and gets filtered out as not "fresh".
            try:
                await user_frame.locator("#gantt-mode-canceled").click(timeout=15_000)
            except Exception as exc:
                print(f"WARNING: could not switch to Canceled mode ({exc}) — "
                      f"cancelled-booking recovery falls back to diff-based reconstruction only",
                      file=sys.stderr)
            else:
                canceled_total = 0
                for date_str in dates:
                    last_err = None
                    canceled_flights = None
                    for attempt in range(1, DATE_FETCH_ATTEMPTS + 1):
                        try:
                            canceled_flights = await _fetch_one_date(page, user_frame, date_str)
                            break
                        except Exception as exc:
                            last_err = exc
                            await page.wait_for_timeout(1500)
                    if canceled_flights is None:
                        print(f"  {date_str}: Canceled-mode fetch FAILED after {DATE_FETCH_ATTEMPTS} "
                              f"attempts ({last_err!r}) — recover_vanished_bookings() fallback still applies",
                              file=sys.stderr)
                        await page.wait_for_timeout(1000)
                        continue
                    if canceled_flights:
                        existing_ids = {e.get("bookingId") for e in schedules.get(date_str, [])}
                        fresh = [f for f in canceled_flights if f.get("bookingId") not in existing_ids]
                        if fresh:
                            schedules.setdefault(date_str, []).extend(fresh)
                            canceled_total += len(fresh)
                    await page.wait_for_timeout(1000)
                print(f"Canceled mode: {canceled_total} real cancelled booking(s) across {len(dates)} date(s).")
        finally:
            await browser.close()
```

Replace it with just:

```python
        finally:
            await browser.close()
```

(`getStudentSchedule` already returns Canceled bookings inline for each date — no second pass needed.)

- [ ] **Step 5: Replace the main date-loop's inner fetch call**

Find this block inside `scrape_window()`:

```python
            for date_str in dates:
                last_err = None
                for attempt in range(1, DATE_FETCH_ATTEMPTS + 1):
                    try:
                        # forbidden_mode="canceled": this is the Plan-mode pass — reject and retry
                        # any read caught still in Canceled mode instead of trusting it (see
                        # _fetch_one_date()'s docstring — 2026-07-27 fix for a leaked-mode read).
                        flights = await _fetch_one_date(page, user_frame, date_str,
                                                          forbidden_mode="canceled",
                                                          recovery_selector="#gantt-mode-plan")
                        schedules[date_str] = flights
                        print(f"  {date_str}: {len(flights)} flights"
                              + (f" (attempt {attempt})" if attempt > 1 else ""))
                        break
                    except Exception as exc:
                        last_err = exc
                        await page.wait_for_timeout(1500)
                else:
                    print(f"  {date_str}: FAILED after {DATE_FETCH_ATTEMPTS} attempts ({last_err!r}) — skipping",
                          file=sys.stderr)
                    failed_dates.append(date_str)
                # Brief pacing between dates — the upstream GAS server seems to
                # degrade (silently empty responses) under back-to-back requests.
                await page.wait_for_timeout(1000)
```

Replace it with:

```python
            for date_str in dates:
                last_err = None
                for attempt in range(1, DATE_FETCH_ATTEMPTS + 1):
                    try:
                        flights = await _fetch_schedule_for_date(user_frame, date_str)
                        schedules[date_str] = flights
                        print(f"  {date_str}: {len(flights)} flights"
                              + (f" (attempt {attempt})" if attempt > 1 else ""))
                        break
                    except Exception as exc:
                        last_err = exc
                        await page.wait_for_timeout(1500)
                else:
                    print(f"  {date_str}: FAILED after {DATE_FETCH_ATTEMPTS} attempts ({last_err!r}) — skipping",
                          file=sys.stderr)
                    failed_dates.append(date_str)
                # Brief pacing between dates — the upstream GAS server seems to
                # degrade (silently empty responses) under back-to-back requests.
                await page.wait_for_timeout(1000)
```

- [ ] **Step 6: Remove the `recover_vanished_bookings()` call site in `main()`**

Find this block in `main()`:

```python
    # Recover cancelled bookings the live feed silently omits — see
    # recover_vanished_bookings() docstring for the full story.
    recovered = recover_vanished_bookings(new_schedules, existing_schedules, cancel_lookup)
    if recovered:
        print(f"Recovered {recovered} cancelled booking(s) the live feed omitted "
              f"(preserved last-known time slot; reason filled where already backfilled).")

    # Regression guard: a date going from populated to (near-)empty in a
```

Replace it with (deleting only the 6 `recover_vanished_bookings()` lines — the `# Regression guard: ...` comment and everything after it is existing code, reproduced here only to anchor the edit precisely; leave it untouched):

```python
    # Regression guard: a date going from populated to (near-)empty in a
```

- [ ] **Step 7: Update the RPC inventory comment to list `getStudentSchedule` as the primary schedule source**

Find:

```python
# ─── Portal internal RPC API ─────────────────────────────────────────────────
# The portal is a google.script.run SPA; its server functions are callable
# from inside userHtmlFrame and return clean JSON — far more reliable than
# scraping the rendered UI. Full inventory of the read-only functions (probed
# 2026-07-16): getBatches, getInstructors, getStudents, getCurriculumLessons,
# getStudentProgressMatrixPortal({batch}), getStatusBoardData(date?),
# getScheduleRegs, getSofForDate({date}), getAircraftForFlightPlan,
# getFlightPlanTemplates, getMySubmissions({studentName,batch}),
# getSubmissionDetail({id}), getTZ. See AP127_Docs §4.1.
# NEVER call the mutating ones (submit*/write*/fix*/backfill*/ensure*).
_RPC_JS = """
```

Replace it with:

```python
# ─── Portal internal RPC API ─────────────────────────────────────────────────
# The portal is a google.script.run SPA; its server functions are callable
# from inside userHtmlFrame and return clean JSON — far more reliable than
# scraping the rendered UI. `getStudentSchedule({date})` is the primary
# schedule source as of 2026-07-27 (see docs/superpowers/specs/2026-07-27-
# rpc-based-schedule-fetch-design.md) — Pending/Completed/Canceled/Meeting
# together in one call, no DOM/mode-switching involved. Full inventory of the
# other read-only functions (probed 2026-07-16, re-confirmed 2026-07-27):
# getBatches, getInstructors, getStudents, getCurriculumLessons,
# getStudentProgressMatrixPortal({batch}), getStatusBoardData(date?),
# getScheduleRegs, getSofForDate({date}), getAircraftForFlightPlan,
# getFlightPlanTemplates, getMySubmissions({studentName,batch}),
# getSubmissionDetail({id}), getTZ, getMyUpcomingBookings({studentName,batch}).
# See AP127_Docs §4.1. NEVER call the mutating ones
# (submit*/write*/fix*/backfill*/ensure*/save*).
_RPC_JS = """
```

- [ ] **Step 8: Verify the file still parses and the removed names are actually gone**

```bash
cd /Users/nugui/flight-schedule-feed
python3 -c "import ast; ast.parse(open('scripts/fetch_schedule.py').read())" && echo "syntax OK"
grep -n "_fetch_one_date\|recover_vanished_bookings\|forbidden_mode\|DATE_SETTLE_TIMEOUT_S\|MIN_SETTLE_WAIT_S\|STABILITY_RECHECK_S\|gantt-mode-canceled" scripts/fetch_schedule.py
```

Expected: `syntax OK` printed, and the `grep` finds **zero matches** (empty output) — confirms all the dead Timeline-mode machinery is gone.

- [ ] **Step 9: Run the existing tests to confirm nothing broke**

```bash
python3 -m pytest scripts/tests/test_fetch_schedule.py -v
```

Expected: all 5 tests still PASS (Task 1/2's tests don't touch `scrape_window()`/`main()`, so this is a smoke check that the import still works after the deletions).

- [ ] **Step 10: Commit**

```bash
git add scripts/fetch_schedule.py
git commit -m "refactor: replace Timeline mode-switching fetch with getStudentSchedule RPC

Removes _fetch_one_date(), the Canceled-mode second pass, and
recover_vanished_bookings() — getStudentSchedule returns Canceled status
inline for every date, so the entire mode-leak bug class (root cause of the
2026-07-31 status flip-flop) is structurally eliminated rather than guarded
against. See docs/superpowers/specs/2026-07-27-rpc-based-schedule-fetch-design.md."
```

---

## Task 4: Fatal check when `getStudentSchedule` disappears from the portal

**Files:**
- Create: `scripts/tests/test_portal_structure.py`
- Modify: `scripts/fetch_schedule.py`

**Interfaces:**
- Produces: `CriticalRPCMissingError(RuntimeError)`, `CRITICAL_RPC_FUNCTIONS: set[str]`, `_check_critical_rpcs(rpc_functions) -> None` (raises `CriticalRPCMissingError` if any critical RPC is missing).
- Consumes: `_capture_cheap_fingerprint()` (existing, unchanged) inside `check_portal_structure()`.

- [ ] **Step 1: Write the failing tests in `scripts/tests/test_portal_structure.py`**

```python
import fetch_schedule as fs
import pytest


def test_check_critical_rpcs_passes_when_present():
    fs._check_critical_rpcs(["getStudentSchedule", "getBatches", "getInstructors"])


def test_check_critical_rpcs_raises_when_missing():
    with pytest.raises(fs.CriticalRPCMissingError):
        fs._check_critical_rpcs(["getBatches", "getInstructors"])


def test_check_critical_rpcs_error_names_the_missing_function():
    with pytest.raises(fs.CriticalRPCMissingError, match="getStudentSchedule"):
        fs._check_critical_rpcs([])
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/nugui/flight-schedule-feed
python3 -m pytest scripts/tests/test_portal_structure.py -v
```

Expected: FAIL with `AttributeError: module 'fetch_schedule' has no attribute '_check_critical_rpcs'`.

- [ ] **Step 3: Implement `CriticalRPCMissingError`, `CRITICAL_RPC_FUNCTIONS`, `_check_critical_rpcs()`**

Find this block in `scripts/fetch_schedule.py` (in the "Portal structure drift detection" section):

```python
# Known-volatile fields intentionally NOT diffed here even though they're
# captured: batch/student/instructor lists grow routinely as new cohorts
# start (confirmed 2026-07-26: a new "PPL-38" batch appeared between two
# audits, expected growth, not drift) — alerting on every addition would
# make the mechanism noisy enough to get ignored, defeating its purpose.


def _load_portal_fingerprint():
```

Replace it with:

```python
# Known-volatile fields intentionally NOT diffed here even though they're
# captured: batch/student/instructor lists grow routinely as new cohorts
# start (confirmed 2026-07-26: a new "PPL-38" batch appeared between two
# audits, expected growth, not drift) — alerting on every addition would
# make the mechanism noisy enough to get ignored, defeating its purpose.

# 2026-07-27: ordinary structural drift (below) is deliberately non-fatal —
# warn and continue. getStudentSchedule is different: it's the schedule
# pipeline's sole data source now (see docs/superpowers/specs/2026-07-27-
# rpc-based-schedule-fetch-design.md), so its disappearance means every date
# would silently fetch nothing rather than surfacing as an obvious failure.
# This must abort the run instead of quietly warning.
CRITICAL_RPC_FUNCTIONS = {"getStudentSchedule"}


class CriticalRPCMissingError(RuntimeError):
    pass


def _check_critical_rpcs(rpc_functions):
    missing = CRITICAL_RPC_FUNCTIONS - set(rpc_functions)
    if missing:
        raise CriticalRPCMissingError(
            f"Ops Portal RPC function(s) required for schedule fetching are missing: "
            f"{sorted(missing)} — the portal has changed and the scraper cannot "
            f"function until this is fixed."
        )


def _load_portal_fingerprint():
```

- [ ] **Step 4: Wire the check into `check_portal_structure()`**

Find this line inside `check_portal_structure()`:

```python
    cheap = await _capture_cheap_fingerprint(user_frame)
    if not first_run:
```

Replace it with:

```python
    cheap = await _capture_cheap_fingerprint(user_frame)
    _check_critical_rpcs(cheap["rpc_functions"])
    if not first_run:
```

- [ ] **Step 5: Make sure the fatal error isn't swallowed by `scrape_window()`'s existing catch-all**

Find this block in `scrape_window()`:

```python
            structure_warnings = []
            try:
                structure_warnings = await check_portal_structure(page, user_frame)
                for w in structure_warnings:
                    print(f"WARNING: {w}", file=sys.stderr)
            except Exception as exc:
                print(f"WARNING: portal-structure check itself failed ({exc}) — "
                      f"skipping this run, will retry next scheduled check", file=sys.stderr)
```

Replace it with:

```python
            structure_warnings = []
            try:
                structure_warnings = await check_portal_structure(page, user_frame)
                for w in structure_warnings:
                    print(f"WARNING: {w}", file=sys.stderr)
            except CriticalRPCMissingError:
                # Fatal — do NOT swallow like an ordinary structure-check failure. Propagates up
                # through main() to main_with_retry(), which retries then exits non-zero, tripping
                # the existing "Report failure as GitHub issue" CI step.
                raise
            except Exception as exc:
                print(f"WARNING: portal-structure check itself failed ({exc}) — "
                      f"skipping this run, will retry next scheduled check", file=sys.stderr)
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
python3 -m pytest scripts/tests/ -v
```

Expected: all 8 tests (5 from Task 1 + 3 new) PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch_schedule.py scripts/tests/test_portal_structure.py
git commit -m "feat: abort the run if getStudentSchedule disappears from the portal RPC surface"
```

---

## Task 5: Live verification against the real Ops Portal

**Files:** none created/modified — this is a verification-only task using the already-implemented `scripts/fetch_schedule.py`.

This is the closest thing to an integration test available (no live-portal CI access outside GitHub Actions). It also produces the first real data commit under the new fetch mechanism.

- [ ] **Step 1: Ensure Playwright's Chromium binary is installed**

```bash
cd /Users/nugui/flight-schedule-feed
python3 -m playwright install chromium
```

- [ ] **Step 2: Run the real scraper locally against the live portal**

```bash
python3 scripts/fetch_schedule.py
```

Expected: exits 0. Watch the output for each date's flight count (no more "Canceled mode:" line — that pass no longer exists), and confirm no `CriticalRPCMissingError` and no unexpected `ERROR:` lines. A few `WARNING:` lines about known cosmetic bookingId formats (e.g. `FAM FI-...`) are normal and pre-existing — not a regression.

- [ ] **Step 3: Spot-check known dates against the counts verified during the design investigation**

```bash
python3 -c "
import json
from collections import Counter
d = json.loads(open('data/flight_schedule.json', encoding='utf-8').read())
for date, expected_total in [('2026-07-08', 61), ('2026-07-16', 64), ('2026-07-31', None)]:
    entries = d['schedules'].get(date, [])
    statuses = dict(Counter(e['status'] for e in entries))
    print(date, 'total=', len(entries), 'statuses=', statuses,
          '(expected total', expected_total, ')' if expected_total else '')
"
```

Expected: `2026-07-08` → 61 total (40 Completed / 17 Canceled / 4 Pending), `2026-07-16` → 64 total (51 Completed / 11 Canceled / 2 Pending) — matching the counts recorded in the design spec exactly. `2026-07-31` should show a real, non-flip-flopping status (by now likely a mix of Pending/Completed as the date has passed — that's expected, not a bug).

- [ ] **Step 4: Regenerate the derived public feed and review the diff**

```bash
python3 scripts/generate_flight_data.py
git diff --stat data/flight_schedule.json flight-data.js data/portal_fingerprint.json
```

Expected: a normal-looking data diff (routine status/actual updates from the live fetch), nothing structurally alarming (no mass deletion, no schema-shaped surprises). If `validate_raw_cache()` printed any `ERROR:` lines in Step 2, stop and investigate before proceeding — do not commit.

- [ ] **Step 5: Commit the verification data update**

```bash
git add data/flight_schedule.json data/portal_fingerprint.json flight-data.js
git commit -m "chore: data refresh from local verification run (RPC-based fetch)"
```

---

## Task 6: Update `flight-schedule-feed/CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the resolved `🔴 HANDOFF` block with a closure note**

Find the entire block from `## 🔴 HANDOFF (2026-07-27, ~15:30 UTC) — read this first, then §"Last known" below for full history` through the line right before `## ⚠️ Update rule — do this after EVERY code change` (i.e. delete everything from that `##` heading down to, but not including, the `## ⚠️ Update rule` heading — this is currently lines 3–91).

Replace the deleted block with nothing (the file goes straight from the `# CMD CTR — Claude Code Context` title to `## ⚠️ Update rule`).

- [ ] **Step 2: Prepend a new entry to the `**Last known:**` line in the Verify section**

This file's established pattern (confirmed by reading the existing chain) is a sequence of
self-contained `(DATE — description.)` parenthetical blocks concatenated directly one after another —
**not** prose like "Previously (same day — ...)" (that style belongs to a different file,
`AP127_Docs/README.md`'s banner — don't mix the two).

Find, in the `## Verify actual state — run before starting` section:

```
**Last known:** token = `r44` (2026-07-27 — **regression guard given an escape hatch + a stuck date
```

Replace `**Last known:** token = \`r44\` (2026-07-27 — **regression guard given an escape hatch + a stuck date` with:

```
**Last known:** token = `r44` (2026-07-27 — **root cause of the 2026-07-31 status flip-flop fixed:
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
design.) (2026-07-27 — **regression guard given an escape hatch + a stuck date
```

(This inserts the new entry as its own fully self-closed `(...)` block — note the closing `)` right
before the next ` (2026-07-27 — **regression guard...` — directly ahead of the existing chain, which
is otherwise untouched.)

- [ ] **Step 3: Verify the file is well-formed**

```bash
cd /Users/nugui/flight-schedule-feed
head -20 CLAUDE.md
grep -c "🔴 HANDOFF" CLAUDE.md
```

Expected: the file starts with the title then goes straight into `## ⚠️ Update rule`; the `grep -c` count is `0` (no HANDOFF block remains).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: resolve 2026-07-31 flip-flop handoff — root cause fixed via getStudentSchedule RPC"
```

---

## Task 7: Update `AP127_V2/CLAUDE.md`

**Files:**
- Modify: `/Users/nugui/AP127_V2/CLAUDE.md`

Watchdog code itself is untouched (out of scope per Global Constraints) — this is a documentation-only update noting the upstream fix.

- [ ] **Step 1: Replace the `🔴 HANDOFF` block**

Find the entire block from `## 🔴 HANDOFF (2026-07-27, ~15:30 UTC): AP127 Telegram notifications are OFF, investigation in progress` through the line right before `## ⚠️ Update rule — do this after EVERY code change` (currently lines 3–14).

Replace it with:

```markdown
## Note (2026-07-27): CMD_CTR-side root cause of the notification flip-flop is fixed

The `2026-07-31` status flip-flop that caused duplicate Cancelled/Pending Telegram notices was root-caused
and fixed upstream in CMD_CTR (`flight-schedule-feed/CLAUDE.md` — the scraper's Timeline mode-switching
fetch, which could silently leak a stale Canceled-mode read, was replaced entirely with a direct RPC call
that can't produce that failure mode). AP127 Telegram notifications are still OFF as of this write —
re-enabling them is the user's call once they're satisfied the upstream fix is holding in production
(watch a few days of CI runs / real notifications before flipping `enabled: true` in the Watchdog
Destinations config). This session's watchdog-side defensive patches (`stabilizeCancelledFlights()`, the
bookingId-reassignment guard, the anomaly-drop guard, `suppressActualPairs()`) were built to compensate
for the now-fixed upstream flakiness — left in place deliberately (no evidence they cause harm by
staying, removing them is a separate future cleanup, not bundled into the upstream fix).
```

- [ ] **Step 2: Verify**

```bash
cd /Users/nugui/AP127_V2
grep -c "🔴 HANDOFF" CLAUDE.md
```

Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note CMD_CTR-side root cause fix for the notification flip-flop; notifications still off pending user confirmation"
```

---

## Task 8: Update `AP127_Docs/README.md` and push

**Files:**
- Modify: `/Users/nugui/AP127_Docs/README.md`

- [ ] **Step 1: Resolve the top-of-file HANDOFF banner**

Find the block starting at `> **🔴 HANDOFF IN PROGRESS (2026-07-27, ~15:30 UTC):**` through the line ending `> re-enable without verifying current stability yourself first.` followed by a blank `>` line (currently lines 11–18).

Replace it with:

```
> **Resolved 2026-07-27:** the `2026-07-31` booking-status flip-flop (AP127 Telegram notifications were
> OFF as a stopgap) is fixed — CMD_CTR's scraper replaced Timeline mode-switching with a direct
> `getStudentSchedule` RPC call, eliminating the bug class structurally rather than guarding against it.
> See §2.1 and §10. Notifications remain off pending the user's own confirmation the fix is holding in
> production.
>
```

- [ ] **Step 2: Add a new bullet to §2.1 CMD_CTR**

Find the end of the `### 2.1 CMD_CTR` section — the bullet ending:

```
  regenerating `flight-data.js` fresh from the corrected source and verifying the diff was scoped to
  exactly the expected changes before committing. See §10.

### 2.2 DB001 — NGT_001 admin dashboard (progress)
```

Replace it with:

```
  regenerating `flight-data.js` fresh from the corrected source and verifying the diff was scoped to
  exactly the expected changes before committing. See §10.
- **Schedule fetch switched from Timeline mode-switching to the `getStudentSchedule` RPC (2026-07-27):**
  root cause of the `2026-07-31` status flip-flop was `scrape_window()`'s Canceled-mode second pass
  assuming the Timeline's mode switch stays sticky across every date change in its loop — never verified,
  confirmed broken live. A live audit found an undocumented RPC, `getStudentSchedule({date})`, returning
  Pending/Completed/Canceled/Meeting for a date in one clean JSON call (no DOM, no mode concept) —
  verified against 4 known dates matching exact counts, `actual{}` intact. Replaced the entire
  Timeline-DOM fetch with this RPC as the sole mechanism, no fallback (a future RPC failure gets fixed,
  not silently degraded around) — RPC failures are loud (timeout/exception), unlike the silent-wrong-data
  failure mode this replaces. Deleted `_fetch_one_date()`, the Canceled-mode pass, and
  `recover_vanished_bookings()` as dead code. Added a fatal check
  (`CriticalRPCMissingError`/`_check_critical_rpcs()`) so the run aborts loudly if `getStudentSchedule`
  ever disappears from the portal, instead of silently fetching nothing — ordinary structural drift stays
  non-fatal as before. First test suite for this repo (`scripts/tests/`, pytest). See
  `flight-schedule-feed/docs/superpowers/specs/2026-07-27-rpc-based-schedule-fetch-design.md`.

### 2.2 DB001 — NGT_001 admin dashboard (progress)
```

- [ ] **Step 3: Add a new `Resolved` block to §10 Open Items**

Find the very start of §10:

```
## 10. Open items

**Resolved 2026-07-27 (CMD_CTR — regression guard given an escape hatch, plus a manually-corrected
```

Replace it with:

```
## 10. Open items

**Resolved 2026-07-27 (CMD_CTR — root cause of the `2026-07-31` status flip-flop fixed, Timeline
mode-switching replaced with the `getStudentSchedule` RPC):** Same-day follow-on to the regression-guard
fix directly below — after that fix, `2026-07-31` kept flip-flopping its `status` between all-Pending and
all-Canceled with the count staying at exactly 30, a genuinely different bug (neither the concurrency fix
nor the regression-guard fix could produce a same-count status flip). Root cause: `scrape_window()`'s
Canceled-mode second pass switches the Timeline into Canceled mode ONCE before its whole date loop, on
the assumption the switch stays sticky across every date change — never verified, confirmed broken live
for this specific date (plausibly the busiest/slowest to settle). A same-day interim fix added a
`forbidden_mode` guard that rejects a read caught in the wrong mode; a follow-up live audit then found a
better path entirely: an undocumented RPC, `getStudentSchedule({date})`, returns the full per-date
schedule (Pending/Completed/Canceled/Meeting, `actual{}` included) as clean JSON — no DOM, no mode
concept, so the entire bug class can't occur. Verified against 4 known dates (`2026-07-08`, `2026-07-16`,
`2026-07-27`, `2026-07-31`) matching exact counts recorded in earlier audits. User approved replacing the
Timeline-based fetch with this RPC as the SOLE mechanism (no Timeline fallback — a future RPC failure
gets fixed, not silently degraded around) and removing the now-dead defensive machinery
(`_fetch_one_date()`, the Canceled-mode pass, `recover_vanished_bookings()`, the interim `forbidden_mode`
guard) rather than keeping it as unused fallback code. Also added a fatal check so the pipeline aborts
loudly (instead of silently fetching nothing) if `getStudentSchedule` ever disappears from the portal's
RPC surface — the existing structural-drift detector (`check_portal_structure()`, built 2026-07-26)
already covers detecting this with zero new code; the addition is making THIS ONE function's
disappearance fatal rather than a passive warning, since the whole schedule pipeline now depends on it.
AP127_V2/watchdog's defensive patches built to compensate for the now-fixed flakiness
(`stabilizeCancelledFlights()`, etc.) were deliberately left in place — no evidence they cause harm by
staying, and removing them is a separate future cleanup. See §2.1.

**Resolved 2026-07-27 (CMD_CTR — regression guard given an escape hatch, plus a manually-corrected
```

- [ ] **Step 4: Verify and commit**

```bash
cd /Users/nugui/AP127_Docs
grep -c "🔴 HANDOFF IN PROGRESS" README.md
git add README.md
git commit -m "docs: resolve 2026-07-31 flip-flop — CMD_CTR switched to getStudentSchedule RPC"
```

Expected: `grep -c` prints `0`.

- [ ] **Step 5: Push (this repo's own CLAUDE.md directs pushing after every change — documentation-only, no deploy-triggered behavior change, safe to push directly)**

```bash
git push origin main
```

---

## Task 9: Final checkpoint — confirm with the user before pushing the live-code repos

**Files:** none.

`flight-schedule-feed` and `AP127_V2` pushes are deliberately held back until now (Global Constraints) — `flight-schedule-feed`'s push triggers a live CI run against the production Ops Portal and swaps the mechanism a real operational dashboard depends on; `AP127_V2`'s push (docs-only) is low-risk but bundled here for one combined review.

- [ ] **Step 1: Show the user a summary of everything that's about to go live**

```bash
cd /Users/nugui/flight-schedule-feed
git log --oneline main..HEAD
echo "---"
git -C /Users/nugui/AP127_V2 log --oneline main..HEAD
```

Present this commit list to the user, along with: all 8 tests passing (Task 4 Step 6), the live-verification spot-check results (Task 5 Step 3), and a one-line reminder that the next CI run on `flight-schedule-feed` will use the new fetch mechanism against the live portal.

- [ ] **Step 2: On explicit confirmation, push both repos**

```bash
cd /Users/nugui/flight-schedule-feed
git push origin main
cd /Users/nugui/AP127_V2
git push origin main
```

- [ ] **Step 3: Watch the first live CI run**

```bash
gh run list --repo AP127CMD/CMD_CTR --workflow=fetch_schedule.yml --limit 3
```

Wait for the newest run to reach `completed`/`success`, then spot-check `2026-07-31` (or whatever the current near-future busy date is) the same way as the handoff's original verification commands — confirm a clean, non-flip-flopping status and no `CriticalRPCMissingError` in the logs.
