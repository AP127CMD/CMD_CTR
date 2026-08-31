"""
Converts data/flight_schedule.json → flight-data.js
Run: python3 scripts/generate_flight_data.py
"""

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC  = ROOT / "data" / "flight_schedule.json"
DEST = ROOT / "flight-data.js"
RECENT_DEST = ROOT / "flight-data-recent.js"

# 2026-08-16: watchdog-only pre-window, generous vs. the watchdog's own exact -3d/+14d window
# (AP127_V2/watchdog/src/window.js SNAPSHOT_LOOKBACK_MS/SNAPSHOT_LOOKAHEAD_MS) so this coarse
# date-only cut can never clip something the watchdog's own precise time-aware filter would keep.
RECENT_LOOKBACK_DAYS = 4
RECENT_LOOKAHEAD_DAYS = 15

# ─── Non-flight bookings (2026-08-31) ────────────────────────────────────────
# The Ops Portal schedules meetings and ground school in the SAME feed as real
# flights. They carry a durationMin and no aircraft, so every hours KPI
# downstream was counting a 3-hour CATC meeting or a 7.5-hour ground-school
# block as flight time (253.8 h of 9,632.6 h — 2.6% — across current history).
# User's call, 2026-08-31: exclude Ground School and Meetings from flight hours.
#
# `isNonFlight` is emitted per flight so consumers can drop these from HOURS
# while still SHOWING them on schedules — they're real calendar events, and
# CMDV2's p116 specifically fixed a bug that had hidden meeting rows.
#
# Two signals, deliberately:
#   1. `bookingKind` (MEETING/GROUND) — authoritative, but only populated on
#      fetches from 2026-08-31 onward.
#   2. A lesson-name fallback — REQUIRED for correctness, not belt-and-braces:
#      most history predates bookingKind, and everything on or before
#      2026-07-09 lives in flight_schedule.pre_migration_archive.json, which is
#      re-applied as an override every run and is therefore NEVER re-fetched.
#      Without this fallback the exclusion would silently miss ~all historical
#      meetings while appearing to work.
# The fallback is gated on "no aircraft at all" so a genuine flight whose
# lesson merely mentions a meeting can never be dropped.
_NON_FLIGHT_KINDS = {"MEETING", "GROUND"}
_MEETING_RE = re.compile(r"\bmeeting\b", re.I)
_GROUND_SCHOOL_RE = re.compile(r"\bground school\b", re.I)


def is_non_flight(f: dict) -> bool:
    """True for meetings / ground school — scheduled events that are not flights."""
    if (f.get("bookingKind") or "").upper() in _NON_FLIGHT_KINDS:
        return True
    if f.get("type") or f.get("tail"):
        return False  # has an aircraft -> it's a flight, whatever it's called
    lesson = f.get("lesson") or ""
    return bool(_MEETING_RE.search(lesson) or _GROUND_SCHOOL_RE.search(lesson))


def parse_dur(hhmm: str) -> int:
    if not hhmm:
        return 0
    parts = hhmm.split(":")
    return int(parts[0]) * 60 + int(parts[1]) if len(parts) == 2 else 0


