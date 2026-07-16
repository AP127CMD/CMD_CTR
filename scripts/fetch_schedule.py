import asyncio
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from playwright.async_api import async_playwright

# Ops Portal was rebuilt from scratch ~2026-07-10 (old flightCache single-shot
# dump -> new google.script.run SPA, one day per request). Old URL 404s now.
SCRIPT_URL = (
    "https://script.google.com/macros/s/"
    "AKfycbx-8p8MWbDAeJkTBPt4Yy_6cH0azSv-5VXcrzVhIUGM6XEJRtMBQNku-WybzNlhq9zN/exec"
)
OUTPUT_FILE = Path(__file__).parent.parent / "data" / "flight_schedule.json"
LOAD_TIMEOUT_MS = 90_000    # 90 s total page load budget (GAS cold-starts can be slow)
DATE_SETTLE_TIMEOUT_S = 25  # observed per-date server round-trip: 1.5-12s, be generous

# Frozen archive of the OLD portal's data (rich fields: tkoff/ldgTime/airborne/
# planDur/isActual/cancelReason — none of which the new portal exposes). Dates
# in this archive are fully resolved (every flight already flown/cancelled as
# of 2026-07-09) and are permanently excluded from the new scraper's fetch —
# see _apply_frozen_archive(). Per explicit request: keep old data as-is for
# everything before the cutover, only let the new source manage dates after.
FROZEN_ARCHIVE_FILE = Path(__file__).parent.parent / "data" / "flight_schedule.pre_migration_archive.json"

# Retry config — overridable via env vars set in the workflow.
MAX_ATTEMPTS  = int(os.environ.get("FETCH_MAX_ATTEMPTS", "3"))
RETRY_DELAY_S = int(os.environ.get("FETCH_RETRY_DELAY",  "20"))

# Date window to scrape each run — the new portal only returns one day per
# request (no more single-shot multi-month dump), so we loop day-by-day.
# History accumulates across runs via the merge-with-existing-file logic
# below; this window only needs to cover what's likely to change between
# runs plus a comfortable buffer, not the full multi-month archive.
DAYS_BACK    = int(os.environ.get("FETCH_DAYS_BACK",    "7"))
DAYS_FORWARD = int(os.environ.get("FETCH_DAYS_FORWARD", "10"))

TIMEZONE = "Asia/Bangkok"
VALID_STATUSES = {"Pending", "Completed", "Canceled"}

# Fields observed from the new Ops Portal as of the 2026-07-11 migration
# (Timeline View's window.G.flights and Daily Schedule's window.SD.flights
# confirmed to expose the identical shape). A missing field is a hard error;
# a new/unexpected field is a warning surfaced as a non-fatal GitHub issue so
# upstream drift gets noticed instead of silently breaking again.
REQUIRED_ENTRY_FIELDS = {
    "date", "bookingId", "status", "student", "instructor", "batch", "lesson",
    "startTime", "endTime", "duration", "condition", "acType", "acReg",
}
KNOWN_ENTRY_FIELDS = REQUIRED_ENTRY_FIELDS

_DURATION_RE = re.compile(r"^\d+:\d{2}$")
_TIME_RE = re.compile(r"^\d{2}:\d{2}$")
# Booking id formats observed: "BK-XXXX-NNNN" (normal booking) and
# "DR-AP-126-PONG-C0LHI" (a second scheme). Kept loose on purpose — tightening
# it just means more false "unexpected format" warnings without catching
# anything a hard error would help with.
_BOOKING_ID_RE = re.compile(r"^[A-Z]{2,}-[A-Z0-9-]+$")
# The new portal appends an override note to status instead of a separate
# field, e.g. "Pending [OVERRIDE: Student solo]".
_STATUS_OVERRIDE_RE = re.compile(r"^(Pending|Completed|Canceled)\s*\[OVERRIDE:\s*(.+?)\]\s*$")


