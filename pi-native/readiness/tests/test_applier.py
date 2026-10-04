from factories import wk
from readiness import applier as A
from readiness.models import Move

APPLYABLE = wk("2026-10-06", "My Hills", "quality", uuid="sched-555", applyable=True, sched_id="555", workout_id="999")
COACH = wk("2026-10-06", "Tempo", "quality", uuid="u-tempo")
MV = Move("m-ok", APPLYABLE, "2026-10-06", "2026-10-07", "R1", "x")
MV_COACH = Move("m-coach", COACH, "2026-10-06", "2026-10-07", "R1", "x")


def test_dry_run_never_calls_the_mover():
    called = []
    res = A.run_pending([{"id": "m-ok"}], [MV], True, called.append)
    assert res == [("m-ok", "dryrun", "would move My Hills 2026-10-06->2026-10-07")] and called == []


def test_superseded_and_coach_moves_fail_safely():
    res = A.run_pending([{"id": "m-gone"}, {"id": "m-coach"}], [MV_COACH], False, lambda m: None)
    assert res == [("m-gone", "failed", "superseded"), ("m-coach", "failed", "superseded")]


def test_live_mover_success_and_error():
    assert A.run_pending([{"id": "m-ok"}], [MV], False, lambda m: None) == [("m-ok", "ok", "")]

    def boom(m):
        raise RuntimeError("HTTP 403 from Garmin")

    [(i, st, why)] = A.run_pending([{"id": "m-ok"}], [MV], False, boom)
    assert (i, st) == ("m-ok", "failed") and why.startswith("RuntimeError") and "403" not in why


def test_no_mover_means_dry_run():
    assert A.run_pending([{"id": "m-ok"}], [MV], False, None)[0][1] == "dryrun"


class FakeApi:
    def __init__(self, fail_unschedule=False):
        self.calls, self.fail_unschedule = [], fail_unschedule

    def schedule_workout(self, wid, d):
        self.calls.append(("schedule", wid, d))
        return {"workoutScheduleId": 777}

    def unschedule_workout(self, sid):
        self.calls.append(("unschedule", sid))
        if self.fail_unschedule and sid == "555":
            raise RuntimeError("nope")


def test_garmin_mover_schedules_then_unschedules():
    api = FakeApi()
    A.garmin_mover(api)(MV)
    assert api.calls == [("schedule", "999", "2026-10-07"), ("unschedule", "555")]


def test_garmin_mover_rolls_back_when_unschedule_fails():
    api = FakeApi(fail_unschedule=True)
    try:
        A.garmin_mover(api)(MV)
    except A.ApplyError as e:
        assert "unschedule failed (RuntimeError); rolled back" in str(e)
    else:
        raise AssertionError("expected ApplyError")
    assert api.calls[-1] == ("unschedule", "777")


class BadApi(FakeApi):
    def __init__(self, sched_result, fail_all=False):
        super().__init__(fail_unschedule=True)
        self.sched_result, self.fail_all = sched_result, fail_all

    def schedule_workout(self, wid, d):
        self.calls.append(("schedule", wid, d))
        return self.sched_result

    def unschedule_workout(self, sid):
        self.calls.append(("unschedule", sid))
        if self.fail_all or sid == "555":
            raise RuntimeError("nope")


def _run_expect_apply_error(api):
    try:
        A.garmin_mover(api)(MV)
    except A.ApplyError as e:
        return str(e)
    raise AssertionError("expected ApplyError")


def test_rollback_failure_reports_duplicate():
    api = BadApi({"workoutScheduleId": 777}, fail_all=True)
    msg = _run_expect_apply_error(api)
    assert "duplicate left on 2026-10-07" in msg and "RuntimeError" in msg
    assert [c for c in api.calls if c[0] == "unschedule"] == [("unschedule", "555"), ("unschedule", "777")]


def test_odd_schedule_response_no_rollback_attempt():
    for resp in ([{"workoutScheduleId": 1}], {"other": 1}, None, "x"):
        api = BadApi(resp)
        msg = _run_expect_apply_error(api)
        assert "duplicate left on 2026-10-07" in msg
        assert [c for c in api.calls if c[0] == "unschedule"] == [("unschedule", "555")]


def test_failure_reason_has_no_raw_exception_text():
    class HttpErr(Exception):
        pass

    def boom(m):
        raise HttpErr("GET https://connect.garmin.com/x?token=abc failed")

    [(_, st, why)] = A.run_pending([{"id": "m-ok"}], [MV], False, boom)
    assert st == "failed" and "https" not in why and "token" not in why and why.startswith("HttpErr")

    class WithStatus(Exception):
        status = 429

    def boom2(m):
        raise WithStatus("token=abc")

    [(_, _, why2)] = A.run_pending([{"id": "m-ok"}], [MV], False, boom2)
    assert "429" in why2 and "token" not in why2


def test_apply_error_reason_carries_duplicate_text():
    api = BadApi({"workoutScheduleId": 777}, fail_all=True)
    [(_, st, why)] = A.run_pending([{"id": "m-ok"}], [MV], False, A.garmin_mover(api))
    assert st == "failed" and "duplicate left on" in why and len(why) <= 80


def test_each_pending_id_processed_once():
    calls = []
    res = A.run_pending([{"id": "m-ok"}, {"id": "m-ok"}], [MV], False, calls.append)
    assert calls == [MV] and res == [("m-ok", "ok", "")]


def test_applied_state_round_trip(tmp_path):
    p = tmp_path / "applied.json"
    assert A.load_applied(p) == {}
    A.record_applied(p, MV)
    assert A.load_applied(p) == {"m-ok": {"uuid": "sched-555", "frm": "2026-10-06", "to": "2026-10-07"}}
