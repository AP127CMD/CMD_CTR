"""Per-leg Flight Records (2026-09-24) — see fetch_schedule.normalize_leg_number()'s
section comment. Fixtures are the real 2026-09-23 SETASIT P. CSXV 45 XC: one
06:30-11:30 booking, three Flight Records (VTPH->VTSB->VTSE->VTPH), while
getStudentSchedule's actual{} only carries leg 3."""
import json

import fetch_schedule as fs
from .test_fetch_schedule import FakeUserFrame

BK = "BK-AP-127-SETA-EHX3N"


def rec_id(stamp):
    return f"Student Records|key|{BK}|{stamp}"


LEG_FIELDS = {
    "1": {"leg": "1", "routeFrom": "VTPH", "routeTo": "VTSB", "blockOff": "06:30", "takeoff": "06:40",
          "landing": "08:35", "blockOn": "08:40", "ts": "23/09/2026 14:24:11"},
    "2": {"leg": "2", "routeFrom": "VTSB", "routeTo": "VTSE", "blockOff": "08:46", "takeoff": "08:50",
          "landing": "10:20", "blockOn": "10:25", "ts": "23/09/2026 14:25:20"},
    "3": {"leg": "3", "routeFrom": "VTSE", "routeTo": "VTPH", "blockOff": "10:30", "takeoff": "10:36",
          "landing": "11:47", "blockOn": "11:52", "ts": "23/09/2026 14:27:26"},
}


def detail_fields(n, **over):
    f = LEG_FIELDS[n]
    base = {"date": "2026-09-23", "bookingId": BK, "student": "SETASIT P.", "batch": "AP-127",
            "lesson": "CSXV 45", "flightType": "Solo", "instructor": "-", "numTakeoffs": "1",
            "numLandings": "1", "instApp": "", "acReg": "HS-TPO", "acType": "DA40TDI", "remark": "",
            **{k: v for k, v in f.items() if k != "ts"}}
    base.update(over)
    return base


def leg_record(n, **over):
    return fs.flight_leg_record(rec_id(LEG_FIELDS[n]["ts"]), detail_fields(n, **over))


# ── small parsers ─────────────────────────────────────────────────────────────

def test_normalize_leg_number():
    assert fs.normalize_leg_number("/3") == "3"
    assert fs.normalize_leg_number("3") == "3"
    assert fs.normalize_leg_number("03") == "3"
    for blank in ("", "-", None):
        assert fs.normalize_leg_number(blank) is None


def test_parse_flight_record_id():
    assert fs.parse_flight_record_id(rec_id("23/09/2026 14:27:26")) == (BK, "2026-09-23 14:27:26")
    # booking ids can contain spaces (flight type embedded)
    assert fs.parse_flight_record_id("Student Records|key|BK-FAM FI-EKKA-UZCWU|23/09/2026 22:51:13")[0] \
        == "BK-FAM FI-EKKA-UZCWU"
    assert fs.parse_flight_record_id("garbage") == (None, None)


def test_flight_leg_record_maps_portal_names():
    r = leg_record("2")
    assert r["bookingId"] == BK and r["leg"] == "2" and r["stamp"] == "2026-09-23 14:25:20"
    assert (r["routeFrom"], r["routeTo"]) == ("VTSB", "VTSE")
    assert (r["blockOff"], r["tkoff"], r["ldgTime"], r["blockOn"]) == ("08:46", "08:50", "10:20", "10:25")
    assert (r["to"], r["ldg"], r["tail"]) == (1, 1, "HS-TPO")
    assert r["inst"] is None and r["remark"] is None  # "" → None


# ── normalize_entry: the actual{} fields that used to be dropped ──────────────