def validate_raw_cache(cache):
    """
    Check raw scraped data against the known Ops Portal schema before
    normalization.

    Returns (warnings, errors). Errors mean our normalization logic will
    break or produce wrong output; warnings mean upstream drift worth
    investigating but not fatal — surfaced as a non-blocking GitHub issue by
    the workflow so it doesn't sit unnoticed (the 2026-07-11 portal rebuild
    went 18+ hours before anyone realized data had gone stale).
    """
    warnings = []
    errors = []

    schedules = cache.get("schedules", {})
    if not isinstance(schedules, dict):
        errors.append(f"'schedules' is not a dict (got {type(schedules).__name__})")
        return warnings, errors

    new_fields: set = set()
    new_statuses: set = set()
    new_id_prefixes: set = set()

    for date, entries in schedules.items():
        if not isinstance(entries, list):
            errors.append(f"schedules[{date!r}] is not a list")
            continue

        for entry in entries:
            ref = f"date={date} bookingId={entry.get('bookingId', '?')!r}"

            missing = REQUIRED_ENTRY_FIELDS - set(entry)
            if missing:
                errors.append(f"{ref}: missing fields {sorted(missing)}")

            extra = set(entry) - KNOWN_ENTRY_FIELDS
            if extra:
                new_fields.update(extra)

            booking_id = str(entry.get("bookingId", ""))
            if not _BOOKING_ID_RE.match(booking_id):
                warnings.append(f"{ref}: unexpected bookingId format: {booking_id!r}")
            else:
                prefix = booking_id.split("-")[0] + "-"
                if prefix not in ("BK-", "DR-"):
                    new_id_prefixes.add(prefix)

            duration = entry.get("duration", "")
            if duration and duration != "-" and not _DURATION_RE.match(duration):
                errors.append(f"{ref}: duration has unexpected format: {duration!r}")

            for field in ("startTime", "endTime"):
                val = entry.get(field, "")
                if val and not _TIME_RE.match(val):
                    errors.append(f"{ref}: {field} has unexpected format: {val!r}")

            status = entry.get("status", "")
            base_status = status
            m = _STATUS_OVERRIDE_RE.match(status or "")
            if m:
                base_status = m.group(1)
            if base_status not in VALID_STATUSES:
                new_statuses.add(status)

    if new_fields:
        warnings.append(f"New entry fields from upstream (review for usefulness): {sorted(new_fields)}")
    if new_statuses:
        warnings.append(f"Unknown status values (defaulted to 'Pending'): {sorted(str(s) for s in new_statuses)}")
    if new_id_prefixes:
        warnings.append(f"New bookingId prefix(es) not yet handled: {sorted(new_id_prefixes)}")

    return warnings, errors


def _null_dash(value):
    return None if value in ("-", "") else value


def _parse_duration_min(duration_str):
    """Convert 'H:MM' to total minutes as int, or None if unparseable."""
    try:
        h, m = duration_str.split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return None


def _zero_pad_duration(duration_str):
    """New portal emits 'H:MM' (e.g. '2:00'); old one emitted 'HH:MM'
    ('02:00') and several views render this string as-is. Zero-pad to avoid
    a purely cosmetic display change."""
    try:
        h, m = duration_str.split(":")
        return f"{int(h):02d}:{m}"
    except Exception:
        return duration_str


