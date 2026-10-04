"""Garmin Connect reads for the readiness job (unofficial garminconnect 0.3.2 API).
Parsers are pure; fetch() isolates every call so one failure blanks only its own signal."""
from __future__ import annotations

import getpass
import re
from datetime import date, timedelta
from pathlib import Path

from .models import Signals, Workout

TOKEN_DIR = "~/.garminconnect"
QUALITY_WORDS = ("TEMPO", "INTERVAL", "THRESHOLD", "VO2", "SPEED", "HILL", "SPRINT", "ANAEROBIC", "RACE PACE")
QUALITY_TE = ("TEMPO", "LACTATE_THRESHOLD", "THRESHOLD", "VO2MAX", "ANAEROBIC_CAPACITY", "SPEED")


class GarminAuthRequired(RuntimeError):
    pass


def classify(title: str, sport: str, task: dict | None) -> str:
    task = task or {}
    tw = task.get("taskWorkout") or {}
    if tw.get("restDay"):
        return "rest"
    if sport != "running":
        return "other"
    t = title.upper()
    if task.get("longWkt") or "LONG" in t:
        return "long"
    if any(k in t for k in QUALITY_WORDS) or (tw.get("trainingEffectLabel") or "") in QUALITY_TE:
        return "quality"
    return "easy"


def _d(x) -> dict:
    return x if isinstance(x, dict) else {}


def _int(x):
    return None if x is None or isinstance(x, bool) else int(float(x))


def _readiness_parts(readiness):
    rows = [r for r in (readiness if isinstance(readiness, list) else [readiness]) if isinstance(r, dict)]
    if not rows:
        return None, None
    latest = max(rows, key=lambda r: str(r.get("timestamp") or ""))
    return latest.get("score"), latest.get("sleepScore")


def _sleep_value(sleep, fallback):
    overall = _d(_d(_d(_d(sleep).get("dailySleepDTO")).get("sleepScores")).get("overall"))
    return overall.get("value") if overall.get("value") is not None else fallback


def _hrv_status(hrv):
    return _d(_d(hrv).get("hrvSummary")).get("status")


def _bb_value(bb):
    if not isinstance(bb, list) or not bb:
        return None
    vals = [v for v in (_d(bb[0]).get("bodyBatteryValuesArray") or []) if v and v[-1] is not None]
    return int(vals[-1][-1]) if vals else None


def _rhr_value(rhr):
    metrics = _d(_d(_d(rhr).get("allMetrics")).get("metricsMap")).get("WELLNESS_RESTING_HEART_RATE") or []
    return _int(_d(metrics[0]).get("value")) if metrics else None


def parse_signals(readiness, hrv, sleep, bb, rhr) -> Signals:
    tr, sleep_from_tr = _readiness_parts(readiness) if readiness else (None, None)
    return Signals(_sleep_value(sleep, sleep_from_tr), _bb_value(bb), tr, _hrv_status(hrv), _rhr_value(rhr))


def parse_workouts(items: list, task_list: list, start: str, end: str) -> list[Workout]:
    tasks = {}
    for t in task_list or []:
        uuid = _d(_d(t).get("taskWorkout")).get("workoutUuid")
        if uuid:
            tasks[uuid] = t
    out = []
    seen: set = set()
    for it in items or []:
        if not isinstance(it, dict):
            continue
        item_type = it.get("itemType")
        if item_type not in ("fbtAdaptiveWorkout", "workout") or not (start <= (it.get("date") or "") <= end):
            continue
        uuid = it.get("workoutUuid") or f"sched-{it.get('id')}"
        if uuid in seen:   # Garmin returns the same coach items for every month call
            continue
        seen.add(uuid)
        task = tasks.get(uuid)
        tw = (task or {}).get("taskWorkout") or {}
        dist, dur = tw.get("estimatedDistanceInMeters"), tw.get("estimatedDurationInSecs")
        plain = item_type == "workout"
        out.append(Workout(
            uuid=uuid, date=it["date"], title=it.get("title") or "Workout",
            kind=classify(it.get("title") or "", it.get("sportTypeKey") or "", task),
            dist_m=int(dist) if dist else None, dur_s=int(dur) if dur else None,
            applyable=plain,
            sched_id=str(it["id"]) if plain and it.get("id") is not None else None,
            workout_id=str(it["workoutId"]) if plain and it.get("workoutId") is not None else None,
        ))
    return sorted(out, key=lambda w: (w.date, w.title))


def fetch(api, today: str, days: int = 14) -> tuple[Signals, list[Workout], list[str]]:
    errors: list[str] = []

    def safe(name, fn, *args):
        try:
            return fn(*args)
        except Exception as e:  # unofficial API — any failure is reported, never fatal
            errors.append(f"{name}: {type(e).__name__}")
            return None

    readiness = safe("readiness", api.get_training_readiness, today)
    tr, sleep_tr = (safe("readiness", _readiness_parts, readiness) if readiness else None) or (None, None)
    sig = Signals(
        safe("sleep", lambda: _sleep_value(api.get_sleep_data(today), sleep_tr)),
        safe("bb", lambda: _bb_value(api.get_body_battery(today))),
        tr,
        safe("hrv", lambda: _hrv_status(api.get_hrv_data(today))),
        safe("rhr", lambda: _rhr_value(api.get_rhr_day(today))),
    )
    d0 = date.fromisoformat(today)
    d1 = d0 + timedelta(days=days - 1)
    items: list = []
    for y, m in sorted({(d0.year, d0.month), (d1.year, d1.month)}):
        cal = safe("calendar", api.get_scheduled_workouts, y, m)
        got = _d(cal).get("calendarItems")
        items += got if isinstance(got, list) else []
    tasks: list = []
    for pid in sorted({it["trainingPlanId"] for it in items if isinstance(it, dict) and it.get("trainingPlanId")}, key=str):
        plan = safe("plan", api.get_adaptive_training_plan_by_id, pid)
        got = _d(plan).get("taskList")
        tasks += got if isinstance(got, list) else []
    return sig, parse_workouts(items, tasks, today, d1.isoformat()), errors


def connect(token_dir: str = TOKEN_DIR):
    from garminconnect import Garmin
    try:
        api = Garmin()
        api.login(str(Path(token_dir).expanduser()))
        return api
    except Exception as e:  # any failure to resume = owner must sign in again
        raise GarminAuthRequired(f"Garmin session unavailable ({type(e).__name__}); run: python -m readiness login") from e


def login_interactive(token_dir: str = TOKEN_DIR) -> None:
    """Owner types email, password and MFA here; only refreshable tokens are saved (mode 700 dir)."""
    from garminconnect import Garmin
    path = Path(token_dir).expanduser()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    email = input("Garmin Connect email: ").strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise SystemExit("That doesn't look like one email address.")
    api = Garmin(email, getpass.getpass("Garmin Connect password (not stored): "),
                 prompt_mfa=lambda: input("Garmin MFA code: ").strip())
    api.login(str(path))
    print("Signed in." if any(path.iterdir()) else f"Signed in, but no tokens were saved in {path}.")