def test_normalize_entry_keeps_route_leg_type_remark():
    entry = {"date": "2026-09-23", "bookingId": BK, "status": "Completed", "student": "SETASIT P.",
             "instructor": "-", "batch": "AP-127", "lesson": "CSXV 45", "startTime": "06:30",
             "endTime": "11:30", "duration": "5:00", "condition": "Solo / XC", "acType": "DA40TDI",
             "acReg": "HS-TPO", "leg": "",
             "actual": {"leg": "/3", "routeFrom": "VTSE", "routeTo": "VTPH", "flightType": "Solo",
                        "remark": "  Incomplete mission due engine problem  ", "blockOff": "10:30",
                        "takeoff": "10:36", "landing": "11:47", "blockOn": "11:52", "tis": "1:11"}}
    out = fs.normalize_entry(entry, "2026-09-23")
    assert (out["routeFrom"], out["routeTo"], out["actualLeg"]) == ("VTSE", "VTPH", "3")
    assert out["flightType"] == "Solo"
    assert out["remark"] == "Incomplete mission due engine problem"


def test_normalize_entry_new_fields_absent_without_actual():
    entry = {"date": "2026-09-24", "bookingId": "BK-X", "status": "Pending", "startTime": "06:30",
             "endTime": "07:45", "duration": "1:15", "acType": "DA40CS", "acReg": "HS-TVA"}
    out = fs.normalize_entry(entry, "2026-09-24")
    assert all(out[k] is None for k in ("routeFrom", "routeTo", "actualLeg", "flightType", "remark"))


# ── which records to detail-fetch ────────────────────────────────────────────

def sub(stamp, date="09/23/2026", bk=BK, form="Flight Record"):
    return {"formType": form, "date": date, "id": f"Student Records|key|{bk}|{stamp}"}


def test_select_only_multi_record_bookings_in_window_newest_first():
    subs = [
        sub(LEG_FIELDS["1"]["ts"]), sub(LEG_FIELDS["2"]["ts"]), sub(LEG_FIELDS["3"]["ts"]),
        sub("23/09/2026 09:00:00", bk="BK-SINGLE"),                                  # 1 record → skip
        sub("10/09/2026 09:00:00", date="09/10/2026", bk="BK-OLD"),                  # out of window
        sub("10/09/2026 09:05:00", date="09/10/2026", bk="BK-OLD"),
        {"formType": "Cancel Record", "date": "09/23/2026", "id": "x|key|BK-C|23/09/2026 10:00:00"},
        {"formType": "Cancel Record", "date": "09/23/2026", "id": "x|key|BK-C|23/09/2026 10:01:00"},
    ]
    ids, in_scope = fs.select_flight_leg_ids(subs, set(), "2026-09-24", 3, 12)
    assert in_scope == 3
    assert ids == [rec_id(LEG_FIELDS[n]["ts"]) for n in ("3", "2", "1")]  # newest first


def test_select_skips_cached_and_respects_cap():
    subs = [sub(LEG_FIELDS[n]["ts"]) for n in ("1", "2", "3")]
    ids, in_scope = fs.select_flight_leg_ids(subs, {rec_id(LEG_FIELDS["3"]["ts"])}, "2026-09-24", 3, 1)
    assert in_scope == 2
    assert ids == [rec_id(LEG_FIELDS["2"]["ts"])]


# ── assembling legs ───────────────────────────────────────────────────────────

def test_build_legs_orders_by_leg_and_keeps_latest_resubmission():
    corrected = fs.flight_leg_record(f"Student Records|key|{BK}|23/09/2026 15:00:00",
                                     detail_fields("2", landing="10:21"))
    legs = fs.build_legs_by_booking([leg_record("3"), leg_record("2"), leg_record("1"), corrected])[BK]
    assert [l["leg"] for l in legs] == ["1", "2", "3"]
    assert legs[1]["ldgTime"] == "10:21"  # the later submission won
    assert set(legs[0]) == set(fs._LEG_OUTPUT_FIELDS)


def completed_entry(**over):
    e = {"id": BK, "status": "Completed", "actualLeg": "3", "routeFrom": "VTSE", "routeTo": "VTPH",
         "blockOff": "10:30", "tkoff": "10:36", "ldgTime": "11:47", "blockOn": "11:52",
         "to": 1, "ldg": 1, "inst": None, "tail": "HS-TPO", "remark": None}
    e.update(over)
    return e