def normalize_entry(entry, date):
    """
    Return a normalized schedule entry ready for dashboard consumption.

    The new Ops Portal (migrated ~2026-07-10) has a materially simpler data
    model than the old one: one canonical record per booking whose `status`
    tracks lifecycle (Pending -> Completed/Canceled), instead of the old dual
    planned+actual row pair keyed by rowIdx/realRowIdx. Fields that depended
    on that old model (isActual, planDur, rowIdx/realRowIdx as distinct
    concepts) or on post-flight detail the new portal's read views don't
    expose (tkoff/ldgTime/airborne/to/ldg/inst, cancelReason) are kept in the
    output shape for backward compatibility but are always None/derived —
    see AP127_Docs README §10 (2026-07-11) for what was checked (Timeline
    View, Daily Schedule, the Flight/Cancel Record submission schemas)
    before concluding they're genuinely unavailable, not just unmapped.
    """
    booking_id = entry.get("bookingId")
    duration_str = _zero_pad_duration(entry.get("duration") or "")
    ac_type = entry.get("acType") or ""
    raw_status = entry.get("status") or ""
    status_override = None
    status = raw_status
    m = _STATUS_OVERRIDE_RE.match(raw_status)
    if m:
        status, status_override = m.group(1), m.group(2)
    raw_condition = _null_dash(entry.get("condition") or "")
    is_standby = isinstance(raw_condition, str) and "(Standby)" in raw_condition
    condition = raw_condition.replace(" (Standby)", "").strip() if is_standby else raw_condition

    return {
        "id": str(booking_id),
        "date": date,
        "rowIdx": booking_id,
        "realRowIdx": None,
        "status": status if status in VALID_STATUSES else "Pending",
        "statusOverride": status_override,
        "isActual": status == "Completed",
        "isSimulator": "(SIM)" in ac_type,
        "isStandby": is_standby,
        # scheduling
        "start": entry.get("startTime"),
        "end": entry.get("endTime"),
        "duration": duration_str or None,
        "durationMin": _parse_duration_min(duration_str),
        "planDur": None,
        "planDurMin": None,
        # people
        "student": _null_dash(entry.get("student")),
        "instructor": _null_dash(entry.get("instructor")),
        "batch": entry.get("batch"),
        "lesson": entry.get("lesson"),
        "condition": condition,
        # aircraft
        "type": _null_dash(ac_type),
        "tail": _null_dash(entry.get("acReg")),
        # actuals — not exposed by the new portal's read views (checked
        # 2026-07-11; see AP127_Docs README §10)
        "actualType": None,
        "tkoff": None,
        "ldgTime": None,
        "airborne": None,
        "ldg": None,
        "to": None,
        "inst": None,
        # cancellation — Cancel Record's submission schema has a `reason`
        # field but it isn't echoed back on any read view
        "cancelReason": None,
    }


async def _get_content_frame(page):
    """Return the userHtmlFrame nested inside GAS's sandboxFrame."""
    await page.wait_for_selector("iframe", timeout=LOAD_TIMEOUT_MS)
    for _ in range(40):
        for frame in page.frames:
            if frame.name == "userHtmlFrame":
                return frame
        await page.wait_for_timeout(500)
    raise RuntimeError("userHtmlFrame never appeared")


async def _open_timeline_view(user_frame):
    await user_frame.get_by_text("Timeline View").click(timeout=15_000)
    await user_frame.wait_for_selector("#gantt-date", timeout=15_000)


DATE_FETCH_ATTEMPTS = int(os.environ.get("FETCH_DATE_ATTEMPTS", "3"))


MIN_SETTLE_WAIT_S = 3   # a result (esp. an empty one) landing before this is
                        # almost certainly a stale-clear artifact, not real data
STABILITY_RECHECK_S = 2  # re-verify an apparently-settled EMPTY result is real,
                          # not the brief clear-state before the async reply lands


async def _fetch_one_date(page, user_frame, date_str):
    """Set the Gantt date picker and wait for window.G to settle on that date.

    Uses locator.fill() (a real, trusted browser input event) rather than a
    plain element.dispatchEvent() from in-page JS — the latter is untrusted
    and was observed to sometimes get silently no-op'd by the app, leaving
    G.date updated but G.flights stuck on the previous date's data with no
    error and no new network request at all.

    window.G.date updates synchronously once the request is accepted, but
    window.G.flights lags behind until the async server round-trip resolves
    (observed 1.5-12s). An EMPTY flights array needs extra scrutiny: the app
    appears to clear G.flights = [] immediately on date change, before the
    async reply overwrites it — so a naive "flights matches target date"
    check (trivially true for an empty array) can accept a transient clear
    state as if it were a genuine zero-flights day. Enforce a minimum wait
    before accepting anything, and re-verify an empty result is stable
    before trusting it.
    """
    date_input = user_frame.locator("#gantt-date")
    await date_input.fill(date_str)
    await date_input.dispatch_event("change")
    await page.wait_for_timeout(MIN_SETTLE_WAIT_S * 1000)

    for _ in range(DATE_SETTLE_TIMEOUT_S):
        g = await user_frame.evaluate("() => JSON.stringify(window.G)")
        data = json.loads(g)
        if data.get("date") == date_str:
            flights = data.get("flights", [])
            flight_dates = {f["date"] for f in flights}
            if flight_dates <= {date_str}:
                if flights:
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
    """Dates the OLD portal already fully resolved (see FROZEN_ARCHIVE_FILE
    docstring above) — never re-fetched, never overwritten."""
    if not FROZEN_ARCHIVE_FILE.exists():
        return {}
    return json.loads(FROZEN_ARCHIVE_FILE.read_text(encoding="utf-8")).get("schedules", {})


