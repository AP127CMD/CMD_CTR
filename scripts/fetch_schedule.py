import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

SCRIPT_URL = (
    "https://script.google.com/macros/s/"
    "AKfycbzsOcPHLUpD5U8Qyq-x78edIOMUr28NJAp0KTvJvYCW6IQ_yG-HB97aRue8aFoxGQ5lJg/exec"
)
OUTPUT_FILE = Path(__file__).parent.parent / "data" / "flight_schedule.json"
LOAD_TIMEOUT_MS = 90_000   # 90 s total page load budget (GAS cold-starts can be slow)
POLL_INTERVAL_MS = 500     # check every 0.5 s
MAX_POLL_TRIES = 80        # 40 s of polling after page load

# Retry config — overridable via env vars set in the workflow.
MAX_ATTEMPTS  = int(os.environ.get("FETCH_MAX_ATTEMPTS", "3"))
RETRY_DELAY_S = int(os.environ.get("FETCH_RETRY_DELAY",  "20"))

TIMEZONE = "Asia/Bangkok"
VALID_STATUSES = {"Pending", "Completed", "Canceled"}

# Fields every schedule entry must carry. A missing field is a hard error.
REQUIRED_ENTRY_FIELDS = {
    "date", "rowIdx", "realRowIdx", "status", "isActual",
    "student", "instructor", "batch", "lesson",
    "start", "end", "duration", "planDur", "condition",
    "type", "tail", "actualType",
    "tkoff", "ldgTime", "airborne",
    "ldg", "to", "inst",
}

# Fields seen in the source as of the last schema review.
# Extra fields beyond this set trigger a warning so new upstream data is noticed.
# cancelReason is optional — only present on Canceled entries.
KNOWN_ENTRY_FIELDS = REQUIRED_ENTRY_FIELDS | {"cancelReason"}

_DURATION_RE = re.compile(r"^\d+:\d{2}$")
_TIME_RE = re.compile(r"^\d{2}:\d{2}$")
# rowIdx is either a booking ID string ("BK-XXXX-NNNN" / "BK-XXXX-NNNN_ACT_NNNN")
# or "UNPLANNED_ACT_NNNN" for flights with no scheduled slot.
_ROW_IDX_RE = re.compile(r"^BK-[A-Z0-9]{4}-\d+(_ACT_\d+)?$|^UNPLANNED_ACT_\d+$")


def _schedules_list_to_dict(schedules_list):
    """Convert a flat list of entries (each with a 'date' key) to a dict keyed by date."""
    result = {}
    for entry in schedules_list:
        d = entry.get("date", "unknown")
        result.setdefault(d, []).append(entry)
    return result


def validate_raw_cache(cache):
    """
    Check raw cache structure before normalization.

    Returns (warnings, errors). Errors mean our normalization logic will
    break or produce wrong output; warnings mean upstream drift worth
    investigating but not immediately fatal.
    """
    warnings = []
    errors = []

    # ── Top-level keys ────────────────────────────────────────────────────────
    required_top = {"schedules", "leaves", "instructors", "resources"}
    missing_top = required_top - set(cache)
    extra_top = set(cache) - required_top
    if missing_top:
        errors.append(f"Missing top-level keys: {sorted(missing_top)}")
    if extra_top:
        warnings.append(f"New top-level keys (upstream addition): {sorted(extra_top)}")

    schedules = cache.get("schedules", {})
    if isinstance(schedules, list):
        # Source now emits a flat list; normalize to dict keyed by date for validation.
        schedules = _schedules_list_to_dict(schedules)
    elif not isinstance(schedules, dict):
        errors.append(f"'schedules' is not a dict or list (got {type(schedules).__name__})")
        return warnings, errors

    # ── Per-entry checks ──────────────────────────────────────────────────────
    new_statuses: set = set()
    new_fields: set = set()

    for date, entries in schedules.items():
        if not isinstance(entries, list):
            errors.append(f"schedules[{date!r}] is not a list")
            continue

        for entry in entries:
            ref = f"date={date} rowIdx={entry.get('rowIdx', '?')!r}"

            # Missing required fields
            missing = REQUIRED_ENTRY_FIELDS - set(entry)
            if missing:
                errors.append(f"{ref}: missing fields {sorted(missing)}")

            # Unknown new fields
            extra = set(entry) - KNOWN_ENTRY_FIELDS
            if extra:
                new_fields.update(extra)

            # rowIdx must be a booking ID string.
            raw_idx = str(entry.get("rowIdx", ""))
            if not _ROW_IDX_RE.match(raw_idx):
                warnings.append(f"{ref}: unexpected rowIdx format: {raw_idx!r}")

            # isActual must be bool
            if not isinstance(entry.get("isActual"), bool):
                errors.append(
                    f"{ref}: isActual expected bool, "
                    f"got {type(entry.get('isActual')).__name__}: {entry.get('isActual')!r}"
                )

            # ldg / to / inst must be int
            for field in ("ldg", "to", "inst"):
                val = entry.get(field)
                if not isinstance(val, int):
                    errors.append(
                        f"{ref}: {field} expected int, "
                        f"got {type(val).__name__}: {val!r}"
                    )

            # duration must be "H…:MM" or "-" (missing)
            duration = entry.get("duration", "")
            if duration and duration != "-" and not _DURATION_RE.match(duration):
                errors.append(f"{ref}: duration has unexpected format: {duration!r}")

            # start / end must be "HH:MM"
            for field in ("start", "end"):
                val = entry.get(field, "")
                if val and not _TIME_RE.match(val):
                    errors.append(f"{ref}: {field} has unexpected format: {val!r}")

            # status drift (non-fatal — we default unknowns to "Pending")
            status = entry.get("status")
            if status not in VALID_STATUSES:
                new_statuses.add(status)

    if new_fields:
        warnings.append(f"New entry fields from upstream (review for usefulness): {sorted(new_fields)}")
    if new_statuses:
        warnings.append(
            f"Unknown status values (defaulted to 'Pending'): {sorted(str(s) for s in new_statuses)}"
        )

    return warnings, errors


