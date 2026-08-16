from datetime import datetime, timezone

import generate_flight_data as gfd


def _raw(entry_overrides):
    entry = {
        "id": "BK-1", "date": "2026-08-07", "status": "Canceled",
        "start": "08:00", "end": "09:30", "student": "S", "instructor": "I",
        "batch": "AP-127", "lesson": "L", "condition": "Nav", "type": "DA40CS", "tail": "HS-TVC",
        "durationMin": 90, "duration": "01:30",
    }
    entry.update(entry_overrides)
    return {"schedules": {"2026-08-07": [entry]}, "fetched_at": "2026-08-07T00:00:00Z"}


def test_recovered_true_is_passed_through():
    out = gfd.transform(_raw({"recovered": True}))
    assert out["flights"][0]["recovered"] is True


def test_recovered_false_is_omitted_not_passed_as_false():
    out = gfd.transform(_raw({"recovered": False}))
    assert "recovered" not in out["flights"][0]


def test_missing_recovered_field_is_omitted():
    out = gfd.transform(_raw({}))
    assert "recovered" not in out["flights"][0]


# --- filter_recent: the watchdog-only, small pre-windowed feed (2026-08-16) -----------------
#
# Fixes the recurring "Exceeded CPU Limit" incidents on ap127-watchdog (Cloudflare Workers Free
# plan, hard ~10ms/invocation CPU cap): the watchdog only ever needs a rolling window of the feed
# (see AP127_V2/watchdog/src/window.js — SNAPSHOT_LOOKBACK_MS/SNAPSHOT_LOOKAHEAD_MS), but was
# paying to `JSON.parse` the ENTIRE feed (5000+ flights, 2+ MB and growing) every 5 minutes just
# to filter it down afterward. A JS-side "extract only the window's bytes" attempt was tried and
# measured *slower* than a plain full JSON.parse (V8's native parser beats a hand-rolled JS scan
# of comparable size) — see the AP127_V2/watchdog git history around 2026-08-16 for that dead end.
# The fix that actually works: do the filtering HERE, once, in Python, where CPU is free — write a
# second, small `flight-data-recent.js` alongside the existing full one, and point the watchdog at
# it instead. `main()` still writes the full file unchanged for every other consumer.
NOW = datetime(2026, 8, 16, 7, 0, 0, tzinfo=timezone.utc)  # 2026-08-16 14:00 Asia/Bangkok


def _flight(id_, date, **overrides):
    f = {
        "id": id_, "date": date, "status": "Pending", "isSim": False, "isStandby": False,
        "start": "08:00", "end": "09:00", "durMin": 60, "duration": "01:00",
        "student": "SOME S.", "instructor": "SOME I.", "batch": "AP-127",
        "lesson": "CDGL 01", "cond": None, "type": "DA40TDI", "tail": "HS-TPT",
    }
    f.update(overrides)
    return f


def _cancellation(id_, date):
    return {
        "id": id_, "bookingId": f"BK-{id_}", "date": date, "reason": "Weather (WX)",
        "remarks": "", "instructor": "SOME I.", "student": "SOME S.", "batch": "AP-127",
        "lesson": "CDGL 01", "acType": "DA40TDI", "acReg": "HS-TPT",
    }


def _transformed(flights=(), cancellations=()):
    return {
        "fetchedAt": "2026-08-16T07:00:00Z", "tz": "Asia/Bangkok",
        "flights": list(flights), "instructors": [{"id": "I1"}], "resources": [{"id": "R1"}],
        "leaves": [{"id": "L1"}], "cancellations": list(cancellations),
    }


def test_filter_recent_keeps_flights_inside_the_window():
    f = _flight("IN-1", "2026-08-16")
    out = gfd.filter_recent(_transformed(flights=[f]), NOW)
    assert out["flights"] == [f]


def test_filter_recent_drops_flights_outside_the_window():
    too_old = _flight("OLD-1", "2026-01-01")
    too_far = _flight("FAR-1", "2030-01-01")
    out = gfd.filter_recent(_transformed(flights=[too_old, too_far]), NOW)
    assert out["flights"] == []


def test_filter_recent_keeps_a_generous_buffer_past_the_watchdogs_own_window():
    # The watchdog's own exact window is -3d/+14d; this pre-filter deliberately uses a wider
    # -4d/+15d so it can never clip something the watchdog's own withinSnapshotWindow() would
    # have kept — the watchdog re-applies its exact filter downstream regardless.
    lower_boundary = _flight("LOW-1", "2026-08-12")  # exactly 4 days back
    upper_boundary = _flight("UP-1", "2026-08-31")   # exactly 15 days forward
    out = gfd.filter_recent(_transformed(flights=[lower_boundary, upper_boundary]), NOW)
    assert out["flights"] == [lower_boundary, upper_boundary]


def test_filter_recent_keeps_all_cancellations_regardless_of_date():
    old = _cancellation("OLD-1", "2020-01-01")
    future = _cancellation("FUT-1", "2099-01-01")
    out = gfd.filter_recent(_transformed(cancellations=[old, future]), NOW)
    assert out["cancellations"] == [old, future]


def test_filter_recent_omits_instructors_resources_leaves():
    out = gfd.filter_recent(_transformed(), NOW)
    assert "instructors" not in out
    assert "resources" not in out
    assert "leaves" not in out


def test_filter_recent_preserves_fetched_at_and_tz():
    out = gfd.filter_recent(_transformed(), NOW)
    assert out["fetchedAt"] == "2026-08-16T07:00:00Z"
    assert out["tz"] == "Asia/Bangkok"
