from readiness import garmin_source as G

READINESS = [
    {"timestamp": "2026-10-03T01:46:01.0", "score": 81, "sleepScore": 87, "level": "HIGH"},
    {"timestamp": "2026-10-02T23:10:00.0", "score": 60, "sleepScore": 87},
]
HRV = {"hrvSummary": {"status": "UNBALANCED", "lastNightAvg": 46}}
SLEEP = {"dailySleepDTO": {"sleepScores": {"overall": {"value": 87, "qualifierKey": "GOOD"}}}}
BB = [{"date": "2026-10-03", "bodyBatteryValuesArray": [[1790960400000, 11], [1790985060000, 69], [1791035100000, 33]]}]
RHR = {"allMetrics": {"metricsMap": {"WELLNESS_RESTING_HEART_RATE": [{"value": 49.0}]}}}

ITEMS = [
    {"id": 1, "itemType": "fbtAdaptiveWorkout", "title": "Long Run", "date": "2026-10-03", "sportTypeKey": "running",
     "workoutUuid": "u-long", "trainingPlanId": 46561720},
    {"id": 2, "itemType": "fbtAdaptiveWorkout", "title": "Tempo", "date": "2026-10-06", "sportTypeKey": "running",
     "workoutUuid": "u-tempo", "trainingPlanId": 46561720},
    {"id": 3, "itemType": "fbtAdaptiveWorkout", "title": "Total Body Circuit 1", "date": "2026-10-06",
     "sportTypeKey": "strength_training", "workoutUuid": "u-str", "trainingPlanId": 46561720},
    {"id": 4, "itemType": "fbtAdaptiveWorkout", "title": "Base", "date": "2026-10-07", "sportTypeKey": "running",
     "workoutUuid": "u-base", "trainingPlanId": 46561720},
    {"id": 555, "itemType": "workout", "title": "My Hills", "date": "2026-10-08", "sportTypeKey": "running",
     "workoutId": 999},
    {"id": 6, "itemType": "activity", "title": "Morning Run", "date": "2026-10-03"},
    {"id": 7, "itemType": "fbtAdaptiveWorkout", "title": "Base", "date": "2026-10-30", "sportTypeKey": "running",
     "workoutUuid": "u-late"},
]
TASKS = [
    {"longWkt": True, "taskWorkout": {"workoutUuid": "u-long", "estimatedDistanceInMeters": 25010,
                                      "estimatedDurationInSecs": 9840, "trainingEffectLabel": "AEROBIC_BASE",
                                      "restDay": False}},
    {"longWkt": False, "taskWorkout": {"workoutUuid": "u-tempo", "trainingEffectLabel": "LACTATE_THRESHOLD"}},
]


def test_parse_signals_from_real_shapes():
    s = G.parse_signals(READINESS, HRV, SLEEP, BB, RHR)
    assert (s.sleep, s.bb, s.tr, s.hrv, s.rhr) == (87, 33, 81, "UNBALANCED", 49)


def test_parse_signals_tolerates_missing_parts():
    s = G.parse_signals(None, None, {}, [], None)
    assert (s.sleep, s.bb, s.tr, s.hrv, s.rhr) == (None, None, None, None, None)
    assert G.parse_signals(READINESS, None, None, None, None).sleep == 87   # falls back to readiness' sleepScore


def test_parse_workouts_classifies_and_marks_applyability():
    ws = G.parse_workouts(ITEMS, TASKS, "2026-10-03", "2026-10-16")
    got = [(w.date, w.title, w.kind, w.applyable) for w in ws]
    assert got == [
        ("2026-10-03", "Long Run", "long", False),
        ("2026-10-06", "Tempo", "quality", False),
        ("2026-10-06", "Total Body Circuit 1", "other", False),
        ("2026-10-07", "Base", "easy", False),
        ("2026-10-08", "My Hills", "quality", True),
    ]
    long_run = ws[0]
    assert (long_run.dist_m, long_run.dur_s, long_run.uuid) == (25010, 9840, "u-long")
    hills = ws[-1]
    assert (hills.sched_id, hills.workout_id) == ("555", "999")


