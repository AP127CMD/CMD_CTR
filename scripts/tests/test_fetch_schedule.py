import fetch_schedule as fs
import pytest


class FakeUserFrame:
    """Stand-in for a Playwright Frame — only implements what _rpc() calls
    (evaluate). A response value that's a BaseException simulates an RPC
    error; anything else simulates a successful result."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    async def evaluate(self, js_string, arg):
        fn, call_args, timeout_s = arg
        self.calls.append((fn, call_args, timeout_s))
        if fn not in self.responses:
            raise AssertionError(f"unexpected RPC call: {fn!r}")
        result = self.responses[fn]
        if isinstance(result, BaseException):
            return {"__err": str(result)}
        return {"__ok": result}


async def test_fetch_schedule_for_date_returns_flights():
    frame = FakeUserFrame({"getStudentSchedule": [
        {"date": "2026-07-31", "bookingId": "BK-1", "status": "Pending"},
        {"date": "2026-07-31", "bookingId": "BK-2", "status": "Canceled"},
    ]})
    flights = await fs._fetch_schedule_for_date(frame, "2026-07-31")
    assert len(flights) == 2
    assert flights[0]["bookingId"] == "BK-1"
    assert flights[1]["status"] == "Canceled"


async def test_fetch_schedule_for_date_allows_empty():
    frame = FakeUserFrame({"getStudentSchedule": []})
    flights = await fs._fetch_schedule_for_date(frame, "2026-07-31")
    assert flights == []


async def test_fetch_schedule_for_date_rejects_mismatched_date():
    frame = FakeUserFrame({"getStudentSchedule": [
        {"date": "2026-08-01", "bookingId": "BK-9", "status": "Pending"},
    ]})
    with pytest.raises(ValueError):
        await fs._fetch_schedule_for_date(frame, "2026-07-31")


async def test_fetch_schedule_for_date_propagates_rpc_error():
    frame = FakeUserFrame({"getStudentSchedule": RuntimeError("timeout 45s")})
    with pytest.raises(RuntimeError):
        await fs._fetch_schedule_for_date(frame, "2026-07-31")


async def test_fetch_schedule_for_date_passes_date_and_timeout():
    frame = FakeUserFrame({"getStudentSchedule": []})
    await fs._fetch_schedule_for_date(frame, "2026-07-31", timeout_s=60)
    fn, call_args, timeout_s = frame.calls[0]
    assert fn == "getStudentSchedule"
    assert call_args == [{"date": "2026-07-31"}]
    assert timeout_s == 60
