"""
Converts data/flight_schedule.json → flight-data.js
Run: python3 scripts/generate_flight_data.py
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC  = ROOT / "data" / "flight_schedule.json"
DEST = ROOT / "flight-data.js"


def parse_dur(hhmm: str) -> int:
    if not hhmm:
        return 0
    parts = hhmm.split(":")
    return int(parts[0]) * 60 + int(parts[1]) if len(parts) == 2 else 0


def transform(raw: dict) -> dict:
    schedules = raw.get("schedules", {})
    flights = []

    for date, day_flights in schedules.items():
        for f in day_flights:
            flight_id = str(f.get("id") or f.get("rowIdx") or "")
            if f.get("isActual") and flight_id and not flight_id.startswith("ACTUAL_ONLY_"):
                flight_id = f"ACTUAL_ONLY_{flight_id}"

            dur_min = f.get("durationMin") or parse_dur(f.get("duration", ""))

            entry = {
                "id":         flight_id,
                "date":       f.get("date", date),
                "status":     f.get("status", "Pending"),
                "isSim":      bool(f.get("isSimulator", False)),
                "isStandby":  bool(f.get("isStandby", False)),
                "start":      f.get("start"),
                "end":        f.get("end"),
                "durMin":     dur_min,
                "duration":   f.get("duration", ""),
                "student":    f.get("student") or None,
                "instructor": f.get("instructor") or None,
                "batch":      f.get("batch", ""),
                "lesson":     f.get("lesson", ""),
                "cond":       f.get("condition") or None,
                "type":       f.get("type") or None,
                "tail":       f.get("tail") or None,
            }
            # Operational data — only present on Completed flights
            if f.get("status") == "Completed":
                if f.get("tkoff")   is not None: entry["tkoff"]   = f["tkoff"]
                if f.get("ldgTime") is not None: entry["ldgTime"] = f["ldgTime"]
                if f.get("airborne")is not None: entry["airborne"]= f["airborne"]
                if f.get("to")      is not None: entry["to"]      = f["to"]
                if f.get("ldg")     is not None: entry["ldg"]     = f["ldg"]
                if f.get("inst")    is not None: entry["inst"]    = f["inst"]
                if f.get("blockOff")is not None: entry["blockOff"]= f["blockOff"]
                if f.get("blockOn") is not None: entry["blockOn"] = f["blockOn"]
            flights.append(entry)

    return {
        "fetchedAt":   raw.get("fetched_at") or raw.get("fetchedAt", ""),
        "tz":          raw.get("timezone") or raw.get("tz", "Asia/Bangkok"),
        "flights":     flights,
        "instructors": raw.get("instructors", []),
        "resources":   raw.get("resources", []),
        "leaves":      raw.get("leaves", []),
    }


def main():
    raw = json.loads(SRC.read_text())
    data = transform(raw)
    js = f"// Auto-generated from data/flight_schedule.json — do not edit directly\nwindow.FLIGHT_DATA = {json.dumps(data, ensure_ascii=False, separators=(',', ':'))};\n"
    DEST.write_text(js)
    n = len(data["flights"])
    print(f"✓ flight-data.js written — {n} flights across {len(set(f['date'] for f in data['flights']))} dates")


if __name__ == "__main__":
    main()
