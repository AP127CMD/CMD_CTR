import copy
from datetime import datetime, timedelta, timezone

import pytest

from factories import fl, wk
from readiness import payload as P
from readiness import rules as R
from readiness.config import DEFAULT_RULES
from readiness.models import Signals

RULES = copy.deepcopy(DEFAULT_RULES)
GEN = datetime(2026, 10, 5, 6, 15, tzinfo=timezone(timedelta(hours=7)))
SIG = Signals(82, 64, 71, "BALANCED", 49)


def _plan():
    ws = [wk("2026-10-05", "Base"), wk("2026-10-06", "Tempo", "quality", applyable=True),
          wk("2026-10-10", "Long Run", "long", dist_m=25010)]
    flights = [fl("2026-10-06", "18:10", "19:10", lesson="CDNXC 49", fid="BK-9"),
               fl("2026-10-07", "", "", lesson="CDNXC 50", status="Canceled", cancel_reason="Weather (WX)", fid="BK-C")]
    return ws, flights, R.evaluate("2026-10-05", SIG, ws, flights, "2026-11-15", RULES)


OPS = {"d": "2026-10-05", "tot": {"plan": 2, "done": 0, "cx": 0},
       "ac": [{"t": "HS-TVG", "s": "SVC", "slots": [["08:30", "09:50", "SORNSORAWITCH C.", "CSPGL 51"]]}]}


def test_shape_and_values():
    ws, flights, plan = _plan()
    p = P.build(plan, flights, OPS, ws, GEN, [], {"garmin": "ok", "flights": "ok"}, 8192)
    assert p["v"] == 1 and p["gen"] == "2026-10-05T06:15:00+07:00" and p["ge"] == int(GEN.timestamp())
    assert p["verdict"] == {"s": "GO", "why": "sleep 82, BB 64, TR 71", "sleep": 82, "bb": 64, "tr": 71,
                            "hrv": "BALANCED", "partial": False}
    assert p["run"] == {"plan": "Base", "advice": "As planned", "rule": ""}
    [m] = p["moves"]
    assert (m["w"], m["from"], m["to"], m["rule"], m["ap"]) == ("Tempo", "2026-10-06", "2026-10-07", "R1", 1)
    assert p["flights"][0] == {"id": "BK-9", "d": "2026-10-06", "off": "18:10", "on": "19:10", "l": "CDNXC 49",
                               "c": "SPIC", "i": "PHAHOLYUTH P.", "t": "HS-TVG", "r": "", "ft": "", "st": "Pending", "x": ""}
    assert p["flights"][1]["st"] == "Canceled" and p["flights"][1]["x"] == "Weather (WX)"
    assert [d["d"] for d in p["week"]] == [f"2026-10-{d:02d}" for d in range(5, 12)]
    tue = p["week"][1]
    assert (tue["dw"], tue["w"], tue["fly"], tue["mv"]) == ("Tue", "Tempo", True, "> Wed (R1)")
    assert p["week"][2]["fly"] is False                       # the cancelled booking is not flying
    assert p["week"][3]["w"] == "Rest"
    assert p["applies"] == [] and p["hints"] == [] and p["src"]["garmin"] == "ok"


def test_flights_window_is_today_plus_six():
    ws, _, plan = _plan()
    flights = [fl("2026-10-04", "20:00", "21:30"), fl("2026-10-11", "08:00", "09:00"), fl("2026-10-12", "08:00", "09:00")]
    p = P.build(plan, flights, OPS, ws, GEN, [], {}, 8192)
    assert [f["d"] for f in p["flights"]] == ["2026-10-11"]


def test_text_is_forced_to_ascii():
    ws, flights, plan = _plan()
    ops = copy.deepcopy(OPS)
    ops["ac"][0]["slots"][0][3] = "ทดสอบ — test"
    p = P.build(plan, flights, ops, ws, GEN, ["a → b"], {}, 8192)
    assert p["ops"]["ac"][0]["slots"][0][3] == "????? - test"
    assert p["hints"] == ["a -> b"]


def test_shrinks_to_fit_and_reports_when_it_cannot():
    ws, flights, plan = _plan()
    ops = {"d": "2026-10-05", "tot": {"plan": 0, "done": 0, "cx": 0},
           "ac": [{"t": f"HS-T{i:02d}", "s": "SVC",
                   "slots": [["08:30", "09:50", "SOMEONE VERYLONGNAME", "CSPGL 51"]] * 12} for i in range(20)]}
    p = P.build(plan, flights, ops, ws, GEN, [], {}, 8192)
    assert P.size_of(p) <= 8192
    assert all(len(a["slots"]) <= 4 for a in p["ops"]["ac"])
    with pytest.raises(ValueError, match="payload"):
        P.build(plan, flights, ops, ws, GEN, [], {}, 300)


def test_race_date_included_when_given():
    ws, flights, plan = _plan()
    p = P.build(plan, flights, OPS, ws, GEN, [], {}, 8192, race_date="2026-11-15")
    assert p["race"] == {"d": "2026-11-15"}


def test_race_omitted_by_default():
    ws, flights, plan = _plan()
    assert "race" not in P.build(plan, flights, OPS, ws, GEN, [], {}, 8192)
