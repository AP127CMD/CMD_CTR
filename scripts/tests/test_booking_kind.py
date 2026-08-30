"""Non-syllabus booking markers + the widened bookingId pattern.

Both come from the 2026-08-31 audit. The two are related: dozens of bogus
"unexpected bookingId format" warnings per run were saturating the
schema-drift GitHub issue, and because that alert dedups on "is one already
open?", the saturation was silently swallowing every OTHER drift signal —
including the genuinely new `MEETING|`/`GROUND|`/`TESTFLIGHT|` status markers
and the new `bookingType`/`leg` fields, which had gone unnoticed as a result.
"""

import fetch_schedule as fs
import pytest


def _entry(status, **over):
    """A minimally-valid raw portal entry: every REQUIRED_ENTRY_FIELD present,
    so validate_raw_cache() reports only what a test is actually probing and
    not a pile of missing-field errors."""
    e = {f: "" for f in fs.REQUIRED_ENTRY_FIELDS}
    e.update(
        {
            "date": "2026-08-31",
            "bookingId": "BK-TEST-0001",
            "status": status,
            "duration": "1:00",
            "startTime": "08:00",
            "endTime": "09:00",
        }
    )
    e.update(over)
    return e


class TestBookingKind:
    @pytest.mark.parametrize(
        "raw,kind,status",
        [
            ("MEETING|Pending", "MEETING", "Pending"),
            ("GROUND|Pending", "GROUND", "Pending"),
            ("TESTFLIGHT|Pending", "TESTFLIGHT", "Pending"),
            ("MEETING|Completed", "MEETING", "Completed"),
        ],
    )
    def test_marker_is_captured_not_discarded(self, raw, kind, status):
        """The whole point: before this, the marker was thrown away and a
        3-hour meeting looked exactly like a real Pending training flight."""
        out = fs.normalize_entry(_entry(raw), "2026-08-31")
        assert out["bookingKind"] == kind
        assert out["status"] == status

    @pytest.mark.parametrize("raw", ["Pending", "Completed", "Canceled"])
    def test_ordinary_flights_have_no_kind(self, raw):
        out = fs.normalize_entry(_entry(raw), "2026-08-31")
        assert out["bookingKind"] is None
        assert out["status"] == raw

    def test_override_still_parsed_and_not_mistaken_for_a_kind(self):
        out = fs.normalize_entry(
            _entry("Pending [OVERRIDE: Student solo]"), "2026-08-31"
        )
        assert out["bookingKind"] is None
        assert out["status"] == "Pending"
        assert out["statusOverride"] == "Student solo"

    def test_new_upstream_fields_passed_through(self):
        out = fs.normalize_entry(
            _entry("Pending", bookingType="Ground School", leg="1"), "2026-08-31"
        )
        assert out["bookingType"] == "Ground School"
        assert out["leg"] == "1"

    def test_unknown_status_still_defaults_to_pending(self):
        """Unrecognised kinds must stay safe (Pending), not crash or leak a
        non-VALID_STATUSES value downstream."""
        out = fs.normalize_entry(_entry("WHATEVER|Pending"), "2026-08-31")
        assert out["status"] == "Pending"


class TestDriftWarnings:
    def _warn(self, entries):
        cache = {"schedules": {"2026-08-31": entries}}
        warnings, errors = fs.validate_raw_cache(cache)
        return " ".join(warnings), errors

    def test_known_kinds_no_longer_warn(self):
        w, errors = self._warn(
            [_entry("MEETING|Pending"), _entry("GROUND|Pending"),
             _entry("TESTFLIGHT|Pending")]
        )
        assert "Unknown status" not in w

    def test_a_genuinely_new_kind_still_warns(self):
        """Silencing the known ones must NOT silence real drift — that was the
        original bug, one level up."""
        w, _ = self._warn([_entry("SIMULATOR|Pending")])
        assert "Unknown status" in w and "SIMULATOR|Pending" in w

    @pytest.mark.parametrize(
        "bid",
        [
            "BK-AP FAM-JATU-PZA7R",      # spaces
            "BK-Skill Test-SARU-HPU4G",  # spaces + lowercase
            "BK-Test Flight-WACH-25CG0",
            "BK-FAM FI-JIRA-7222K",
            "BK-Recurrent-W-TH-JC8YN",
            "BK-AP-127-TEER-FKTRW",      # the classic form still fine
            "DR-AP-126-PONG-C0LHI",
        ],
    )
    def test_real_booking_ids_do_not_warn(self, bid):
        w, _ = self._warn([_entry("Pending", bookingId=bid)])
        assert "unexpected bookingId format" not in w

    @pytest.mark.parametrize("bid", ["", "bk-lower", "BK", "BK-x@y", "123-ABC"])
    def test_malformed_booking_ids_still_warn(self, bid):
        w, _ = self._warn([_entry("Pending", bookingId=bid)])
        assert "unexpected bookingId format" in w
