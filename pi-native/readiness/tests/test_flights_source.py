from datetime import datetime, timezone

from readiness import flights_source as FS


def _row(**kw):
    base = {"id": "BK-1", "date": "2026-10-04", "status": "Pending", "start": "09:30", "end": "11:00",
            "student": "ANUSORN T.", "instructor": "PHAHOLYUTH P.", "batch": "AP-127", "lesson": "CDNXC 49",
            "condition": "XC / Night", "type": "DA40CS", "tail": "HS-TVG", "durationMin": 90, "duration": "01:30"}
    base.update(kw)
    return base


RAW = {
    "fetched_at": "2026-10-04T01:00:00Z",
    "schedules": {
        "2026-10-03": [_row(id="BK-Y", date="2026-10-03", start="20:00", end="21:30")],
        "2026-10-04": [
            _row(),
            _row(id="BK-2", student="SORNSORAWITCH C.", lesson="CSPGL 51", tail="HS-TVH", start="08:30", end="09:50"),
            _row(id="BK-3", student="OTHER S.", tail="HS-TVH", start="13:00", end="14:20", status="Completed",
                 blockOff="13:05", blockOn="14:15"),
            _row(id="BK-4", student="NOT 127", batch="AP-128", tail="HS-TVD"),
            _row(id="BK-5", student="SIM GUY", tail="", isSimulator=True, start="10:00", end="11:00"),
            _row(id="BK-6", student="MEETING", lesson="CATC Meeting", tail="", bookingKind="MEETING"),
        ],
    },
    "resources": [{"tail": "HS-TVG", "isMaint": False}, {"tail": "HS-TVH", "isMaint": True}],
    "cancelRecords": [
        {"bookingId": "BK-C", "date": "2026-10-05", "reason": "Weather (WX)", "student": "ANUSORN T.",
         "batch": "AP-127", "lesson": "CDNXC 50", "instructor": "WISANU T.", "acReg": "HS-TVD"},
        {"bookingId": "BK-D", "date": "2026-10-04", "reason": "Instructor Sick", "student": "OTHER S.",
         "batch": "AP-127", "lesson": "CSPGL 50", "acReg": "HS-TVG"},
    ],
}


def data():
    return FS.gfd.transform(RAW)


def test_my_flights_is_exact_owner_match_and_window():
    fs = FS.my_flights(data(), "ANUSORN T.", "2026-10-04", "2026-10-10")
    assert [f.id for f in fs] == ["BK-1", "BK-C"]          # not SORNSORAWITCH, not yesterday's BK-Y
    assert fs[0].off == "09:30" and fs[0].lesson == "CDNXC 49" and fs[0].tail == "HS-TVG"


def test_cancel_records_become_cancelled_flights_with_reason():
    [c] = [f for f in FS.my_flights(data(), "ANUSORN T.", "2026-10-04", "2026-10-10") if f.cancelled]
    assert (c.date, c.lesson, c.cancel_reason, c.tail, c.aircraft) == ("2026-10-05", "CDNXC 50", "Weather (WX)", "HS-TVD", False)


def test_completed_flight_uses_actual_block_times():
    [f] = [x for x in FS.my_flights(data(), "OTHER S.", "2026-10-04", "2026-10-04") if not x.cancelled]
    assert (f.off, f.on) == ("13:05", "14:15")


def test_ops_today_groups_ap127_by_tail_with_status_and_totals():
    ops = FS.ops_today(data(), "AP-127", "2026-10-04")
    assert ops["d"] == "2026-10-04"
    assert ops["tot"] == {"plan": 4, "done": 1, "cx": 1}   # BK-1, BK-2, BK-3, BK-5 (meeting excluded); BK-D cancelled
    by = {a["t"]: a for a in ops["ac"]}
    assert by["HS-TVH"]["s"] == "AOG" and by["HS-TVG"]["s"] == "SVC"
    assert by["HS-TVH"]["slots"] == [["08:30", "09:50", "SORNSORAWITCH C.", "CSPGL 51"],
                                     ["13:00", "14:20", "OTHER S.", "CDNXC 49"]]
    assert "SIM" in by and "HS-TVD" not in by             # AP-128 excluded


def test_feed_age_minutes():
    now = datetime(2026, 10, 4, 1, 30, tzinfo=timezone.utc)
    assert FS.feed_age_min(data(), now) == 30.0
