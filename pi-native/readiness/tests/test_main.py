import copy
import urllib.error
from datetime import datetime, timedelta, timezone

from readiness import __main__ as M
from readiness import applier
from readiness.config import DEFAULT_RULES
from test_flights_source import RAW
from test_garmin_source import FakeApi
from readiness import flights_source as FS

SETTINGS = {"owner": "ANUSORN T.", "batch": "AP-127", "worker_url": "https://w", "dry_run": True,
            "race": {"date": "2026-11-15"}}
NOW = datetime(2026, 10, 4, 6, 0, tzinfo=timezone(timedelta(hours=7)))


def test_build_payload_end_to_end():
    p, results, moves = M.build_payload("2026-10-04", SETTINGS, copy.deepcopy(DEFAULT_RULES),
                                        FS.gfd.transform(RAW), FakeApi(), NOW, {}, [{"id": "m-nope"}])
    assert p["v"] == 1 and p["verdict"]["s"] in ("GO", "CAUTION", "REVIEW")
    assert [f["id"] for f in p["flights"]] == ["BK-1", "BK-C"]        # yesterday's BK-Y is rules-only
    assert p["ops"]["d"] == "2026-10-04"
    assert p["src"] == {"garmin": "ok", "flights": "ok"}             # feed is newer than NOW -> not stale
    assert results == [("m-nope", "failed", "superseded")]
    assert all(m.id.startswith("m-") for m in moves)


def test_garmin_down_still_publishes_flights():
    p, _, _ = M.build_payload("2026-10-04", SETTINGS, copy.deepcopy(DEFAULT_RULES), FS.gfd.transform(RAW),
                              None, NOW, {}, [])
    assert p["src"]["garmin"] == "error" and p["verdict"]["s"] == "REVIEW" and p["flights"]


def test_already_applied_never_reaches_mover(monkeypatch):
    seen = []
    real = applier.run_pending
    monkeypatch.setattr(applier, "run_pending",
                        lambda pending, moves, dry, mover: (seen.append(list(pending)),
                                                            real(pending, moves, dry, mover))[1])
    _, results, _ = M.build_payload("2026-10-04", SETTINGS, copy.deepcopy(DEFAULT_RULES),
                                    FS.gfd.transform(RAW), FakeApi(), NOW,
                                    {"m-done": {"uuid": "u", "frm": "a", "to": "b"}},
                                    [{"id": "m-done"}, {"id": "m-nope"}])
    assert seen == [[{"id": "m-nope"}]]
    assert ("m-done", "ok", "already applied") in results
    assert ("m-nope", "failed", "superseded") in results


def test_main_survives_network_failures(monkeypatch, tmp_path, capsys):
    from readiness import publisher
    monkeypatch.setenv("READINESS_PI_KEY", "secret-key")
    monkeypatch.setattr(M, "STATE", tmp_path)
    monkeypatch.setattr(M.garmin_source, "connect", lambda: None)
    monkeypatch.setattr(M.flights_source, "load", lambda: FS.gfd.transform(RAW))
    monkeypatch.setattr(M.config, "load_settings", lambda p: dict(SETTINGS))
    boom = urllib.error.URLError("down")

    def bad(*a, **k):
        raise boom
    monkeypatch.setattr(publisher, "get_pending", bad)
    monkeypatch.setattr(publisher, "post_result", bad)
    monkeypatch.setattr(publisher, "publish", bad)
    assert M.main(["run", "--today", "2026-10-04"]) == 1
    assert "secret-key" not in capsys.readouterr().err


def test_applies_recorded_before_payload_failure(monkeypatch):
    class Mv:
        id = "m-1"
    mv = Mv()
    monkeypatch.setattr(M.R, "evaluate", lambda *a, **k: type("P", (), {"moves": [mv]})())
    monkeypatch.setattr(M.applier, "run_pending", lambda *a: [("m-1", "ok", "")])
    monkeypatch.setattr(M.payload, "build", lambda *a, **k: (_ for _ in ()).throw(ValueError("too big")))
    rec = []
    try:
        M.build_payload("2026-10-04", SETTINGS, copy.deepcopy(DEFAULT_RULES), FS.gfd.transform(RAW),
                        FakeApi(), NOW, {"m-old": {"uuid": "u", "frm": "a", "to": "b"}}, [{"id": "m-1"}, {"id": "m-old"}], rec.append)
    except ValueError:
        pass
    assert rec == [mv]          # recorded; "already applied" m-old is not


def test_auth_failed_applies_fail_when_live():
    s = dict(SETTINGS, dry_run=False)
    _, results, _ = M.build_payload("2026-10-04", s, copy.deepcopy(DEFAULT_RULES), FS.gfd.transform(RAW),
                                    None, NOW, {}, [{"id": "m-x"}])
    assert results == [("m-x", "failed", "garmin auth")]


def test_key_checked_before_connect(monkeypatch):
    monkeypatch.delenv("READINESS_PI_KEY", raising=False)
    monkeypatch.setattr(M.config, "load_settings", lambda p: dict(SETTINGS))
    monkeypatch.setattr(M.garmin_source, "connect", lambda: (_ for _ in ()).throw(AssertionError("connected")))
    assert M.main(["run"]) == 2