def transform(raw: dict) -> dict:
    schedules = raw.get("schedules", {})
    flights = []

    for date, day_flights in schedules.items():
        for f in day_flights:
            flight_id = str(f.get("id") or f.get("rowIdx") or "")
            if f.get("isActual") and flight_id and not flight_id.startswith("ACTUAL_ONLY_"):
                flight_id = f"ACTUAL_ONLY_{flight_id}"

            dur_min = f.get("durationMin") or parse_dur(f.get("duration", ""))

            entry = {
                "id":         flight_id,
                "date":       f.get("date", date),
                "status":     f.get("status", "Pending"),
                "isSim":      bool(f.get("isSimulator", False)),
                "isStandby":  bool(f.get("isStandby", False)),
                "start":      f.get("start"),
                "end":        f.get("end"),
                "durMin":     dur_min,
                "duration":   f.get("duration", ""),
                "student":    f.get("student") or None,
                "instructor": f.get("instructor") or None,
                "batch":      f.get("batch", ""),
                "lesson":     f.get("lesson", ""),
                "cond":       f.get("condition") or None,
                "type":       f.get("type") or None,
                "tail":       f.get("tail") or None,
            }
            # Meetings / ground school: still shown on schedules, excluded from
            # flight-hours KPIs. Emitted only when true, to keep the ~2 MB feed
            # from growing a false flag on every one of ~5,800 real flights.
            if is_non_flight(f):
                entry["isNonFlight"] = True
            # recover_vanished_bookings() flag — only present (and only true) on Canceled
            # entries the scraper synthesized with no confirmed cancel reason found anywhere.
            # Watchdog uses this to render a distinct "Removed" notice instead of "Cancelled".
            if f.get("recovered"):
                entry["recovered"] = True

            # Operational data — only present on Completed flights
            if f.get("status") == "Completed":
                if f.get("tkoff")   is not None: entry["tkoff"]   = f["tkoff"]
                if f.get("ldgTime") is not None: entry["ldgTime"] = f["ldgTime"]
                if f.get("airborne")is not None: entry["airborne"]= f["airborne"]
                if f.get("to")      is not None: entry["to"]      = f["to"]
                if f.get("ldg")     is not None: entry["ldg"]     = f["ldg"]
                if f.get("inst")    is not None: entry["inst"]    = f["inst"]
                if f.get("blockOff")is not None: entry["blockOff"]= f["blockOff"]
                if f.get("blockOn") is not None: entry["blockOn"] = f["blockOn"]
            # Cancel reason/remarks — only present on Canceled flights, and
            # only once the matching Cancel Record has been detail-fetched
            # (incremental backfill in fetch_schedule.py — may lag briefly
            # behind a just-canceled flight).
            if f.get("status") == "Canceled":
                if f.get("cancelReason")  is not None: entry["cancelReason"]  = f["cancelReason"]
                if f.get("cancelRemarks") is not None: entry["cancelRemarks"] = f["cancelRemarks"]
            flights.append(entry)

    return {
        "fetchedAt":   raw.get("fetched_at") or raw.get("fetchedAt", ""),
        "tz":          raw.get("timezone") or raw.get("tz", "Asia/Bangkok"),
        "flights":     flights,
        "instructors": raw.get("instructors", []),
        "resources":   raw.get("resources", []),
        "leaves":      raw.get("leaves", []),
        # Cancellation audit log. Confirmed 2026-07-26: the new portal's live
        # Timeline never keeps a cancelled booking visible as status=Canceled
        # (it's removed/replaced instead) — only the pre-migration frozen
        # archive still has real Canceled schedule rows (the old portal DID
        # keep them visible). So cancelReason/cancelRemarks inlined on a
        # flight (below) will only ever be populated for those frozen dates;
        # this array is the actual source of "why was X canceled" for
        # anything after 2026-07-10.
        "cancellations": raw.get("cancelRecords", []),
    }


def _bkk_date_str(now_utc: datetime) -> str:
    # Mirrors AP127_V2/watchdog/src/window.js's bangkokDateStr() exactly (Bangkok is UTC+7, no DST).
    return (now_utc + timedelta(hours=7)).strftime("%Y-%m-%d")


# Produces a small, watchdog-ONLY feed: flights outside a generous rolling window are dropped
# before they're ever written to disk, and instructors/resources/leaves are omitted entirely
# (the watchdog never reads them — confirmed by grep across AP127_V2/watchdog/src/). Cancellations
# are kept in full (unwindowed) — they're a small array (hundreds, not thousands) and the watchdog
# only ever looks one up by an id that's already in its own windowed snapshot, so a cancellation
# outside the window can never match anything anyway; windowing it too would save nothing.
# See the test file's header comment for the "why this exists" incident history.
def filter_recent(data: dict, now_utc: datetime) -> dict:
    lower = (now_utc - timedelta(days=RECENT_LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    upper = (now_utc + timedelta(days=RECENT_LOOKAHEAD_DAYS)).strftime("%Y-%m-%d")
    return {
        "fetchedAt": data.get("fetchedAt", ""),
        "tz": data.get("tz", "Asia/Bangkok"),
        "flights": [f for f in data.get("flights", []) if lower <= f.get("date", "") <= upper],
        "cancellations": data.get("cancellations", []),
    }


def main():
    raw = json.loads(SRC.read_text())
    data = transform(raw)
    js = f"// Auto-generated from data/flight_schedule.json — do not edit directly\nwindow.FLIGHT_DATA = {json.dumps(data, ensure_ascii=False, separators=(',', ':'))};\n"
    DEST.write_text(js)
    n = len(data["flights"])
    print(f"✓ flight-data.js written — {n} flights across {len(set(f['date'] for f in data['flights']))} dates")

    # Watchdog-only slim feed (see filter_recent's docstring) — cuts the file ap127-watchdog
    # fetches+parses every 5 min from 2+ MB / 5000+ flights down to a rolling window's worth,
    # fixing the recurring "Exceeded CPU Limit" incidents on its Workers Free plan.
    recent = filter_recent(data, datetime.now(timezone.utc))
    recent_js = (
        "// Auto-generated from data/flight_schedule.json — watchdog-only, filtered to a rolling "
        f"-{RECENT_LOOKBACK_DAYS}d/+{RECENT_LOOKAHEAD_DAYS}d window. Do not edit directly, and do "
        "not point any other consumer at this file — it deliberately omits instructors/resources/"
        "leaves and only carries a partial flight history. See AP127_V2/watchdog/CLAUDE.md.\n"
        f"window.FLIGHT_DATA = {json.dumps(recent, ensure_ascii=False, separators=(',', ':'))};\n"
    )
    RECENT_DEST.write_text(recent_js)
    print(f"✓ flight-data-recent.js written — {len(recent['flights'])} flights (watchdog window)")


if __name__ == "__main__":
    main()
