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

# 2026-07-27: the regression guard below (added 2026-07-11) had no escape hatch — once a date
# tripped it, `existing_schedules[date]` never gets refreshed again (each run compares fresh data
# against that same frozen baseline), so a date stuck this way can NEVER self-correct, even long
# after whatever originally caused the bad reads has cleared up. Confirmed live: 2026-07-31 got
# wedged at "30 flights, all Canceled" starting ~12:40 that day and stayed wedged for hours,
# continuing to reject every single fresh fetch even after the actual cause (overlapping scraper
# runs racing on the same output file, see fetch_schedule.yml's concurrency fix) was resolved,
# because the guard itself has no way back once triggered. A real Ops Portal check confirmed the
# frozen data was wrong — the live schedule genuinely had 30 Pending flights, not Canceled.
# REGRESSION_GUARD_MAX_STREAK consecutive rejections for the same date now forces acceptance of
# the fresh (low) data instead of freezing forever — still absorbs the kind of short-lived,
# worsening-then-clearing throttling blip the guard was originally built for (2026-07-11), but no
# longer gets permanently stuck once that blip's cause is gone.
REGRESSION_GUARD_MAX_STREAK = int(os.environ.get("FETCH_REGRESSION_GUARD_MAX_STREAK", "3"))

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
# `actual` appears only on Completed flights (post-flight record; found
# 2026-07-16 — the migration notes' "gone for good" verdict on actuals was
# wrong for the read views after all). Optional, never required.
KNOWN_ENTRY_FIELDS = REQUIRED_ENTRY_FIELDS | {"actual"}

# Inner fields of `actual` observed 2026-07-16 (Timeline View, window.G).
# Times (blockOff/blockOn/takeoff/landing) are "HH:MM"; tis/duration are
# "H:MM" durations; numTakeoffs/numLandings/instApp are ints. A new inner
# field is drift worth a warning, same as a new top-level field.
KNOWN_ACTUAL_FIELDS = {
    "numTakeoffs", "blockOff", "routeFrom", "takeoff", "lesson", "remark",
    "flightType", "leg", "duration", "landing", "routeTo", "numLandings",
    "instructor", "blockOn", "instApp", "acReg", "acType", "tis",
}

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

            actual = entry.get("actual")
            if actual is not None:
                if isinstance(actual, dict):
                    extra_actual = set(actual) - KNOWN_ACTUAL_FIELDS
                    if extra_actual:
                        new_fields.update(f"actual.{f}" for f in extra_actual)
                else:
                    errors.append(f"{ref}: 'actual' is not a dict (got {type(actual).__name__})")

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