# A tail with no booking anywhere in [today - N days, +∞) is treated as
# unavailable (isMaint) — see derive_resources().
RESOURCE_ACTIVE_LOOKBACK_DAYS = int(os.environ.get("RESOURCE_ACTIVE_LOOKBACK_DAYS", "14"))

# Max getSubmissionDetail calls per run while backfilling leave records —
# ~385 historical leaves exist; at 60/run the backfill completes in ~7 cron
# cycles, after which a typical run fetches 0-2 new ones.
LEAVE_DETAIL_MAX_PER_RUN = int(os.environ.get("LEAVE_DETAIL_MAX_PER_RUN", "60"))


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
([fn, args, tmo]) => new Promise(resolve => {
  const t = setTimeout(() => resolve({__err: 'timeout ' + tmo + 's'}), tmo * 1000);
  try {
    google.script.run
      .withSuccessHandler(r => { clearTimeout(t); resolve({__ok: (r === undefined ? null : r)}); })
      .withFailureHandler(e => { clearTimeout(t); resolve({__err: String((e && e.message) || e)}); })
      [fn](...args);
  } catch (e) { clearTimeout(t); resolve({__err: String(e)}); }
})
"""


async def _rpc(user_frame, fn, *args, timeout_s=45):
    """Call a portal server function; raises on failure/timeout."""
    res = await user_frame.evaluate(_RPC_JS, [fn, list(args), timeout_s])
    if not isinstance(res, dict) or "__err" in res:
        raise RuntimeError(f"{fn} RPC failed: {(res or {}).get('__err', res)}")
    return res.get("__ok")


async def _fetch_rosters(user_frame, today_iso):
    """instructors + resources via the portal RPC API.

    - instructors: getInstructors() — includes the real type
      (Flight Instructor vs Simulator Instructor).
    - resources: getScheduleRegs() (the portal's own fleet roster — the
      authoritative list the old portal used to expose) + per-tail
      unavail/unavailReason from getStatusBoardData(today) as the real
      isMaint flag (replaces the no-recent-booking heuristic).

    Each part fails independently: instructors→None (caller falls back to
    the dropdown scrape), resources→None (caller falls back to
    derive_resources()).
    """
    instructors = None
    resources = None
    try:
        instructors = await _rpc(user_frame, "getInstructors")
    except Exception as exc:
        print(f"WARNING: getInstructors RPC failed ({exc}) — falling back to dropdown scrape", file=sys.stderr)
    try:
        regs = await _rpc(user_frame, "getScheduleRegs")
        unavail = {}
        try:
            board = await _rpc(user_frame, "getStatusBoardData", today_iso) or {}
            for typ in (board.get("byType") or {}).values():
                for group in ("unavail", "unused", "used"):
                    for ac in typ.get(group) or []:
                        if ac.get("unavail"):
                            unavail[ac.get("reg")] = ac.get("unavailReason") or "Unavailable"
        except Exception as exc:
            print(f"WARNING: getStatusBoardData RPC failed ({exc}) — isMaint flags default to False", file=sys.stderr)
        resources = [
            {
                "tail": r["reg"],
                "acType": r.get("acType") or "",
                "isMaint": r["reg"] in unavail,
                "maintReason": unavail.get(r["reg"]),
            }
            for r in (regs or []) if r.get("reg")
        ] or None
    except Exception as exc:
        print(f"WARNING: getScheduleRegs RPC failed ({exc}) — resources will be derived from flight data", file=sys.stderr)
    return instructors, resources


def _load_existing_leaves():
    if not OUTPUT_FILE.exists():
        return []
    try:
        return json.loads(OUTPUT_FILE.read_text(encoding="utf-8")).get("leaves") or []
    except Exception:
        return []


async def _fetch_leaves(user_frame):
    """Rebuild the leaves feed from Leave Request submissions.

    The new portal's Leave Request form is submit-only in the UI, but the
    RPC API can read every submission back: getMySubmissions({studentName,
    batch}) lists all of them (id/summary/date/status) and
    getSubmissionDetail({id}) returns the full record (name, batch,
    startDate, endDate, duration, leaveType, reason, role).

    Details are fetched incrementally: entries already present in the
    previous output file (keyed by submission id) are reused, only new ids
    are detail-fetched, capped at LEAVE_DETAIL_MAX_PER_RUN per run so the
    one-time historical backfill spreads over a few cron cycles. A record
    edited upstream after first fetch is NOT re-fetched (accepted trade-off).
    """
    existing = [l for l in _load_existing_leaves() if l.get("id")]
    known = {l["id"] for l in existing}
    subs = await _rpc(user_frame, "getMySubmissions", {"studentName": "", "batch": ""}, timeout_s=120)
    leave_subs = [s for s in subs or [] if s.get("formType") == "Leave Request" and s.get("id")]
    new_ids = [s["id"] for s in leave_subs if s["id"] not in known]
    fetched = []
    for lid in new_ids[:LEAVE_DETAIL_MAX_PER_RUN]:
        try:
            d = await _rpc(user_frame, "getSubmissionDetail", {"id": lid})
            if not (d and d.get("ok")):
                continue
            fl = d.get("fields") or {}
            fetched.append({
                "id": lid,
                "name": fl.get("name"),
                "batch": fl.get("batch"),
                "start": fl.get("startDate"),
                "end": fl.get("endDate"),
                "duration": fl.get("duration"),
                # leavesOnDate() consumers show `reason`; the human free-text
                # goes to `note` so the chip stays short.
                "reason": fl.get("leaveType") or "On Leave",
                "note": fl.get("reason") or "",
                "role": fl.get("role"),
            })
        except Exception as exc:
            print(f"WARNING: leave detail {lid} failed ({exc}) — retried next run", file=sys.stderr)
    remaining = len(new_ids) - min(len(new_ids), LEAVE_DETAIL_MAX_PER_RUN)
    leaves = existing + fetched
    leaves.sort(key=lambda l: (l.get("start") or "", l.get("name") or ""))
    print(f"Leaves: {len(existing)} cached + {len(fetched)} new = {len(leaves)}"
          + (f" ({remaining} still backfilling)" if remaining else ""))
    return leaves


def derive_resources(schedules, today_iso):
    """Rebuild the aircraft roster from the flight data itself.

    The OLD Ops Portal exposed a real fleet list (tail, acType, isMaint).
    The rebuilt portal (2026-07-10) has no readable equivalent — the Gantt's
    aircraft rows are derived from that day's flights and no global holds a
    roster (probed 2026-07-16) — so `resources` shipped permanently empty
    after the migration. That silently broke every consumer that picks
    candidate tails from RESOURCES: the Auto Slot Finder in CMD_CTR, CMDV2
    and CMDV3 found 0 slot combos for every SP (the 2026-07-16 incident).

    Closest reconstruction the new data allows:
    - one entry per distinct tail seen in any schedule entry (normalized
      output uses `tail`; raw pre-normalization uses `acReg` — accept both),
    - `acType` = the most common type recorded for that tail (robust against
      one-off data-entry errors like a flight type landing in the AC column),
    - `isMaint` when the tail has no booking on/after
      today - RESOURCE_ACTIVE_LOOKBACK_DAYS (future bookings count): a tail
      nobody has scheduled for 2+ weeks is effectively unavailable, which is
      the closest proxy left for the old maintenance flag.
    """
    last_seen = {}     # tail -> latest booking date
    type_counts = {}   # tail -> {acType: count}
    for date, entries in schedules.items():
        for e in entries:
            tail = e.get("tail") or e.get("acReg")
            if not tail or tail == "-":
                continue
            if date > last_seen.get(tail, ""):
                last_seen[tail] = date
            ac_type = e.get("type") or e.get("acType")
            if ac_type and ac_type != "-":
                counts = type_counts.setdefault(tail, {})
                counts[ac_type] = counts.get(ac_type, 0) + 1
    cutoff = (
        datetime.strptime(today_iso, "%Y-%m-%d").date()
        - timedelta(days=RESOURCE_ACTIVE_LOOKBACK_DAYS)
    ).isoformat()
    return [
        {
            "tail": tail,
            "acType": max(type_counts.get(tail, {"": 0}), key=type_counts.get(tail, {"": 0}).get),
            "isMaint": last_seen[tail] < cutoff,
        }
        for tail in sorted(last_seen)
    ]


async def _scrape_instructor_roster(user_frame):
    """Read the instructor roster from the Timeline view's own filter
    dropdown (#gantt-instructor) — the only fleet-adjacent roster the new
    portal still exposes. The old feed's per-instructor `type` field has no
    equivalent, so it's emitted as None. Non-fatal: a miss returns []."""
    try:
        names = await user_frame.evaluate(
            "() => [...document.querySelectorAll('#gantt-instructor option')]"
            ".map(o => o.textContent.trim())"
        )
        return [{"name": n, "type": None} for n in names if n and not n.lower().startswith("all ")]
    except Exception as exc:
        print(f"WARNING: instructor roster scrape failed ({exc!r}) — leaving empty", file=sys.stderr)
        return []


async def scrape_window(days_back, days_forward):
    """Fetch every date in [today-days_back, today+days_forward] from the
    Ops Portal, excluding any date already covered by the frozen pre-migration
    archive. Returns (schedules, failed_dates, rosters) where rosters is
    {"instructors": [...], "resources": [...]|None, "leaves": [...]}.

    The upstream GAS server is intermittently unreliable under repeated
    rapid requests (observed ~25% of single-date requests silently stall or
    error even with correct, trusted input events — this is the same "GAS
    cold-starts can be slow" flakiness the original scraper's retry logic
    was built for, just manifesting per-date now instead of per-run). A date
    that fails after DATE_FETCH_ATTEMPTS tries is skipped rather than
    aborting the whole run — the existing merge-with-previous-file logic
    keeps that date's last-known-good data, and since this runs every 5
    minutes in production, a skipped date gets retried again shortly.
    """
    today = datetime.now(timezone.utc).astimezone(ZoneInfo(TIMEZONE)).date()
    frozen_dates = _load_frozen_archive().keys()
    dates = [
        d for offset in range(-days_back, days_forward + 1)
        if (d := (today + timedelta(days=offset)).isoformat()) not in frozen_dates
    ]
    if frozen_dates:
        print(f"Skipping {len(frozen_dates)} frozen pre-migration date(s) — never re-fetched from the new portal.")

    schedules = {}
    failed_dates = []
    rosters = {"instructors": [], "resources": None, "leaves": _load_existing_leaves()}
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                )
            )
            page = await context.new_page()
            print(f"Navigating to {SCRIPT_URL} …")
            await page.goto(SCRIPT_URL, wait_until="networkidle", timeout=LOAD_TIMEOUT_MS)
            user_frame = await _get_content_frame(page)
            await _open_timeline_view(user_frame)

            # Rosters + leaves via the RPC API (each falls back independently)
            instructors_rpc, resources_rpc = await _fetch_rosters(user_frame, today.isoformat())
            rosters["instructors"] = instructors_rpc or await _scrape_instructor_roster(user_frame)
            rosters["resources"] = resources_rpc
            try:
                rosters["leaves"] = await _fetch_leaves(user_frame)
            except Exception as exc:
                print(f"WARNING: leaves fetch failed ({exc}) — keeping previous leaves", file=sys.stderr)

            for date_str in dates:
                last_err = None
                for attempt in range(1, DATE_FETCH_ATTEMPTS + 1):
                    try:
                        flights = await _fetch_one_date(page, user_frame, date_str)
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
        finally:
            await browser.close()

    if len(failed_dates) == len(dates):
        raise RuntimeError(f"All {len(dates)} dates failed — Ops Portal likely down or navigation broke")

    return schedules, failed_dates, rosters