def _null_dash(value):
    return None if value == "-" else value


def _null_empty(value):
    return None if value == "" else value


def _parse_duration_min(duration_str):
    """Convert 'HH:MM' to total minutes as int, or None if unparseable."""
    try:
        h, m = duration_str.split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return None


def normalize_entry(entry, date):
    """Return a normalized schedule entry ready for dashboard consumption."""
    row_idx = entry.get("rowIdx")  # booking ID string, e.g. "BK-MR1E-8318"

    real_row_idx_raw = entry.get("realRowIdx")
    try:
        real_row_idx = int(real_row_idx_raw) if str(real_row_idx_raw or "").isdigit() else real_row_idx_raw
    except (TypeError, ValueError):
        real_row_idx = real_row_idx_raw

    duration_str = entry.get("duration") or ""
    plan_dur_str = entry.get("planDur") or ""
    ac_type = entry.get("type") or ""
    status = entry.get("status")
    raw_condition = _null_empty(_null_dash(entry.get("condition") or ""))
    is_standby = isinstance(raw_condition, str) and "(Standby)" in raw_condition
    condition = raw_condition.replace(" (Standby)", "").strip() if is_standby else raw_condition

    return {
        "id": str(row_idx),
        "date": date,
        "rowIdx": row_idx,
        "realRowIdx": real_row_idx,
        "status": status if status in VALID_STATUSES else "Pending",
        "isActual": bool(entry.get("isActual", False)),
        "isSimulator": "(SIM)" in ac_type,
        "isStandby": is_standby,
        # scheduling
        "start": entry.get("start"),
        "end": entry.get("end"),
        "duration": duration_str or None,
        "durationMin": _parse_duration_min(duration_str),
        "planDur": plan_dur_str or None,
        "planDurMin": _parse_duration_min(plan_dur_str),
        # people
        "student": _null_dash(entry.get("student")),
        "instructor": _null_dash(entry.get("instructor")),
        "batch": entry.get("batch"),
        "lesson": entry.get("lesson"),
        "condition": condition,
        # aircraft
        "type": _null_empty(_null_dash(ac_type)),
        "tail": _null_dash(entry.get("tail")),
        # actuals (populated after flight)
        "actualType": _null_empty(entry.get("actualType")),
        "tkoff": _null_dash(entry.get("tkoff")),
        "ldgTime": _null_dash(entry.get("ldgTime")),
        "airborne": _null_dash(entry.get("airborne")),
        "ldg": entry.get("ldg"),
        "to": entry.get("to"),
        "inst": entry.get("inst"),
        # cancellation
        "cancelReason": _null_empty(entry.get("cancelReason")),
    }


