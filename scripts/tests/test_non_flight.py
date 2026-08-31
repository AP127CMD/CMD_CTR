"""Meetings / ground school must not count as flight hours (user's call,
2026-08-31), but must still appear on schedules.

The lesson-name fallback is load-bearing, not defensive: `bookingKind` only
started being captured on 2026-08-31, and everything on or before 2026-07-09
lives in the frozen pre-migration archive that is re-applied every run and
never re-fetched. Without the fallback the exclusion would silently miss
almost all historical meetings while looking like it worked.
"""

import generate_flight_data as gfd
import pytest


def _f(**over):
    e = {
        "id": "BK-1", "date": "2026-08-31", "status": "Pending",
        "start": "08:00", "end": "09:00", "student": "S", "instructor": "I",
        "batch": "AP-127", "lesson": "CDGL 01", "condition": None,
        "type": "DA40CS", "tail": "HS-TVC", "durationMin": 60, "duration": "01:00",
    }
    e.update(over)
    return e


class TestIsNonFlight:
    @pytest.mark.parametrize("kind", ["MEETING", "GROUND", "meeting", "ground"])
    def test_booking_kind_is_authoritative(self, kind):
        assert gfd.is_non_flight(_f(bookingKind=kind, type=None, tail=None)) is True

    @pytest.mark.parametrize(
        "lesson",
        [
            "MEETING", "Meeting", "CATC MEETING", "KEY PERSONNEL MEETING",
            "CAAT Meeting", "CATC CONSTRUCTION MEETING", "HHN AIRPORT MEETING",
            "RTP Meeting", "Ground School", "ground school",
        ],
    )
    def test_historical_fallback_by_lesson(self, lesson):
        """No bookingKind (frozen/pre-2026-08-31 data) and no aircraft."""
        assert gfd.is_non_flight(_f(lesson=lesson, type=None, tail=None)) is True

    @pytest.mark.parametrize(
        "lesson", ["CDGL 01", "UPRT 84", "CSPXI 89", "CMDIF (SIM) 92", "FAM"]
    )
    def test_real_flights_are_never_excluded(self, lesson):
        assert gfd.is_non_flight(_f(lesson=lesson)) is False

    def test_aircraft_beats_the_lesson_name(self):
        """A real flight whose lesson merely mentions a meeting must NOT be
        dropped — this is why the fallback is gated on having no aircraft."""
        assert gfd.is_non_flight(
            _f(lesson="Post-meeting checkride", type="DA40CS", tail="HS-TVC")
        ) is False
        assert gfd.is_non_flight(
            _f(lesson="Ground School follow-up flight", type="DA42TDI", tail="HS-TCP")
        ) is False

    def test_briefings_are_kept(self):
        """Only Ground School and Meetings were asked for. Ground-based
        briefings are NOT silently swept in — flagged to the user separately."""
        for lesson in [
            "C172 Training", "Orientation FI-H (02)",
            "Advance UPRT Long brief", "Long Brief AUPRT",
            "Night Flying Long Briefing",
        ]:
            assert gfd.is_non_flight(_f(lesson=lesson, type=None, tail=None)) is False

    def test_missing_fields_do_not_crash(self):
        assert gfd.is_non_flight({}) is False
        assert gfd.is_non_flight({"lesson": None, "type": None, "tail": None}) is False


class TestTransformEmitsFlag:
    def _flights(self, entries):
        raw = {"schedules": {"2026-08-31": entries}}
        return gfd.transform(raw)["flights"]

    def test_flag_present_only_when_true(self):
        out = self._flights([
            _f(id="BK-A", lesson="Meeting", type=None, tail=None),
            _f(id="BK-B", lesson="CDGL 01"),
        ])
        by_id = {f["id"]: f for f in out}
        assert by_id["BK-A"]["isNonFlight"] is True
        # absent, not False — the ~2 MB feed shouldn't carry a false flag on
        # every one of ~5,800 real flights
        assert "isNonFlight" not in by_id["BK-B"]

    def test_non_flights_are_still_emitted(self):
        """Excluded from HOURS, not hidden from schedules — CMDV2's p116
        specifically fixed meeting rows being invisible."""
        out = self._flights([_f(id="BK-A", lesson="Meeting", type=None, tail=None)])
        assert len(out) == 1
        assert out[0]["durMin"] == 60   # duration preserved for display/Gantt