def test_attach_legs_full_set():
    sched = {"2026-09-23": [completed_entry()]}
    n = fs.attach_legs(sched, fs.build_legs_by_booking([leg_record(k) for k in ("1", "2", "3")]))
    assert n == 1
    assert [(l["leg"], l["routeFrom"], l["routeTo"]) for l in sched["2026-09-23"][0]["legs"]] == \
        [("1", "VTPH", "VTSB"), ("2", "VTSB", "VTSE"), ("3", "VTSE", "VTPH")]


def test_attach_legs_unions_the_entrys_own_latest_leg_while_backfilling():
    # Only leg 1's detail fetched so far — the booking's own actual{} (leg 3) must still appear.
    sched = {"2026-09-23": [completed_entry()]}
    fs.attach_legs(sched, fs.build_legs_by_booking([leg_record("1")]))
    assert [l["leg"] for l in sched["2026-09-23"][0]["legs"]] == ["1", "3"]


def test_attach_legs_single_leg_gets_no_legs_key():
    sched = {"2026-09-23": [completed_entry(actualLeg=None)]}
    fs.attach_legs(sched, fs.build_legs_by_booking([leg_record("3")]))
    assert "legs" not in sched["2026-09-23"][0]


def test_attach_legs_leaves_unknown_bookings_untouched():
    # An older entry whose records were pruned from the cache keeps its baked-in legs.
    baked = [{"leg": "1"}, {"leg": "2"}]
    sched = {"2026-09-01": [completed_entry(id="BK-OLD", legs=baked)]}
    fs.attach_legs(sched, {})
    assert sched["2026-09-01"][0]["legs"] == baked


def test_attach_legs_ignores_non_completed():
    sched = {"2026-09-23": [completed_entry(status="Pending")]}
    fs.attach_legs(sched, fs.build_legs_by_booking([leg_record(k) for k in ("1", "2")]))
    assert "legs" not in sched["2026-09-23"][0]


# ── the async fetcher + shared submissions list ───────────────────────────────

class DetailFrame(FakeUserFrame):
    """getSubmissionDetail answers per id; anything unknown is an RPC error."""

    def __init__(self, details, **responses):
        super().__init__({"getSubmissionDetail": None, **responses})
        self.details = details

    async def evaluate(self, js_string, arg):
        fn, call_args, _ = arg
        if fn == "getSubmissionDetail":
            self.calls.append((fn, call_args, None))
            d = self.details.get(call_args[0]["id"])
            return {"__ok": d} if d else {"__err": "no such id"}
        return await super().evaluate(js_string, arg)


async def test_fetch_flight_legs_fetches_and_prunes(tmp_path, monkeypatch):
    out = tmp_path / "flight_schedule.json"
    stale = {"id": "old", "bookingId": "BK-OLD", "date": "2026-08-01", "leg": "1"}
    out.write_text(json.dumps({"flightLegRecords": [stale]}))
    monkeypatch.setattr(fs, "OUTPUT_FILE", out)
    subs = [sub(LEG_FIELDS[n]["ts"]) for n in ("1", "2", "3")]
    frame = DetailFrame({rec_id(LEG_FIELDS[n]["ts"]): {"ok": True, "fields": detail_fields(n)}
                         for n in ("1", "2")})  # leg 3 detail fails → retried next run
    records = await fs._fetch_flight_legs(frame, subs, "2026-09-24")
    assert sorted(r["leg"] for r in records) == ["1", "2"]
    assert all(r["id"] != "old" for r in records)  # pruned (older than FLIGHT_LEG_CACHE_DAYS)
    assert all(c[0] == "getSubmissionDetail" for c in frame.calls)  # never re-lists submissions


async def test_leaves_and_cancels_reuse_the_shared_list(tmp_path, monkeypatch):
    monkeypatch.setattr(fs, "OUTPUT_FILE", tmp_path / "none.json")
    frame = FakeUserFrame({})  # any RPC call at all would raise
    assert await fs._fetch_leaves(frame, subs=[]) == []
    assert await fs._fetch_cancel_records(frame, subs=[]) == []
    assert frame.calls == []