async def get_iframe_flight_cache(page):
    """Return the flightCache object from inside the sandbox iframe."""
    # The iframe src is set dynamically; wait for it to appear.
    await page.wait_for_selector("#sandboxFrame", timeout=LOAD_TIMEOUT_MS)

    # Give the iframe a moment to receive its src and start loading.
    await page.wait_for_timeout(2000)

    sandbox_frame = None
    for _ in range(MAX_POLL_TRIES):
        # Playwright exposes all frames including cross-origin ones.
        for frame in page.frames:
            if frame == page.main_frame:
                continue
            try:
                cache = await frame.evaluate(
                    "() => { var fc = window.flightCache; "
                    "if (!fc || !fc.schedules) return null; "
                    "var s = fc.schedules; "
                    "return (Array.isArray(s) ? s.length : Object.keys(s).length) > 0 "
                    "? fc : null; }"
                )
                if cache:
                    return cache
            except Exception:
                pass
        await page.wait_for_timeout(POLL_INTERVAL_MS)

    # Last attempt — return whatever is there even if schedules is empty.
    for frame in page.frames:
        if frame == page.main_frame:
            continue
        try:
            cache = await frame.evaluate(
                "() => typeof window.flightCache !== 'undefined' ? window.flightCache : null"
            )
            if cache is not None:
                return cache
        except Exception:
            pass

    return None


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        )
        page = await context.new_page()

        print(f"Navigating to {SCRIPT_URL} …")
        try:
            await page.goto(SCRIPT_URL, wait_until="domcontentloaded", timeout=LOAD_TIMEOUT_MS)
        except PlaywrightTimeoutError:
            print("ERROR: Page load timed out.", file=sys.stderr)
            await browser.close()
            sys.exit(1)

        print("Waiting for flight cache data …")
        cache = await get_iframe_flight_cache(page)
        await browser.close()

    if cache is None:
        print("ERROR: Could not retrieve flightCache from the page.", file=sys.stderr)
        sys.exit(1)

    warnings, errors = validate_raw_cache(cache)
    for msg in warnings:
        print(f"WARNING: {msg}", file=sys.stderr)
    for msg in errors:
        print(f"ERROR: {msg}", file=sys.stderr)
    if errors:
        print(
            f"Schema validation failed ({len(errors)} error(s)). "
            "Data not saved — fix normalization before retrying.",
            file=sys.stderr,
        )
        sys.exit(1)
    if warnings:
        print(f"Schema validation passed with {len(warnings)} warning(s). Review stderr.", file=sys.stderr)

    raw_schedules = cache.get("schedules", {})
    if isinstance(raw_schedules, list):
        raw_schedules = _schedules_list_to_dict(raw_schedules)
    new_schedules = {
        date: [normalize_entry(entry, date) for entry in entries]
        for date, entries in raw_schedules.items()
    }

    # ── Merge with existing data ───────────────────────────────────────────────
    # Load the on-disk file (if any) so dates outside the rolling window are kept.
    # Dates present in the fresh fetch overwrite the stored version (newer = more
    # accurate statuses).  Dates only in the stored file are preserved as-is.
    BACKUP_FILE = OUTPUT_FILE.with_name("flight_schedule.backup.json")

    existing_schedules = {}
    if OUTPUT_FILE.exists():
        try:
            existing = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
            existing_schedules = existing.get("schedules", {})
        except Exception as e:
            print(f"WARNING: could not read existing file for merge: {e}", file=sys.stderr)

        # Back up before overwriting
        try:
            BACKUP_FILE.write_bytes(OUTPUT_FILE.read_bytes())
        except Exception as e:
            print(f"WARNING: could not write backup: {e}", file=sys.stderr)

    # Merge: existing dates first (preserves history), then new fetch overwrites
    # any date it covers.
    merged_schedules = {**existing_schedules, **new_schedules}

    new_dates  = set(new_schedules.keys())
    kept_dates = set(existing_schedules.keys()) - new_dates
    print(f"Fetched {sum(len(v) for v in new_schedules.values())} flights across {len(new_dates)} date(s).")
    if kept_dates:
        print(f"Preserved {len(kept_dates)} historical date(s) not in current window: "
              f"{', '.join(sorted(kept_dates))}")

    output = {
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timezone": TIMEZONE,
        "schedules": dict(sorted(merged_schedules.items())),  # chronological order
        "leaves": cache.get("leaves", []),
        "instructors": cache.get("instructors", []),
        "resources": cache.get("resources", []),
    }

    total_count = sum(len(v) for v in output["schedules"].values())
    print(f"Total after merge: {total_count} flights across {len(output['schedules'])} date(s).")

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved → {OUTPUT_FILE}")


async def main_with_retry():
    """Run main() up to MAX_ATTEMPTS times with exponential-ish backoff."""
    last_exc = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            await main()
            return  # success
        except SystemExit as exc:
            if exc.code == 0:
                return
            last_exc = exc
            if attempt < MAX_ATTEMPTS:
                wait = RETRY_DELAY_S * attempt
                print(
                    f"Attempt {attempt}/{MAX_ATTEMPTS} failed (exit {exc.code}). "
                    f"Retrying in {wait}s …",
                    file=sys.stderr,
                )
                await asyncio.sleep(wait)
            else:
                print(
                    f"All {MAX_ATTEMPTS} attempts failed. Giving up.",
                    file=sys.stderr,
                )
    sys.exit(last_exc.code if last_exc else 1)


if __name__ == "__main__":
    asyncio.run(main_with_retry())