def _report_schema_drift(warnings):
    """Surface schema drift as a GitHub Actions output so a (non-fatal)
    workflow step can open an issue. Non-fatal deliberately — new/unexpected
    fields or statuses shouldn't block a run, they should just get noticed
    instead of silently ignored (per the 2026-07-11 incident)."""
    if not warnings:
        return
    gh_output = os.environ.get("GITHUB_OUTPUT")
    gh_summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    body = "\n".join(f"- {w}" for w in warnings)
    if gh_output:
        with open(gh_output, "a", encoding="utf-8") as f:
            f.write("schema_drift=true\n")
            f.write("schema_drift_summary<<EOF\n")
            f.write(body + "\n")
            f.write("EOF\n")
    if gh_summary_path:
        with open(gh_summary_path, "a", encoding="utf-8") as f:
            f.write("## Ops Portal schema drift detected\n\n" + body + "\n")
    print(f"SCHEMA DRIFT: {len(warnings)} warning(s) — see step summary / issue.", file=sys.stderr)


async def main():
    schedules, failed_dates, rosters = await scrape_window(DAYS_BACK, DAYS_FORWARD)
    cache = {"schedules": schedules, "leaves": rosters["leaves"],
             "instructors": rosters["instructors"], "resources": rosters["resources"] or []}

    warnings, errors = validate_raw_cache(cache)
    if failed_dates:
        warnings.append(
            f"{len(failed_dates)} date(s) failed to fetch after {DATE_FETCH_ATTEMPTS} attempts "
            f"and were skipped (previous data for these dates, if any, is kept as-is): {failed_dates}"
        )
    for msg in warnings:
        print(f"WARNING: {msg}", file=sys.stderr)
    for msg in errors:
        print(f"ERROR: {msg}", file=sys.stderr)
    if errors:
        print(
            f"Schema validation failed ({len(errors)} error(s)). "
            "Data not saved — fix normalization before retrying.",
            file=sys.stderr,
        )
        sys.exit(1)

    new_schedules = {
        date: [normalize_entry(entry, date) for entry in entries]
        for date, entries in schedules.items()
    }

    # ── Merge with existing data ───────────────────────────────────────────────
    # Load the on-disk file (if any) so dates outside the rolling window are kept.
    # Dates present in the fresh fetch overwrite the stored version (newer = more
    # accurate statuses).  Dates only in the stored file are preserved as-is.
    BACKUP_FILE = OUTPUT_FILE.with_name("flight_schedule.backup.json")

    existing_schedules = {}
    if OUTPUT_FILE.exists():
        try:
            existing = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
            existing_schedules = existing.get("schedules", {})
        except Exception as e:
            print(f"WARNING: could not read existing file for merge: {e}", file=sys.stderr)

        try:
            BACKUP_FILE.write_bytes(OUTPUT_FILE.read_bytes())
        except Exception as e:
            print(f"WARNING: could not write backup: {e}", file=sys.stderr)

    # Regression guard: a date going from populated to (near-)empty in a
    # single fetch is far more likely to mean the Ops Portal silently
    # returned a bad/blocked response for that date (confirmed 2026-07-11:
    # GitHub Actions runner requests started coming back stable-but-empty for
    # every date in the window, worsening across consecutive runs, while
    # requests from a normal network succeeded fine — looks like IP-based
    # throttling of the Actions runner pool) than that a real schedule
    # dropped to near-zero bookings. _fetch_one_date()'s stability re-check
    # only proves a response was consistent, not that it was correct, so it
    # can't catch this on its own — compare against the last known-good
    # count instead. A date failing this check keeps its existing data.
    suspicious_dates = []
    for date, entries in list(new_schedules.items()):
        existing_count = len(existing_schedules.get(date, []))
        new_count = len(entries)
        if existing_count >= 5 and new_count < existing_count * 0.2:
            suspicious_dates.append((date, existing_count, new_count))
            del new_schedules[date]
    if suspicious_dates:
        drift_msg = (
            f"{len(suspicious_dates)} date(s) looked like a fetch regression "
            f"(existing→fresh count dropped sharply, likely a blocked/bad Ops Portal response "
            f"rather than a real schedule change) — kept existing data instead: "
            + ", ".join(f"{d} ({e}→{n})" for d, e, n in suspicious_dates)
        )
        print(f"WARNING: {drift_msg}", file=sys.stderr)
        warnings.append(drift_msg)

    _report_schema_drift(warnings)

    merged_schedules = {**existing_schedules, **new_schedules}

    new_dates  = set(new_schedules.keys())
    kept_dates = set(existing_schedules.keys()) - new_dates
    print(f"Fetched {sum(len(v) for v in new_schedules.values())} flights across {len(new_dates)} date(s).")
    if kept_dates:
        print(f"Preserved {len(kept_dates)} historical date(s) not in current window: "
              f"{', '.join(sorted(kept_dates))}")

    # Final override: frozen pre-migration dates always win, regardless of
    # what's in existing_schedules/new_schedules. scrape_window() already
    # excludes them from fetching, but this is the actual guarantee — even a
    # stale on-disk file, a bug elsewhere, or a future change to the fetch
    # window can't cause these dates to drift from the archived old-portal
    # data. See FROZEN_ARCHIVE_FILE.
    frozen = _load_frozen_archive()
    if frozen:
        merged_schedules.update(frozen)

    # Roster fields — primary source is the portal's internal RPC API
    # (getScheduleRegs + getStatusBoardData(today) for resources with the
    # real per-tail unavail/isMaint flag, getInstructors for instructors
    # with real types, getMySubmissions/getSubmissionDetail for leaves).
    # Resources fall back to derive_resources() (heuristic reconstruction
    # from flight data) when the RPC path fails.
    resources = rosters["resources"]
    if not resources:
        today_iso = datetime.now(timezone.utc).astimezone(ZoneInfo(TIMEZONE)).date().isoformat()
        resources = derive_resources(merged_schedules, today_iso)
        print(f"Derived {len(resources)} resources from flight data (RPC fallback).")
    print(f"Rosters: {len(resources)} resources "
          f"({sum(1 for r in resources if r.get('isMaint'))} isMaint), "
          f"{len(rosters['instructors'])} instructors, {len(rosters['leaves'])} leaves.")

    output = {
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timezone": TIMEZONE,
        "schedules": dict(sorted(merged_schedules.items())),  # chronological order
        "leaves": rosters["leaves"],
        "instructors": rosters["instructors"],
        "resources": resources,
    }

    total_count = sum(len(v) for v in output["schedules"].values())
    print(f"Total after merge: {total_count} flights across {len(output['schedules'])} date(s).")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved → {OUTPUT_FILE}")


