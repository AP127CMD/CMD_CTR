"""Thresholds (rules.json, committed) and owner settings (settings.json, gitignored)."""
from __future__ import annotations

import copy
import json
from pathlib import Path

DEFAULT_RULES = {
    "pre_flight_hours": 12,
    "late_block_on": "21:00",
    "low_readiness": 33,
    "race_protect_days": 21,
    "run_time": "17:00",
    "verdict": {"sleep": [60, 45], "bb": [40, 25], "tr": [33, 20]},
    "demanding_tokens": ["SOLO", "XC", "CHECK", "CHK", "PROG"],
    "low_hrv_status": ["LOW", "UNBALANCED", "POOR"],
    "max_payload_bytes": 8192,
}


def load_rules(path: Path | None) -> dict:
    rules = copy.deepcopy(DEFAULT_RULES)
    if path is not None and path.exists():
        rules.update(json.loads(path.read_text()))
    return rules


def load_settings(path: Path) -> dict:
    s = json.loads(path.read_text())
    for key in ("owner", "batch", "worker_url"):
        if not s.get(key):
            raise ValueError(f"settings.json is missing '{key}'")
    s.setdefault("dry_run", True)
    s.setdefault("race", {})
    return s