def test_classify_rest_and_titles():
    assert G.classify("Rest", "running", {"taskWorkout": {"restDay": True}}) == "rest"
    assert G.classify("Intervals 6x800", "running", None) == "quality"
    assert G.classify("Recovery", "running", None) == "easy"


class FakeApi:
    def __init__(self, fail=()):
        self.fail = set(fail)

    def _r(self, name, value):
        if name in self.fail:
            raise RuntimeError(name)
        return value

    def get_training_readiness(self, d): return self._r("readiness", READINESS)
    def get_hrv_data(self, d): return self._r("hrv", HRV)
    def get_sleep_data(self, d): return self._r("sleep", SLEEP)
    def get_body_battery(self, d): return self._r("bb", BB)
    def get_rhr_day(self, d): return self._r("rhr", RHR)
    def get_scheduled_workouts(self, y, m): return self._r("calendar", {"calendarItems": ITEMS if m == 10 else []})
    def get_adaptive_training_plan_by_id(self, pid): return self._r("plan", {"taskList": TASKS})


def test_fetch_ok():
    sig, ws, errors = G.fetch(FakeApi(), "2026-10-03")
    assert errors == [] and sig.tr == 81 and len(ws) == 5


def test_fetch_isolates_one_failing_signal():
    sig, ws, errors = G.fetch(FakeApi(fail={"hrv"}), "2026-10-03")
    assert errors == ["hrv: RuntimeError"]
    assert sig.hrv is None and sig.tr == 81 and len(ws) == 5


def test_fetch_spans_month_boundary():
    _, ws, _ = G.fetch(FakeApi(), "2026-09-28")    # window 09-28..10-11 needs Sep and Oct calendars
    assert ws[0].date == "2026-10-03"


class OddApi(FakeApi):
    def __init__(self, **over):
        super().__init__()
        self.over = over

    def get_training_readiness(self, d): return self.over.get("readiness", READINESS)
    def get_hrv_data(self, d): return self.over.get("hrv", HRV)
    def get_sleep_data(self, d): return self.over.get("sleep", SLEEP)
    def get_body_battery(self, d): return self.over.get("bb", BB)
    def get_rhr_day(self, d): return self.over.get("rhr", RHR)
    def get_scheduled_workouts(self, y, m):
        return self.over.get("calendar", {"calendarItems": ITEMS if m == 10 else []})


import pytest


@pytest.mark.parametrize("name,value,blank", [
    ("bb", {"oops": 1}, "bb"),
    ("bb", [{"bodyBatteryValuesArray": [[1, "x"]]}], "bb"),
    ("readiness", [None, "x", 5], "tr"),
    ("hrv", [1, 2], "hrv"),
    ("sleep", [1, 2], None),   # sleep falls back to readiness.sleepScore, so it stays 87
    ("rhr", {"allMetrics": {"metricsMap": {"WELLNESS_RESTING_HEART_RATE": [{"value": "n/a"}]}}}, "rhr"),
])
def test_fetch_odd_signal_shape_blanks_only_that_signal(name, value, blank):
    sig, ws, errors = G.fetch(OddApi(**{name: value}), "2026-10-03")
    ok = G.fetch(OddApi(), "2026-10-03")[0]
    for f in ("sleep", "bb", "tr", "hrv", "rhr"):
        assert getattr(sig, f) == (None if f == blank else getattr(ok, f)), f
    assert len(ws) == 5


def test_fetch_scheduled_workouts_list_does_not_raise():
    sig, ws, _ = G.fetch(OddApi(calendar=[1, 2]), "2026-10-03")
    assert ws == [] and sig.tr == 81


def test_calendar_skips_null_date_and_non_dict_items():
    bad = [{"id": 9, "itemType": "workout", "title": "x", "date": None}, "junk", None] + ITEMS
    _, ws, _ = G.fetch(OddApi(calendar={"calendarItems": bad}), "2026-10-03")
    assert len(ws) == 5


def test_workouts_deduped_across_month_calls():
    _, ws, _ = G.fetch(OddApi(calendar={"calendarItems": ITEMS}), "2026-09-28")
    assert len(ws) == 5 and len({w.uuid for w in ws}) == 5
