import generate_flight_data as gfd


def _raw(entry_overrides):
    entry = {
        "id": "BK-1", "date": "2026-08-07", "status": "Canceled",
        "start": "08:00", "end": "09:30", "student": "S", "instructor": "I",
        "batch": "AP-127", "lesson": "L", "condition": "Nav", "type": "DA40CS", "tail": "HS-TVC",
        "durationMin": 90, "duration": "01:30",
    }
    entry.update(entry_overrides)
    return {"schedules": {"2026-08-07": [entry]}, "fetched_at": "2026-08-07T00:00:00Z"}


def test_recovered_true_is_passed_through():
    out = gfd.transform(_raw({"recovered": True}))
    assert out["flights"][0]["recovered"] is True


def test_recovered_false_is_omitted_not_passed_as_false():
    out = gfd.transform(_raw({"recovered": False}))
    assert "recovered" not in out["flights"][0]


def test_missing_recovered_field_is_omitted():
    out = gfd.transform(_raw({}))
    assert "recovered" not in out["flights"][0]
