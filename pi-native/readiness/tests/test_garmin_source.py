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
