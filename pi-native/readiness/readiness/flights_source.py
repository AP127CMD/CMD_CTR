"""AP127 flights for the watch. Reuses CMD_CTR's generate_flight_data.transform so the Pi job
reads the feed exactly the way CMDV2 does — never a second, drifting parser."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .models import Flight

REPO = Path(__file__).resolve().parents[3]          # .../flight-schedule-feed
sys.path.insert(0, str(REPO / "scripts"))
import generate_flight_data as gfd  # noqa: E402


def load(path: Path = REPO / "data" / "flight_schedule.json") -> dict:
    return gfd.transform(json.loads(path.read_text()))


def _to_flight(f: dict) -> Flight:
    return Flight(
        id=f["id"].removeprefix("ACTUAL_ONLY_"), date=f["date"],
        off=f.get("blockOff") or f.get("start") or "", on=f.get("blockOn") or f.get("end") or "",
        lesson=f.get("lesson") or "", cond=f.get("cond") or "", instructor=f.get("instructor") or "",
        tail=f.get("tail") or "", route="-".join(x for x in (f.get("routeFrom"), f.get("routeTo")) if x),
        ftype=f.get("flightType") or "", status=f.get("status") or "Pending",
        is_sim=bool(f.get("isSim")), is_standby=bool(f.get("isStandby")),
        cancel_reason=f.get("cancelReason") or "",
    )


def my_flights(data: dict, owner: str, start: str, end: str) -> list[Flight]:
    rows = [f for f in data["flights"]
            if f.get("student") == owner and start <= f["date"] <= end and not f.get("isNonFlight")]
    out = [_to_flight(f) for f in rows]
    seen = {f.id for f in out}
    for c in data.get("cancellations", []):
        if c.get("student") == owner and start <= c.get("date", "") <= end and c.get("bookingId") not in seen:
            out.append(Flight(id=c["bookingId"], date=c["date"], off="", on="", lesson=c.get("lesson") or "",
                              cond="", instructor=c.get("instructor") or "", tail=c.get("acReg") or "",
                              route="", ftype="", status="Canceled", is_sim=False, is_standby=False,
                              cancel_reason=c.get("reason") or ""))
    return sorted(out, key=lambda f: (f.date, f.off))


def ops_today(data: dict, batch: str, today: str) -> dict:
    rows = [f for f in data["flights"]
            if f["date"] == today and f.get("batch") == batch and not f.get("isNonFlight")]
    live = [f for f in rows if f.get("status") != "Canceled"]
    cx_ids = {f["id"] for f in rows if f.get("status") == "Canceled"}
    cx = len(cx_ids) + sum(1 for c in data.get("cancellations", [])
                           if c.get("date") == today and c.get("batch") == batch and c.get("bookingId") not in cx_ids)
    maint = {r.get("tail"): bool(r.get("isMaint")) for r in data.get("resources", [])}
    by_tail: dict[str, list] = {}
    for f in sorted(live, key=lambda f: f.get("start") or ""):
        tail = f.get("tail") or "SIM"
        by_tail.setdefault(tail, []).append(
            [f.get("start") or "", f.get("end") or "", f.get("student") or "", f.get("lesson") or ""])
    return {
        "d": today,
        "tot": {"plan": len(live), "done": sum(1 for f in live if f.get("status") == "Completed"), "cx": cx},
        "ac": [{"t": t, "s": "AOG" if maint.get(t) else "SVC", "slots": s} for t, s in sorted(by_tail.items())],
    }


def feed_age_min(data: dict, now_utc: datetime) -> float:
    raw = (data.get("fetchedAt") or "").replace("Z", "+00:00")
    try:
        fetched = datetime.fromisoformat(raw)
    except ValueError:
        return float("inf")
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    return (now_utc - fetched).total_seconds() / 60
