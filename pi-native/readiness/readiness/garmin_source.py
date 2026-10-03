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


def parse_signals(readiness, hrv, sleep, bb, rhr) -> Signals:
    tr = sleep_from_tr = None
    if readiness:
        rows = readiness if isinstance(readiness, list) else [readiness]
        latest = max(rows, key=lambda r: r.get("timestamp") or "")
        tr, sleep_from_tr = latest.get("score"), latest.get("sleepScore")
    overall = (((sleep or {}).get("dailySleepDTO") or {}).get("sleepScores") or {}).get("overall") or {}
    sleep_v = overall.get("value") if overall.get("value") is not None else sleep_from_tr
    hrv_s = ((hrv or {}).get("hrvSummary") or {}).get("status")
    bb_v = None
    if bb:
        vals = [v for v in (bb[0].get("bodyBatteryValuesArray") or []) if v and v[-1] is not None]
        if vals:
            bb_v = int(vals[-1][-1])
    metrics = ((((rhr or {}).get("allMetrics") or {}).get("metricsMap") or {})
               .get("WELLNESS_RESTING_HEART_RATE") or [])
    rhr_v = int(metrics[0]["value"]) if metrics and metrics[0].get("value") is not None else None
    return Signals(sleep_v, bb_v, tr, hrv_s, rhr_v)


def parse_workouts(items: list, task_list: list, start: str, end: str) -> list[Workout]:
    tasks = {}
    for t in task_list or []:
        uuid = (t.get("taskWorkout") or {}).get("workoutUuid")
        if uuid:
            tasks[uuid] = t
    out = []
    for it in items or []:
        item_type = it.get("itemType")
        if item_type not in ("fbtAdaptiveWorkout", "workout") or not (start <= it.get("date", "") <= end):
            continue
        uuid = it.get("workoutUuid") or f"sched-{it.get('id')}"
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

    sig = parse_signals(safe("readiness", api.get_training_readiness, today), safe("hrv", api.get_hrv_data, today),
                        safe("sleep", api.get_sleep_data, today), safe("bb", api.get_body_battery, today),
                        safe("rhr", api.get_rhr_day, today))
    d0 = date.fromisoformat(today)
    d1 = d0 + timedelta(days=days - 1)
    items: list = []
    for y, m in sorted({(d0.year, d0.month), (d1.year, d1.month)}):
        cal = safe("calendar", api.get_scheduled_workouts, y, m)
        items += (cal or {}).get("calendarItems") or []
    tasks: list = []
    for pid in sorted({it["trainingPlanId"] for it in items if it.get("trainingPlanId")}):
        plan = safe("plan", api.get_adaptive_training_plan_by_id, pid)
        tasks += (plan or {}).get("taskList") or []
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
