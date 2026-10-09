"""Compact, watch-shaped payload (spec §5). ASCII only — Garmin system fonts lack most symbols."""
from __future__ import annotations

import json
import unicodedata
from datetime import date, datetime, timedelta

from .models import Flight, Plan, Workout
from .rules import dow

_REPLACE = {"→": "->", "—": "-", "–": "-", "·": ",", "↷": ">", "…": "..."}


def _ascii(s):
    if not isinstance(s, str):
        return s
    for k, v in _REPLACE.items():
        s = s.replace(k, v)
    s = unicodedata.normalize("NFKD", s)
    return "".join(c if ord(c) < 128 else ("" if unicodedata.combining(c) else "?") for c in s)


def _deep_ascii(x):
    if isinstance(x, dict):
        return {k: _deep_ascii(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_deep_ascii(v) for v in x]
    return _ascii(x)


def size_of(p: dict) -> int:
    return len(json.dumps(p, ensure_ascii=False, separators=(",", ":")).encode())


def _flight(f: Flight) -> dict:
    return {"id": f.id, "d": f.date, "off": f.off, "on": f.on, "l": f.lesson, "c": f.cond, "i": f.instructor,
            "t": f.tail, "r": f.route, "ft": f.ftype, "st": f.status, "x": f.cancel_reason}


def build(plan: Plan, flights: list[Flight], ops: dict, workouts: list[Workout], gen: datetime,
          hints: list[str], src: dict, max_bytes: int, race_date: str | None = None) -> dict:
    today = date.fromisoformat(plan.today)
    days = [(today + timedelta(days=i)).isoformat() for i in range(7)]
    flying = {f.date for f in flights if f.aircraft}
    week = []
    for d in days:
        runs = [w.label for w in workouts if w.date == d and w.kind not in ("other", "rest")]
        week.append({"d": d, "dw": dow(d), "w": ", ".join(runs) or "Rest", "fly": d in flying,
                     "mv": plan.notes.get(d, "")})
    v, s = plan.verdict, plan.signals
    p = {
        "v": 1,
        "gen": gen.isoformat(timespec="seconds"),
        "ge": int(gen.timestamp()),
        "verdict": {"s": v.s, "why": v.why, "sleep": s.sleep, "bb": s.bb, "tr": s.tr, "hrv": s.hrv,
                    "partial": v.partial},
        "run": {"plan": plan.run.plan, "advice": plan.run.advice, "rule": plan.run.rule},
        "moves": [{"id": m.id, "w": m.workout.label, "from": m.frm, "to": m.to, "rule": m.rule, "why": m.why,
                   "ap": 1 if m.workout.applyable else 0} for m in plan.moves],
        "applies": [],
        "flights": [_flight(f) for f in flights if days[0] <= f.date <= days[-1]],
        "ops": ops,
        "week": week,
        "hints": list(hints),
        "src": src,
    }
    if race_date:
        p["race"] = {"d": race_date}
    return _shrink(_deep_ascii(p), max_bytes)


def _shrink(p: dict, max_bytes: int) -> dict:
    steps = (
        lambda q: [a.update(slots=a["slots"][:4]) for a in q["ops"]["ac"]],
        lambda q: [s.__setitem__(2, "") for a in q["ops"]["ac"] for s in a["slots"]],
        lambda q: q.update(flights=q["flights"][:5]),
        lambda q: q["ops"].update(ac=q["ops"]["ac"][:6]),
    )
    for step in steps:
        if size_of(p) <= max_bytes:
            return p
        step(p)
    if size_of(p) > max_bytes:
        raise ValueError(f"payload is {size_of(p)} B after shrinking, over the {max_bytes} B cap")
    return p
