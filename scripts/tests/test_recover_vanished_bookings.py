import fetch_schedule as fs


def _entry(booking_id, status="Pending", **overrides):
    base = {
        "id": booking_id, "date": "2026-08-07", "status": status,
        "statusOverride": None, "start": "08:00", "end": "09:30",
        "student": "SOME STUDENT", "instructor": "SOME INSTRUCTOR",
        "cancelReason": None, "cancelRemarks": None,
    }
    base.update(overrides)
    return base


def test_recovers_a_vanished_booking_as_canceled():
    existing = {"2026-08-07": [_entry("BK-1")]}
    new = {"2026-08-07": []}  # BK-1 no longer returned by this run's fetch
    recovered = fs.recover_vanished_bookings(new, existing, cancel_lookup={})
    assert recovered == 1
    assert len(new["2026-08-07"]) == 1
    assert new["2026-08-07"][0]["id"] == "BK-1"
    assert new["2026-08-07"][0]["status"] == "Canceled"


def test_marks_recovered_true_when_no_cancel_record_found():
    existing = {"2026-08-07": [_entry("BK-1")]}
    new = {"2026-08-07": []}
    fs.recover_vanished_bookings(new, existing, cancel_lookup={})
    assert new["2026-08-07"][0]["recovered"] is True
    assert new["2026-08-07"][0]["cancelReason"] is None


def test_recovered_false_when_a_cancel_record_exists():
    existing = {"2026-08-07": [_entry("BK-1")]}
    new = {"2026-08-07": []}
    cancel_lookup = {"BK-1": {"reason": "Weather (WX)", "remarks": "storm"}}
    fs.recover_vanished_bookings(new, existing, cancel_lookup)
    entry = new["2026-08-07"][0]
    assert entry["recovered"] is False
    assert entry["cancelReason"] == "Weather (WX)"
    assert entry["cancelRemarks"] == "storm"


def test_does_not_touch_bookings_still_present_in_fresh_fetch():
    existing = {"2026-08-07": [_entry("BK-1")]}
    new = {"2026-08-07": [_entry("BK-1")]}  # still there, unchanged
    recovered = fs.recover_vanished_bookings(new, existing, cancel_lookup={})
    assert recovered == 0
    assert len(new["2026-08-07"]) == 1


def test_does_not_re_recover_a_booking_already_canceled_in_prior_data():
    existing = {"2026-08-07": [_entry("BK-1", status="Canceled")]}
    new = {"2026-08-07": []}
    recovered = fs.recover_vanished_bookings(new, existing, cancel_lookup={})
    assert recovered == 0
    assert new["2026-08-07"] == []


def test_skips_dates_with_no_prior_data():
    existing = {}
    new = {"2026-08-07": []}
    recovered = fs.recover_vanished_bookings(new, existing, cancel_lookup={})
    assert recovered == 0
