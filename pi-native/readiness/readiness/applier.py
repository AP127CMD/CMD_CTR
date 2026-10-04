"""Relays Apply requests from the Worker queue to Garmin Connect. Dry-run until the owner signs off.
A move is only ever applied if it is in the plan computed THIS run (stale Apply -> 'superseded')."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from .models import Move


def run_pending(pending: list[dict], moves: list[Move], dry_run: bool,
                mover: Callable[[Move], None] | None) -> list[tuple[str, str, str]]:
    by_id = {m.id: m for m in moves if m.workout.applyable}
    results = []
    for p in pending:
        mv = by_id.get(p.get("id"))
        if mv is None:
            results.append((p.get("id"), "failed", "superseded"))
        elif dry_run or mover is None:
            results.append((mv.id, "dryrun", f"would move {mv.workout.title} {mv.frm}->{mv.to}"))
        else:
            try:
                mover(mv)
                results.append((mv.id, "ok", ""))
            except Exception as e:  # the calendar is left as it was; the watch shows the reason
                results.append((mv.id, "failed", f"{type(e).__name__}: {e}"[:80]))
    return results


def garmin_mover(api) -> Callable[[Move], None]:
    """Schedule on the new day, then remove the old entry. If the removal fails, remove the
    new entry again so the calendar ends as it started. Response key verified in Task 9."""
    def move(mv: Move) -> None:
        w = mv.workout
        if not (w.workout_id and w.sched_id):
            raise ValueError("workout has no workoutId/scheduleId")
        new = api.schedule_workout(w.workout_id, mv.to) or {}
        try:
            api.unschedule_workout(w.sched_id)
        except Exception:
            new_id = new.get("workoutScheduleId")
            if new_id is not None:
                api.unschedule_workout(str(new_id))
            raise
    return move


def load_applied(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def record_applied(path: Path, move: Move) -> None:
    applied = load_applied(path)
    applied[move.id] = {"uuid": move.workout.uuid, "frm": move.frm, "to": move.to}
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(applied))
