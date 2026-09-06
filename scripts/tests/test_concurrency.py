"""Phase 2: bounded-concurrency per-date RPC fetch.

`_gather_dates_bounded(dates, fetch_one, concurrency)` runs `fetch_one(date)`
for every date, at most `concurrency` at a time. `fetch_one` is a coroutine
returning `(date, result)`. `concurrency <= 1` is exactly serial and in-order.
"""
import asyncio

import fetch_schedule as fs


def test_runs_all_dates_and_caps_parallelism():
    active = 0
    peak = []

    async def fake(date):
        nonlocal active
        active += 1
        peak.append(active)
        await asyncio.sleep(0.02)
        active -= 1
        return date, {"flights": [date]}

    dates = [f"2026-09-{d:02d}" for d in range(1, 13)]
    out = asyncio.run(fs._gather_dates_bounded(dates, fake, concurrency=4))

    assert {d for d, _ in out} == set(dates)
    assert dict(out)["2026-09-05"] == {"flights": ["2026-09-05"]}
    assert 2 <= max(peak) <= 4  # actually parallelised, never over the cap


def test_concurrency_one_is_serial_and_in_order():
    order = []

    async def fake(date):
        order.append(("start", date))
        await asyncio.sleep(0.01)
        order.append(("end", date))
        return date, {}

    dates = ["a", "b", "c"]
    asyncio.run(fs._gather_dates_bounded(dates, fake, concurrency=1))
    assert order == [
        ("start", "a"), ("end", "a"),
        ("start", "b"), ("end", "b"),
        ("start", "c"), ("end", "c"),
    ]


def test_result_order_matches_input_order():
    async def fake(date):
        # finish in reverse order of start
        await asyncio.sleep(0.05 - 0.01 * int(date[-1]))
        return date, int(date[-1])

    dates = ["d0", "d1", "d2", "d3"]
    out = asyncio.run(fs._gather_dates_bounded(dates, fake, concurrency=4))
    assert [d for d, _ in out] == dates


def test_a_failing_date_does_not_sink_the_batch():
    async def fake(date):
        if date == "bad":
            return date, None
        return date, {"ok": True}

    out = dict(asyncio.run(
        fs._gather_dates_bounded(["good1", "bad", "good2"], fake, concurrency=2)
    ))
    assert out["bad"] is None
    assert out["good1"] == {"ok": True}
    assert out["good2"] == {"ok": True}


def test_fetch_one_date_with_retry_success(monkeypatch):
    async def ok(frame, date):
        return [{"date": date, "student": "X"}]
    monkeypatch.setattr(fs, "_fetch_schedule_for_date", ok)
    d, flights = asyncio.run(fs._fetch_one_date_with_retry(None, "2026-09-05"))
    assert d == "2026-09-05"
    assert flights == [{"date": "2026-09-05", "student": "X"}]


def test_fetch_one_date_with_retry_retries_then_succeeds(monkeypatch):
    calls = {"n": 0}

    async def flaky(frame, date):
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("stable-empty / mismatched date")
        return []

    async def _nosleep(_):
        return None

    monkeypatch.setattr(fs, "_fetch_schedule_for_date", flaky)
    monkeypatch.setattr(fs.asyncio, "sleep", _nosleep)
    d, flights = asyncio.run(fs._fetch_one_date_with_retry(None, "2026-09-05"))
    assert d == "2026-09-05"
    assert flights == []
    assert calls["n"] == 3


def test_fetch_one_date_with_retry_gives_up_to_None(monkeypatch):
    async def always_fails(frame, date):
        raise RuntimeError("portal down")

    async def _nosleep(_):
        return None

    monkeypatch.setattr(fs, "_fetch_schedule_for_date", always_fails)
    monkeypatch.setattr(fs.asyncio, "sleep", _nosleep)
    monkeypatch.setattr(fs, "DATE_FETCH_ATTEMPTS", 3)
    d, flights = asyncio.run(fs._fetch_one_date_with_retry(None, "2026-09-05"))
    assert d == "2026-09-05"
    assert flights is None


def test_default_concurrency_is_env_tunable_and_defaults_to_4(monkeypatch):
    monkeypatch.delenv("FETCH_RPC_CONCURRENCY", raising=False)
    import importlib
    importlib.reload(fs)
    assert fs.FETCH_RPC_CONCURRENCY == 4
    monkeypatch.setenv("FETCH_RPC_CONCURRENCY", "1")
    importlib.reload(fs)
    assert fs.FETCH_RPC_CONCURRENCY == 1
    monkeypatch.delenv("FETCH_RPC_CONCURRENCY", raising=False)
    importlib.reload(fs)