def _int_or_none(value):
    """Coerce to int, or None if missing/unparseable. Unlike a bare `or`,
    keeps a genuine 0 (e.g. zero instrument approaches)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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


def normalize_entry(entry, date, cancel_lookup=None):
    """
    Return a normalized schedule entry ready for dashboard consumption.

    The new Ops Portal (migrated ~2026-07-10) has a materially simpler data
    model than the old one: one canonical record per booking whose `status`
    tracks lifecycle (Pending -> Completed/Canceled), instead of the old dual
    planned+actual row pair keyed by rowIdx/realRowIdx. Fields that depended
    on that old model (isActual, planDur, rowIdx/realRowIdx as distinct
    concepts) are kept in the output shape for backward compatibility but are
    always None/derived.

    cancelReason turned out NOT to be gone either (corrected 2026-07-26 —
    see AP127_Docs README §10): Cancel Record submissions are readable via
    the portal RPC API (getMySubmissions/getSubmissionDetail, same as
    leaves) and echo back `reason` + free-text `remarks`. `cancel_lookup`
    (bookingId -> {"reason", "remarks"}, built from the cached cancel-records
    list — see _fetch_cancel_records()) supplies it here for Canceled flights.

    CORRECTED same day (2026-07-26): earlier revisions of this docstring
    claimed the live portal never returns status=Canceled directly — that
    was wrong, just incomplete investigation. The Timeline has a THIRD mode
    tab ("❌ Canceled", #gantt-mode-canceled) nobody had clicked before,
    which returns the complete real cancelled-booking list for a date (full
    time slot, instructor, aircraft — ground truth, not a guess). Plan mode
    (the default, and the only mode anyone had ever scraped) genuinely never
    includes cancelled bookings — that part was correct — but that's an
    artifact of which mode was being read, not a portal limitation. See
    getStudentSchedule (see docs/superpowers/specs/2026-07-27-rpc-based-schedule-
    fetch-design.md — replaced the Timeline-based fetch entirely, 2026-07-27)
    returns Canceled entries inline for every date. This join still matters
    for those entries: they arrive with status=Canceled but no reason — Cancel
    Record submissions are a wholly separate form/store.

    Post-flight actuals, however, turned out NOT to be gone: since (at least)
    2026-07-16 Completed flights carry an `actual{}` object on window.G
    (blockOff/blockOn, takeoff/landing, tis, numTakeoffs/numLandings, instApp,
    route, remark, …). It's mapped back onto the old output field names below
    (tkoff/ldgTime/airborne/to/ldg/inst/actualType) so the frontends'
    conditional actual-detail drawers light up again. Display detail ONLY —
    all hours KPIs/calculations stay block time (durMin), never airborne/tis
    (project rule, r43).
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

    # Post-flight actuals (Completed flights only — see docstring). Counters
    # use _int_or_none, not `or`: 0 takeoffs/landings/approaches is real data.
    actual = entry.get("actual")
    if not isinstance(actual, dict):
        actual = {}

    cancel = (cancel_lookup or {}).get(str(booking_id)) if status == "Canceled" else None

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
        # actuals — from the portal's per-flight actual{} (Completed only),
        # mapped back onto the pre-migration field names. airborne (tis) is
        # display detail only — hours KPIs stay block time (durMin).
        "actualType": _null_dash(actual.get("acType") or ""),
        "tkoff": _null_dash(actual.get("takeoff") or ""),
        "ldgTime": _null_dash(actual.get("landing") or ""),
        "airborne": _null_dash(_zero_pad_duration(actual.get("tis") or "")),
        "ldg": _int_or_none(actual.get("numLandings")),
        "to": _int_or_none(actual.get("numTakeoffs")),
        "inst": _int_or_none(actual.get("instApp")),
        # actual block times — no pre-migration equivalent (old feed only had
        # scheduled start/end); new fields, may differ from start/end
        "blockOff": _null_dash(actual.get("blockOff") or ""),
        "blockOn": _null_dash(actual.get("blockOn") or ""),
        # cancellation — from the matching Cancel Record submission, joined
        # by bookingId (see cancel_lookup docstring above). Both None if no
        # Cancel Record has been fetched yet for this booking (backfill in
        # progress) or the flight isn't Canceled.
        "cancelReason": (cancel or {}).get("reason"),
        "cancelRemarks": (cancel or {}).get("remarks"),
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


async def _return_to_home(page, user_frame, max_clicks=4):
    """Click '‹ Back' repeatedly until the Home menu (with its "Timeline
    View" card) is reachable, then confirm by actually opening it.

    Needed because navigation depth varies by caller: Timeline is one click
    from Home, but a sub-form like Leave Request is two (Submit Forms menu
    -> the form itself). A single fixed-depth "click Back once" assumption
    broke exactly this way in practice (2026-07-26): after
    _capture_expensive_fingerprint() finished on the Leave Request form
    (two levels deep), one Back click landed on the Submit Forms menu, not
    Home, and the subsequent `_open_timeline_view()` call timed out
    because "Timeline View" text doesn't exist there — which then cascaded
    into the whole date-loop failing, since Timeline was never re-opened.
    """
    for _ in range(max_clicks):
        try:
            await _open_timeline_view(user_frame)
            return
        except Exception:
            pass
        back = user_frame.get_by_text("‹ Back")
        if not await back.count():
            break
        try:
            await back.first.click(timeout=8000)
            await page.wait_for_timeout(1000)
        except Exception:
            break
    # Last attempt — let the real error surface with a clear message if
    # even this doesn't recover.
    await _open_timeline_view(user_frame)


DATE_FETCH_ATTEMPTS = int(os.environ.get("FETCH_DATE_ATTEMPTS", "3"))


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

# Same pattern for Cancel Record backfill (~340 historical cancels).
CANCEL_DETAIL_MAX_PER_RUN = int(os.environ.get("CANCEL_DETAIL_MAX_PER_RUN", "60"))


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


# Primary schedule fetch (replaces Timeline DOM mode-switching) — see docs/superpowers/specs/2026-07-27-rpc-based-schedule-fetch-design.md.
RPC_FETCH_TIMEOUT_S = int(os.environ.get("FETCH_RPC_TIMEOUT_S", "45"))


async def _fetch_schedule_for_date(user_frame, date_str, timeout_s=None):
    """Fetch one date's schedule via getStudentSchedule; raises on RPC failure or mismatched-date response (both loud, retriable by caller)."""
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


# ─── Portal structure drift detection ────────────────────────────────────────
# Complementary to validate_raw_cache() (which catches DATA-shape drift —
# new/missing fields on schedule entries, new statuses, new booking-id
# prefixes): this catches STRUCTURAL drift in the portal itself — its RPC
# surface, UI mode tabs, form field options. Built 2026-07-26 after a
# comprehensive audit (prompted by the user noting the portal "changes
# frequently") turned up 6 RPC functions that hadn't existed on 2026-07-16 —
# proof this class of change happens and was going undetected. Reuses the
# existing schema-drift GitHub-issue mechanism (_report_schema_drift) rather
# than inventing a separate alerting path.
PORTAL_FINGERPRINT_FILE = Path(__file__).parent.parent / "data" / "portal_fingerprint.json"

# How often to run the expensive checks (Submit Forms field options, Daily
# Schedule presence) — these need real extra navigation (back -> Submit
# Forms -> each sub-form -> back) on top of the normal scrape, unlike the
# RPC-list/Timeline-modes checks which are one JS eval each on a frame
# that's already open. Changes here are rare (this session found the
# Cancel Flight reason list and Timeline mode tabs unchanged since first
# documented; only a routine new batch value showed up), so running the
# expensive half once a day rather than every 5-minute cron tick is a
# deliberate cost/fragility tradeoff, not an oversight.
STRUCTURE_CHECK_INTERVAL_HOURS = int(os.environ.get("STRUCTURE_CHECK_INTERVAL_HOURS", "24"))

# Known-volatile fields intentionally NOT diffed here even though they're
# captured: batch/student/instructor lists grow routinely as new cohorts
# start (confirmed 2026-07-26: a new "PPL-38" batch appeared between two
# audits, expected growth, not drift) — alerting on every addition would
# make the mechanism noisy enough to get ignored, defeating its purpose.


def _load_portal_fingerprint():
    if not PORTAL_FINGERPRINT_FILE.exists():
        return {}
    try:
        return json.loads(PORTAL_FINGERPRINT_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


async def _capture_cheap_fingerprint(user_frame):
    """RPC function list + Timeline mode tabs. Near-zero cost — no
    navigation, the Timeline frame is already open — safe to run every
    scrape."""
    names = await user_frame.evaluate(
        "() => Object.keys(google.script.run).filter(k => typeof google.script.run[k]==='function').sort()"
    )
    modes = await user_frame.evaluate("""() => {
      const vis = el => !!(el.offsetParent);
      return ['gantt-mode-plan','gantt-mode-actual','gantt-mode-canceled']
        .filter(id => { const e = document.getElementById(id); return e && vis(e); });
    }""")
    return {"rpc_functions": names, "timeline_modes": modes}


async def _capture_expensive_fingerprint(page, user_frame):
    """Submit Forms field options (Cancel Flight reasons, Leave Request
    types) + Daily Schedule presence. Requires navigating away from
    Timeline and back — throttled by STRUCTURE_CHECK_INTERVAL_HOURS (see
    above), never run mid-date-loop. Each piece is independently
    best-effort: a failure here means "couldn't confirm this run", not "the
    portal is broken" — it doesn't affect the main schedule scrape at all."""
    result = {}
    try:
        back = user_frame.get_by_text("‹ Back")
        if await back.count():
            await back.first.click(timeout=8000)
            await page.wait_for_timeout(1200)
        await user_frame.get_by_text("View Daily Schedule").click(timeout=10_000)
        await user_frame.wait_for_selector("#sched-date", timeout=10_000)
        result["daily_schedule_present"] = True
    except Exception as exc:
        result["daily_schedule_present"] = False
        print(f"WARNING: portal-structure check could not confirm Daily Schedule ({exc}) — "
              f"treating as absent this run, will re-check next scheduled check", file=sys.stderr)

    try:
        back = user_frame.get_by_text("‹ Back")
        if await back.count():
            await back.first.click(timeout=8000)
            await page.wait_for_timeout(1200)
        await user_frame.get_by_text("Submit Forms", exact=True).click(timeout=10_000)
        await page.wait_for_timeout(1200)

        await user_frame.get_by_text("Cancel Flight", exact=False).first.click(timeout=8000)
        await page.wait_for_timeout(1000)
        result["cancel_reasons"] = await user_frame.evaluate(
            "() => [...document.querySelectorAll('#cx-reason option')].map(o=>o.textContent.trim())"
        )

        back = user_frame.get_by_text("‹ Back")
        if await back.count():
            await back.first.click(timeout=8000)
            await page.wait_for_timeout(1000)
        # Precise leaf-text match — a plain substring/get_by_text("Leave
        # Request") also matches the menu's own subtitle paragraph
        # ("Flight record, cancel, leave request, edit request"), which
        # sits earlier in the DOM and silently absorbs the click instead.
        await user_frame.evaluate("""() => {
          const els = [...document.querySelectorAll('*')].filter(e =>
            e.children.length === 0 && e.textContent.trim() === 'Leave Request');
          if (els.length) els[0].click();
        }""")
        await page.wait_for_timeout(1000)
        result["leave_types"] = await user_frame.evaluate(
            "() => [...document.querySelectorAll('#lv-type option')].map(o=>o.textContent.trim())"
        )
    except Exception as exc:
        print(f"WARNING: portal-structure check could not confirm Submit Forms fields ({exc}) — "
              f"skipping this run's form-option comparison, will re-check next scheduled check", file=sys.stderr)

    return result


async def check_portal_structure(page, user_frame):
    """Detect Ops Portal structural drift and persist a fingerprint for the
    next run to diff against. Returns a list of human-readable warning
    strings (empty if nothing changed, or if this is the first run and
    there's no prior fingerprint to compare against yet — establishing the
    baseline isn't itself drift). Warnings feed into the same
    _report_schema_drift() GitHub-issue mechanism as data-shape drift, so a
    real portal change surfaces the same way an unexpected field does: a
    non-blocking, deduped issue, not a silent break someone finds out about
    the hard way (as happened with the RPC function list — see comment
    above this section).
    """
    warnings = []
    prev = _load_portal_fingerprint()
    first_run = not prev
    fingerprint = dict(prev)  # start from prior state; only overwrite what we actually re-check this run

    cheap = await _capture_cheap_fingerprint(user_frame)
    if not first_run:
        prev_rpc, cur_rpc = set(prev.get("rpc_functions") or []), set(cheap["rpc_functions"])
        if prev_rpc != cur_rpc:
            added, removed = sorted(cur_rpc - prev_rpc), sorted(prev_rpc - cur_rpc)
            msg = "Ops Portal RPC function list changed since last check"
            if added: msg += f" — added: {added}"
            if removed: msg += f" — REMOVED (check nothing we call depends on these): {removed}"
            warnings.append(msg)
        prev_modes, cur_modes = set(prev.get("timeline_modes") or []), set(cheap["timeline_modes"])
        if prev_modes != cur_modes:
            warnings.append(f"Timeline mode tabs changed: was {sorted(prev_modes)}, now {sorted(cur_modes)}")
    fingerprint.update(cheap)

    due = True
    last_checked = prev.get("_expensive_checked_at")
    if last_checked:
        try:
            last_dt = datetime.strptime(last_checked, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            due = (datetime.now(timezone.utc) - last_dt) >= timedelta(hours=STRUCTURE_CHECK_INTERVAL_HOURS)
        except Exception:
            due = True
    if due:
        expensive = await _capture_expensive_fingerprint(page, user_frame)
        expensive["_expensive_checked_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if not first_run:
            if prev.get("daily_schedule_present") is not None and \
               prev["daily_schedule_present"] != expensive.get("daily_schedule_present"):
                warnings.append("Daily Schedule view presence changed: "
                                 f"was {prev['daily_schedule_present']}, now {expensive.get('daily_schedule_present')}")
            if prev.get("cancel_reasons") is not None and "cancel_reasons" in expensive and \
               set(prev["cancel_reasons"]) != set(expensive["cancel_reasons"]):
                warnings.append(f"Cancel Flight reason options changed: "
                                 f"was {prev['cancel_reasons']}, now {expensive['cancel_reasons']}")
            if prev.get("leave_types") is not None and "leave_types" in expensive and \
               set(prev["leave_types"]) != set(expensive["leave_types"]):
                warnings.append(f"Leave Request type options changed: "
                                 f"was {prev['leave_types']}, now {expensive['leave_types']}")
        fingerprint.update(expensive)
        # _capture_expensive_fingerprint ends on the Leave Request FORM —
        # two navigation levels below Home (Submit Forms menu -> the form),
        # not one — so a single fixed "click Back once" doesn't reach Home.
        # _return_to_home() clicks Back repeatedly until Timeline is
        # actually reachable, whatever the real depth turns out to be.
        try:
            await _return_to_home(page, user_frame)
        except Exception as exc:
            print(f"WARNING: could not return to Timeline View after the structure check ({exc}) — "
                  f"the date-loop fetch immediately after this will likely fail and retry", file=sys.stderr)

    try:
        PORTAL_FINGERPRINT_FILE.parent.mkdir(parents=True, exist_ok=True)
        PORTAL_FINGERPRINT_FILE.write_text(json.dumps(fingerprint, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        print(f"WARNING: could not persist portal fingerprint ({exc}) — "
              f"structure drift check will re-establish baseline next run", file=sys.stderr)

    if first_run:
        print("Portal-structure fingerprint established (first run) — nothing to compare against yet.")
    elif not warnings:
        print("Portal-structure check: no drift detected"
              + ("" if due else f" (RPC/Timeline only — Submit Forms check not due yet)") + ".")
    return warnings


def _load_existing_cancel_records():
    if not OUTPUT_FILE.exists():
        return []
    try:
        return json.loads(OUTPUT_FILE.read_text(encoding="utf-8")).get("cancelRecords") or []
    except Exception:
        return []


async def _fetch_cancel_records(user_frame):
    """Rebuild cancel-reason data from Cancel Record submissions.

    Corrected 2026-07-26: normalize_entry()'s cancelReason=None comment said
    this was unavailable (checked pre-RPC-API-discovery, 2026-07-11) — it
    isn't. Same read path as leaves: getMySubmissions lists every Cancel
    Record (id/summary/date/status), getSubmissionDetail({id}) returns the
    full record (date, reason, remarks, instructor, student, batch, lesson,
    acType, acReg, bookingId). Cached and backfilled incrementally exactly
    like _fetch_leaves() (same submission-id-keyed cache, same per-run cap,
    same accepted trade-off on upstream edits after first fetch) — see that
    function's docstring.
    """
    existing = [c for c in _load_existing_cancel_records() if c.get("id")]
    known = {c["id"] for c in existing}
    subs = await _rpc(user_frame, "getMySubmissions", {"studentName": "", "batch": ""}, timeout_s=120)
    cancel_subs = [s for s in subs or [] if s.get("formType") == "Cancel Record" and s.get("id")]
    new_ids = [s["id"] for s in cancel_subs if s["id"] not in known]
    fetched = []
    for cid in new_ids[:CANCEL_DETAIL_MAX_PER_RUN]:
        try:
            d = await _rpc(user_frame, "getSubmissionDetail", {"id": cid})
            if not (d and d.get("ok")):
                continue
            fl = d.get("fields") or {}
            booking_id = fl.get("bookingId")
            if not booking_id:
                continue
            fetched.append({
                "id": cid,
                "bookingId": str(booking_id),
                "date": fl.get("date"),
                "reason": fl.get("reason"),
                "remarks": fl.get("remarks") or "",
                "instructor": fl.get("instructor"),
                "student": fl.get("student"),
                "batch": fl.get("batch"),
                "lesson": fl.get("lesson"),
                "acType": fl.get("acType"),
                "acReg": fl.get("acReg"),
            })
        except Exception as exc:
            print(f"WARNING: cancel-record detail {cid} failed ({exc}) — retried next run", file=sys.stderr)
    remaining = len(new_ids) - min(len(new_ids), CANCEL_DETAIL_MAX_PER_RUN)
    records = existing + fetched
    records.sort(key=lambda c: (c.get("date") or "", c.get("bookingId") or ""))
    print(f"Cancel records: {len(existing)} cached + {len(fetched)} new = {len(records)}"
          + (f" ({remaining} still backfilling)" if remaining else ""))
    return records


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
    archive. Returns (schedules, failed_dates, rosters, structure_warnings)
    where rosters is {"instructors": [...], "resources": [...]|None,
    "leaves": [...]} and structure_warnings is a list of human-readable
    Ops Portal structural-drift strings from check_portal_structure()
    (empty if nothing changed).

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
    rosters = {"instructors": [], "resources": None, "leaves": _load_existing_leaves(),
               "cancelRecords": _load_existing_cancel_records()}
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

            structure_warnings = []
            try:
                structure_warnings = await check_portal_structure(page, user_frame)
                for w in structure_warnings:
                    print(f"WARNING: {w}", file=sys.stderr)
            except Exception as exc:
                print(f"WARNING: portal-structure check itself failed ({exc}) — "
                      f"skipping this run, will retry next scheduled check", file=sys.stderr)

            # Rosters + leaves via the RPC API (each falls back independently)
            instructors_rpc, resources_rpc = await _fetch_rosters(user_frame, today.isoformat())
            rosters["instructors"] = instructors_rpc or await _scrape_instructor_roster(user_frame)
            rosters["resources"] = resources_rpc
            try:
                rosters["leaves"] = await _fetch_leaves(user_frame)
            except Exception as exc:
                print(f"WARNING: leaves fetch failed ({exc}) — keeping previous leaves", file=sys.stderr)
            try:
                rosters["cancelRecords"] = await _fetch_cancel_records(user_frame)
            except Exception as exc:
                print(f"WARNING: cancel-records fetch failed ({exc}) — keeping previous cancel records", file=sys.stderr)

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

        finally:
            await browser.close()

    if len(failed_dates) == len(dates):
        raise RuntimeError(f"All {len(dates)} dates failed — Ops Portal likely down or navigation broke")

    return schedules, failed_dates, rosters, structure_warnings


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
    schedules, failed_dates, rosters, structure_warnings = await scrape_window(DAYS_BACK, DAYS_FORWARD)
    cache = {"schedules": schedules, "leaves": rosters["leaves"],
             "instructors": rosters["instructors"], "resources": rosters["resources"] or []}

    warnings, errors = validate_raw_cache(cache)
    warnings.extend(structure_warnings)
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

    cancel_lookup = {
        c["bookingId"]: {"reason": c.get("reason"), "remarks": c.get("remarks")}
        for c in rosters["cancelRecords"] if c.get("bookingId")
    }
    new_schedules = {
        date: [normalize_entry(entry, date, cancel_lookup) for entry in entries]
        for date, entries in schedules.items()
    }

    # ── Merge with existing data ───────────────────────────────────────────────
    # Load the on-disk file (if any) so dates outside the rolling window are kept.
    # Dates present in the fresh fetch overwrite the stored version (newer = more
    # accurate statuses).  Dates only in the stored file are preserved as-is.
    BACKUP_FILE = OUTPUT_FILE.with_name("flight_schedule.backup.json")

    existing_schedules = {}
    regression_streaks = {}
    if OUTPUT_FILE.exists():
        try:
            existing = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
            existing_schedules = existing.get("schedules", {})
            regression_streaks = existing.get("_regressionStreaks", {})
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
    # dropped to near-zero bookings — a per-date fetch succeeding proves the
    # response was consistent, not that it was correct, so it can't catch
    # this on its own — compare against the last known-good
    # count instead. A date failing this check keeps its existing data —
    # UNLESS it's failed REGRESSION_GUARD_MAX_STREAK times in a row (see the
    # constant's comment: fixed 2026-07-27 — the guard used to have no way
    # back once triggered, so a date could get permanently wedged on stale
    # data long after whatever caused the bad reads had cleared up).
    suspicious_dates = []
    forced_accepts = []
    new_regression_streaks = {}
    for date, entries in list(new_schedules.items()):
        existing_count = len(existing_schedules.get(date, []))
        new_count = len(entries)
        if existing_count >= 5 and new_count < existing_count * 0.2:
            streak = regression_streaks.get(date, 0) + 1
            if streak >= REGRESSION_GUARD_MAX_STREAK:
                # Escape hatch: this many consecutive low reads means it's persistent, not a
                # transient blip — trust the fresh data (whatever it is) and let it through.
                # Streak intentionally NOT carried into new_regression_streaks — resets to 0.
                forced_accepts.append((date, existing_count, new_count, streak))
            else:
                suspicious_dates.append((date, existing_count, new_count, streak))
                del new_schedules[date]
                new_regression_streaks[date] = streak
        # else: date passed the check this run — streak resets to 0 (not carried forward).
    regression_streaks = new_regression_streaks
    if suspicious_dates:
        drift_msg = (
            f"{len(suspicious_dates)} date(s) looked like a fetch regression "
            f"(existing→fresh count dropped sharply, likely a blocked/bad Ops Portal response "
            f"rather than a real schedule change) — kept existing data instead: "
            + ", ".join(f"{d} ({e}→{n}, streak {s}/{REGRESSION_GUARD_MAX_STREAK})"
                        for d, e, n, s in suspicious_dates)
        )
        print(f"WARNING: {drift_msg}", file=sys.stderr)
        warnings.append(drift_msg)
    if forced_accepts:
        accept_msg = (
            f"{len(forced_accepts)} date(s) hit {REGRESSION_GUARD_MAX_STREAK} consecutive "
            f"low reads — accepting the fresh data instead of freezing forever: "
            + ", ".join(f"{d} ({e}→{n})" for d, e, n, s in forced_accepts)
        )
        print(f"WARNING: {accept_msg}", file=sys.stderr)
        warnings.append(accept_msg)

    _report_schema_drift(warnings)

    merged_schedules = {**existing_schedules, **new_schedules}

    # Backfill cancelReason/cancelRemarks onto Canceled flights normalized by
    # a PRIOR run (before this field existed, or before the matching Cancel
    # Record had been detail-fetched yet) — covers preserved historical dates
    # too, not just the current fetch window. Idempotent: only touches
    # entries that don't already have a cancelReason.
    cancel_filled = 0
    for entries in merged_schedules.values():
        for entry in entries:
            if entry.get("status") == "Canceled" and not entry.get("cancelReason"):
                info = cancel_lookup.get(entry.get("id"))
                if info:
                    entry["cancelReason"] = info.get("reason")
                    entry["cancelRemarks"] = info.get("remarks")
                    cancel_filled += 1
    if cancel_filled:
        print(f"Backfilled cancelReason on {cancel_filled} previously-normalized Canceled flight(s).")

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
          f"{len(rosters['instructors'])} instructors, {len(rosters['leaves'])} leaves, "
          f"{len(rosters['cancelRecords'])} cancel records.")

    output = {
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timezone": TIMEZONE,
        "schedules": dict(sorted(merged_schedules.items())),  # chronological order
        "leaves": rosters["leaves"],
        "instructors": rosters["instructors"],
        "resources": resources,
        # backfill cache only — not surfaced in flight-data.js; cancelReason/
        # cancelRemarks are already inlined onto each Canceled schedule entry.
        "cancelRecords": rosters["cancelRecords"],
        # Regression-guard state (see REGRESSION_GUARD_MAX_STREAK) — internal bookkeeping only,
        # not surfaced in flight-data.js. Only ever holds dates currently mid-streak; a date that
        # passed its check (or wasn't fetched this run) is simply absent, not zeroed.
        "_regressionStreaks": regression_streaks,
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
