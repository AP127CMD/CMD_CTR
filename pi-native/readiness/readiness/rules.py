"""Pure rules engine (spec §6). No I/O. Every advice line carries its rule id (R1-R7)."""
from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta

from .models import Flight, Move, Plan, RunAdvice, Signals, Verdict, Workout

_DOW = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_SEARCH = (1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6)


def _d(s: str) -> date:
    return date.fromisoformat(s)


def _at(day: str, hhmm: str) -> datetime:
    return datetime.fromisoformat(f"{day}T{hhmm}")


def dow(day: str) -> str:
    return _DOW[_d(day).weekday()]


def _short(day: str) -> str:
    return f"{dow(day)} {day[5:]}"


def move_id(w: Workout, frm: str, to: str) -> str:
    return "m-" + hashlib.sha1(f"{w.uuid}|{frm}|{to}".encode()).hexdigest()[:10]


def is_demanding(f: Flight, rules: dict) -> bool:
    text = f"{f.lesson} {f.cond} {f.ftype}".upper()
    return any(tok in text for tok in rules["demanding_tokens"])


def verdict(sig: Signals, rules: dict) -> Verdict:
    vals = {"sleep": sig.sleep, "bb": sig.bb, "tr": sig.tr}
    present = {k: v for k, v in vals.items() if v is not None}
    if not present:
        return Verdict("REVIEW", "no readiness data", True)
    names = {"sleep": "sleep", "bb": "BB", "tr": "TR"}
    why = ", ".join(f"{names[k]} {present[k]}" for k in ("sleep", "bb", "tr") if k in present)
    review = [k for k, v in present.items() if v < rules["verdict"][k][1]]
    caution = [k for k, v in present.items() if v < rules["verdict"][k][0]]
    if review or len(caution) >= 2:
        s = "REVIEW"
    elif caution:
        s = "CAUTION"
    else:
        s = "GO"
    return Verdict(s, why, len(present) < 3)


def conflict(kind: str, day: str, flights: list[Flight], rules: dict) -> tuple[str, str] | None:
    """(rule, reason) if a hard workout of `kind` on `day` clashes with flying, else None."""
    air = sorted((f for f in flights if f.aircraft), key=lambda f: (f.date, f.off))
    run_at = _at(day, rules["run_time"])
    for f in air:
        gap_h = (_at(f.date, f.off) - run_at).total_seconds() / 3600
        if 0 < gap_h <= rules["pre_flight_hours"]:
            return "R1", f"{f.lesson} block-off {f.off} {dow(f.date)}"
    if kind == "long":
        nxt = (_d(day) + timedelta(days=1)).isoformat()
        for f in air:
            if f.date == nxt and is_demanding(f, rules):
                return "R2", f"{f.lesson} {f.off} {dow(f.date)}"
    if kind == "quality":
        prev = (_d(day) - timedelta(days=1)).isoformat()
        for f in air:
            if f.date == prev and f.on > rules["late_block_on"]:
                return "R3", f"{f.lesson} block-on {f.on} {dow(f.date)}"
    return None


def find_slot(w: Workout, workouts: list[Workout], flights: list[Flight], today: str,
              race_date: str | None, rules: dict) -> str | None:
    """R6: nearest day in the same ISO week, not before today, not on/after race day,
    no hard workout on it or either neighbour, and no clash of its own."""
    d0 = _d(w.date)
    week = d0.isocalendar()[:2]
    hard_days = {o.date for o in workouts if o.hard and o.uuid != w.uuid}
    for k in _SEARCH:
        c = d0 + timedelta(days=k)
        cs = c.isoformat()
        if cs < today or c.isocalendar()[:2] != week:
            continue
        if race_date and cs >= race_date:
            continue
        if {(c + timedelta(days=i)).isoformat() for i in (-1, 0, 1)} & hard_days:
            continue
        if conflict(w.kind, cs, flights, rules):
            continue
        return cs
    return None


def evaluate(today: str, sig: Signals, workouts: list[Workout], flights: list[Flight],
             race_date: str | None, rules: dict) -> Plan:
    moves: list[Move] = []
    notes: dict[str, str] = {}
    advice: dict[str, tuple[str, str]] = {}
    for w in sorted(workouts, key=lambda w: (w.date, w.title)):
        if not w.hard or w.date < today:
            continue
        hit = conflict(w.kind, w.date, flights, rules)
        if not hit:
            continue
        rule, reason = hit
        slot = find_slot(w, workouts, flights, today, race_date, rules)
        if slot:
            moves.append(Move(move_id(w, w.date, slot), w, w.date, slot, rule, reason))
            notes[w.date] = f"> {dow(slot)} ({rule})"
            how = "Apply on watch" if w.applyable else "move it in Garmin Connect"
            advice[w.uuid] = (f"Move to {_short(slot)} - {how}", rule)
        elif w.kind == "long" and race_date and (_d(race_date) - _d(w.date)).days <= rules["race_protect_days"]:
            days = (_d(race_date) - _d(w.date)).days
            notes[w.date] = f"keep ({rule})"
            advice[w.uuid] = (f"Keep - race in {days} d, no safe slot", rule)
        else:
            notes[w.date] = f"easy ({rule})"
            advice[w.uuid] = ("Downgrade to easy", rule)
    return Plan(today, verdict(sig, rules), sig, _today_run(today, sig, workouts, advice, rules), moves, notes)


def _today_run(today: str, sig: Signals, workouts: list[Workout], advice: dict, rules: dict) -> RunAdvice:
    todays = [w for w in workouts if w.date == today and w.kind not in ("other", "rest")]
    if not todays:
        return RunAdvice("Rest", "", "")
    w = next((w for w in todays if w.hard), todays[0])
    if w.uuid in advice:
        text, rule = advice[w.uuid]
        return RunAdvice(w.label, text, rule)
    low = (sig.tr is not None and sig.tr < rules["low_readiness"]) or \
          (sig.hrv or "").upper() in rules["low_hrv_status"]
    if w.kind == "quality" and low:
        return RunAdvice(w.label, "Downgrade to easy - low readiness", "R4")
    return RunAdvice(w.label, "As planned", "")


def move_back_hints(applied: dict, workouts: list[Workout], flights: list[Flight], today: str,
                    rules: dict) -> list[str]:
    """R7: an applied move whose triggering flight is gone is suggested back — never moved automatically."""
    by_uuid = {w.uuid: w for w in workouts}
    hints = []
    for rec in applied.values():
        w = by_uuid.get(rec["uuid"])
        if w is None or w.date != rec["to"] or rec["frm"] < today:
            continue
        if conflict(w.kind, rec["frm"], flights, rules) is None:
            hints.append(f"{w.title}: flight gone - could move back to {_short(rec['frm'])} (R7)")
    return hints
