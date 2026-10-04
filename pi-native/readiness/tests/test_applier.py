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
    assert (i, st) == ("m-ok", "failed") and why.startswith("RuntimeError: HTTP 403")


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
    except RuntimeError:
        pass
    assert api.calls[-1] == ("unschedule", "777")


def test_applied_state_round_trip(tmp_path):
    p = tmp_path / "applied.json"
    assert A.load_applied(p) == {}
    A.record_applied(p, MV)
    assert A.load_applied(p) == {"m-ok": {"uuid": "sched-555", "frm": "2026-10-06", "to": "2026-10-07"}}
