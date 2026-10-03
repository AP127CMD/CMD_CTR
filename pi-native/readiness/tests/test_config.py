import json

import pytest

from readiness import config


def test_rules_json_matches_defaults(tmp_path):
    shipped = config.load_rules(config.Path(__file__).resolve().parents[1] / "rules.json")
    assert shipped == config.DEFAULT_RULES


def test_rules_file_overrides_only_given_keys(tmp_path):
    p = tmp_path / "rules.json"
    p.write_text(json.dumps({"pre_flight_hours": 10}))
    r = config.load_rules(p)
    assert r["pre_flight_hours"] == 10 and r["run_time"] == "17:00"


def test_missing_rules_file_gives_defaults_copy(tmp_path):
    r = config.load_rules(tmp_path / "nope.json")
    r["verdict"]["sleep"][0] = 1
    assert config.DEFAULT_RULES["verdict"]["sleep"][0] == 60


def test_settings_require_owner_batch_and_url(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"owner": "ANUSORN T.", "batch": "AP-127"}))
    with pytest.raises(ValueError, match="worker_url"):
        config.load_settings(p)


def test_settings_default_to_dry_run(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"owner": "A", "batch": "B", "worker_url": "https://x"}))
    assert config.load_settings(p)["dry_run"] is True
