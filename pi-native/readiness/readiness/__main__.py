"""Entry point: `python -m readiness` (systemd), `--print` (no publish), `login` (owner, interactive)."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import applier, config, flights_source, garmin_source, payload, publisher, rules as R
from .models import Signals

BKK = timezone(timedelta(hours=7))
HERE = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get("READINESS_STATE", "~/.ap127-readiness")).expanduser()
FEED_STALE_MIN = 60
NET_ERRORS = (urllib.error.URLError, OSError)  # HTTPError is a URLError subclass


def build_payload(today, settings, rules, data, api, now, applied, pending, on_applied=None):
    """Returns (payload, apply results, this run's moves). Flights include yesterday for R3."""
    start = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    end = (date.fromisoformat(today) + timedelta(days=13)).isoformat()
    flights = flights_source.my_flights(data, settings["owner"], start, end)
    ops = flights_source.ops_today(data, settings["batch"], today)
    if api is None:
        sig, workouts, errors = Signals(None, None, None, None, None), [], ["auth: no session"]
    else:
        sig, workouts, errors = garmin_source.fetch(api, today)
    race = (settings.get("race") or {}).get("date")
    plan = R.evaluate(today, sig, workouts, flights, race, rules)
    hints = R.move_back_hints(applied, workouts, flights, today, rules)
    dry = settings.get("dry_run", True)
    mover = applier.garmin_mover(api) if (api is not None and not dry) else None
    # never re-apply a move that is already recorded as applied
    done = [(p.get("id"), "ok", "already applied") for p in pending if p.get("id") in applied]
    todo = [p for p in pending if p.get("id") not in applied]
    if not dry and api is None:
        ran = [(p.get("id"), "failed", "garmin auth") for p in todo]
    else:
        ran = applier.run_pending(todo, plan.moves, dry, mover)
    results = done + ran
    by_id = {m.id: m for m in plan.moves}
    for move_id, st, why in ran:  # record real applies at once, before anything else can fail
        if st == "ok" and not why and move_id in by_id and on_applied:
            try:
                on_applied(by_id[move_id])
            except OSError as e:
                print(f"record_applied {move_id} failed: {e}", file=sys.stderr)
    age = flights_source.feed_age_min(data, now.astimezone(timezone.utc))
    src = {"garmin": "error" if errors else "ok", "flights": "stale" if age > FEED_STALE_MIN else "ok"}
    p = payload.build(plan, [f for f in flights if f.date >= today], ops, workouts, now, hints, src,
                      rules["max_payload_bytes"], race_date=race)
    if errors:
        print(f"garmin errors: {errors}", file=sys.stderr)
    return p, results, plan.moves


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="readiness")
    ap.add_argument("cmd", nargs="?", default="run", choices=("run", "login"))
    ap.add_argument("--print", action="store_true", help="print the payload instead of publishing")
    ap.add_argument("--today", help="override today's date (YYYY-MM-DD), for testing")
    a = ap.parse_args(argv)
    if a.cmd == "login":
        garmin_source.login_interactive()
        return 0

    settings = config.load_settings(HERE / "settings.json")
    rules = config.load_rules(HERE / "rules.json")
    now = datetime.now(BKK)
    today = a.today or now.date().isoformat()
    url, key = settings["worker_url"], os.environ.get("READINESS_PI_KEY", "")
    if not a.print and not key:
        print("READINESS_PI_KEY is not set; not publishing", file=sys.stderr)
        return 2
    try:
        api = garmin_source.connect()
    except garmin_source.GarminAuthRequired as e:
        print(e, file=sys.stderr)
        api = None
    pending = []
    if not a.print:
        try:
            pending = publisher.get_pending(url, key)
        except NET_ERRORS + (ValueError,) as e:
            print(f"get_pending failed: {type(e).__name__}: {e}", file=sys.stderr)
    applied_path = STATE / "applied.json"
    p, results, moves = build_payload(today, settings, rules, flights_source.load(), api, now,
                                      applier.load_applied(applied_path), pending,
                                      lambda m: applier.record_applied(applied_path, m))
    if a.print:
        print(json.dumps(p, ensure_ascii=False, indent=1))
        print(f"{payload.size_of(p)} bytes", file=sys.stderr)
        return 0
    for move_id, st, why in results:
        try:
            publisher.post_result(url, key, move_id, st, why)
        except NET_ERRORS as e:
            print(f"post_result {move_id} failed: {type(e).__name__}: {e}", file=sys.stderr)
    try:
        status = publisher.publish(p, url, key)
    except NET_ERRORS as e:
        print(f"publish failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(f"published {payload.size_of(p)} B (HTTP {status}); verdict={p['verdict']['s']} "
          f"moves={len(p['moves'])} applies={[r[1] for r in results]} src={p['src']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