async def main_with_retry():
    """Run main() up to MAX_ATTEMPTS times with exponential-ish backoff.

    Catches ANY exception, not just deliberate sys.exit() calls — the
    previous version only caught SystemExit, so an uncaught
    PlaywrightTimeoutError (e.g. from wait_for_selector) propagated straight
    past the retry loop and killed the run on attempt 1 every time, silently
    defeating the retry mechanism entirely (found investigating an 18-hour
    outage on 2026-07-10 that turned out to be caused by exactly this — see
    AP127_Docs README §10).
    """
    last_exc = None
    exit_code = 1
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            await main()
            return  # success
        except SystemExit as exc:
            if exc.code == 0:
                return
            last_exc = exc
            exit_code = exc.code if isinstance(exc.code, int) else 1
        except Exception as exc:
            last_exc = exc
            exit_code = 1

        if attempt < MAX_ATTEMPTS:
            wait = RETRY_DELAY_S * attempt
            print(
                f"Attempt {attempt}/{MAX_ATTEMPTS} failed ({last_exc!r}). "
                f"Retrying in {wait}s …",
                file=sys.stderr,
            )
            await asyncio.sleep(wait)
        else:
            print(
                f"All {MAX_ATTEMPTS} attempts failed ({last_exc!r}). Giving up.",
                file=sys.stderr,
            )
    sys.exit(exit_code)


if __name__ == "__main__":
    asyncio.run(main_with_retry())
