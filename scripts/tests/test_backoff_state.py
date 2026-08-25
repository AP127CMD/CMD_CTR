import json

import fetch_schedule as fs
import pytest


@pytest.fixture(autouse=True)
def _fast_retries(monkeypatch):
    """Keep main_with_retry() tests instant — no real backoff sleeps."""
    monkeypatch.setattr(fs, "MAX_ATTEMPTS", 3)
    monkeypatch.setattr(fs, "RETRY_DELAY_S", 0)

    async def _no_sleep(_seconds):
        return None

    monkeypatch.setattr(fs.asyncio, "sleep", _no_sleep)


@pytest.fixture
def state_file(tmp_path, monkeypatch):
    path = tmp_path / "backoff_state.json"
    monkeypatch.setattr(fs, "BACKOFF_STATE_FILE", path)
    return path


def test_read_prior_backoff_failures_missing_file(state_file):
    assert fs._read_prior_backoff_failures() == 0


def test_read_prior_backoff_failures_malformed_json(state_file):
    state_file.write_text("not json", encoding="utf-8")
    assert fs._read_prior_backoff_failures() == 0


def test_write_then_read_round_trips(state_file):
    fs._write_backoff_state(4)
    assert fs._read_prior_backoff_failures() == 4
    data = json.loads(state_file.read_text(encoding="utf-8"))
    assert data["consecutiveFailures"] == 4
    assert data["lastAttemptAt"].endswith("Z")


async def test_main_with_retry_success_from_healthy_leaves_file_untouched(
    state_file, monkeypatch
):
    """A success after success has nothing to clear — don't write, so the CI
    workflow's git-diff-based "skip commit if nothing changed" fast path for
    this file still works on the common healthy-every-run case."""

    async def _ok():
        return None

    monkeypatch.setattr(fs, "main", _ok)
    await fs.main_with_retry()
    assert not state_file.exists()


async def test_main_with_retry_success_resets_existing_streak(state_file, monkeypatch):
    fs._write_backoff_state(5)

    async def _ok():
        return None

    monkeypatch.setattr(fs, "main", _ok)
    await fs.main_with_retry()
    assert fs._read_prior_backoff_failures() == 0


async def test_main_with_retry_exhausted_failure_increments_streak(
    state_file, monkeypatch
):
    fs._write_backoff_state(2)

    async def _always_fails():
        raise RuntimeError("userHtmlFrame never appeared")

    monkeypatch.setattr(fs, "main", _always_fails)
    with pytest.raises(SystemExit) as exc_info:
        await fs.main_with_retry()
    assert exc_info.value.code == 1
    assert fs._read_prior_backoff_failures() == 3


async def test_main_with_retry_exhausted_failure_from_no_prior_state_starts_at_one(
    state_file, monkeypatch
):
    async def _always_fails():
        raise RuntimeError("boom")

    monkeypatch.setattr(fs, "main", _always_fails)
    with pytest.raises(SystemExit):
        await fs.main_with_retry()
    assert fs._read_prior_backoff_failures() == 1
