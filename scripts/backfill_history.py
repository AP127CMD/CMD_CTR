"""
One-off backfill script: fetch historical flight schedule data by driving the
GAS web app's date picker, then merge into data/flight_schedule.json.

Usage:
    python3 scripts/backfill_history.py                       # 2026-04-20 → day before oldest
    python3 scripts/backfill_history.py --from 2026-04-20
    python3 scripts/backfill_history.py --from 2026-04-20 --to 2026-05-04
    python3 scripts/backfill_history.py --from 2026-04-20 --dry-run
"""

import argparse
import asyncio
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from playwright.async_api import async_playwright

# Import shared normalisation helpers from fetch_schedule.py
# (safe: the module uses an `if __name__ == "__main__"` guard)
sys.path.insert(0, str(Path(__file__).parent))
from fetch_schedule import normalize_entry, validate_raw_cache, TIMEZONE  # noqa: E402

ROOT        = Path(__file__).parent.parent
OUTPUT_FILE = ROOT / "data" / "flight_schedule.json"
BACKUP_FILE = OUTPUT_FILE.with_name("flight_schedule.backup.json")

SCRIPT_URL       = (
    "https://script.google.com/macros/s/"
    "AKfycbzsOcPHLUpD5U8Qyq-x78edIOMUr28NJAp0KTvJvYCW6IQ_yG-HB97aRue8aFoxGQ5lJg/exec"
)
LOAD_TIMEOUT_MS  = 120_000   # 2 min — GAS cold-starts can be slow
POLL_MS          = 500
MAX_POLL         = 160       # 80 s max wait per date change


# ── Helpers ───────────────────────────────────────────────────────────────────

def date_range(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def load_existing() -> dict:
    if OUTPUT_FILE.exists():
        try:
            return json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"WARNING: could not read existing file: {e}", file=sys.stderr)
    return {}


async def find_gas_frame(page):
    """
    Return the first non-main iframe that has window.flightCache or #viewDatePicker.
    Re-called after every date change because GAS can recreate the sandboxed frame.
    """
    for frame in page.frames:
        if frame == page.main_frame:
            continue
        try:
            result = await frame.evaluate("""() => ({
                hasCache:  typeof window.flightCache !== 'undefined',
                hasPicker: !!document.querySelector('#viewDatePicker')
            })""")
            if result.get("hasCache") or result.get("hasPicker"):
                return frame
        except Exception:
            pass
    return None


async def get_schedule_keys(frame) -> frozenset:
    try:
        keys = await frame.evaluate(
            "() => Object.keys((window.flightCache || {}).schedules || {})"
        )
        return frozenset(keys)
    except Exception:
        return frozenset()


async def wait_for_initial_cache(page) -> object:
    """Wait up to LOAD_TIMEOUT_MS for flightCache to be populated after navigation."""
    for _ in range(int(LOAD_TIMEOUT_MS / POLL_MS)):
        await page.wait_for_timeout(POLL_MS)
        frame = await find_gas_frame(page)
        if frame is None:
            continue
        try:
            cache = await frame.evaluate(
                "() => (typeof window.flightCache !== 'undefined' && "
                "       window.flightCache.schedules && "
                "       Object.keys(window.flightCache.schedules).length > 0) "
                "    ? window.flightCache : null"
            )
            if cache:
                return cache
        except Exception:
            pass
    return None


async def fetch_date(browser, target_ymd: str) -> dict | None:
    """
    Open a fresh page, navigate to the GAS URL, set the date picker to
    target_ymd using Playwright's native fill+press (handles React/Vue inputs),
    and return the raw flightCache object once it reflects the target date.
    Returns None on timeout or error.
    """
    context = await browser.new_context(
        user_agent=(
            "Mozilla/5.0 (X11; Linux x86_64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    )
    page = await context.new_page()

    try:
        print(f"    navigating …", end=" ", flush=True)
        await page.goto(SCRIPT_URL, wait_until="domcontentloaded", timeout=LOAD_TIMEOUT_MS)

        # Wait for initial flightCache so the page is fully interactive
        print(f"loading …", end=" ", flush=True)
        await wait_for_initial_cache(page)

        # Find the frame containing the date picker
        picker_frame = None
        for _ in range(40):  # up to 20 s
            for frame in page.frames:
                if frame == page.main_frame:
                    continue
                try:
                    if await frame.evaluate("() => !!document.querySelector('#viewDatePicker')"):
                        picker_frame = frame
                        break
                except Exception:
                    pass
            if picker_frame:
                break
            await page.wait_for_timeout(500)

        if picker_frame is None:
            print("! no date picker found")
            return None

        # The picker is a native <input type="date"> — its .value must be YYYY-MM-DD.
        # The element may not be visible (off-screen in the iframe), so we use
        # evaluate() rather than click()/fill() which require visibility.
        print(f"setting {target_ymd} …", end=" ", flush=True)
        await picker_frame.evaluate(f"""() => {{
            const el = document.querySelector('#viewDatePicker');
            if (!el) return;
            el.value = '{target_ymd}';          // native date input needs YYYY-MM-DD
            el.dispatchEvent(new Event('change', {{ bubbles: true }}));
            el.dispatchEvent(new Event('input',  {{ bubbles: true }}));
        }}""")

        # Debug: confirm the value actually stuck
        actual_val = await picker_frame.evaluate(
            "() => document.querySelector('#viewDatePicker')?.value ?? 'NOT FOUND'"
        )
        print(f"picker={actual_val!r} …", end=" ", flush=True)

        # Snapshot keys right after the date change so we can detect the refresh
        cache_frame = await find_gas_frame(page)
        old_keys = await get_schedule_keys(cache_frame) if cache_frame else frozenset()

        # Poll until the target date appears in schedules.
        # We only accept the response when the target date is actually present —
        # avoids false positives where the GAS app returns its default June window.
        for _ in range(MAX_POLL):
            await page.wait_for_timeout(POLL_MS)
            cache_frame = await find_gas_frame(page)
            if cache_frame is None:
                continue
            try:
                new_keys = await get_schedule_keys(cache_frame)
                if target_ymd in new_keys:
                    await page.wait_for_timeout(1500)  # let all entries finish loading
                    cache_frame = await find_gas_frame(page)
                    if cache_frame is None:
                        continue
                    cache = await cache_frame.evaluate(
                        "() => typeof window.flightCache !== 'undefined' ? window.flightCache : null"
                    )
                    if cache and cache.get("schedules") and target_ymd in cache["schedules"]:
                        print(f"got {len(cache['schedules'])} date(s) ✓")
                        return cache
            except Exception:
                pass

        print("TIMEOUT")
        return None

    finally:
        await context.close()


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(
        description="Backfill historical flight schedule data from the GAS web app"
    )
    parser.add_argument("--from", dest="from_date", default="2026-04-20",
                        metavar="YYYY-MM-DD")
    parser.add_argument("--to", dest="to_date", default=None,
                        metavar="YYYY-MM-DD",
                        help="Default: day before current oldest date in JSON")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print plan without fetching")
    args = parser.parse_args()

    # ── Determine what to fetch ───────────────────────────────────────────────
    existing     = load_existing()
    existing_sch = existing.get("schedules", {})
    have_dates   = set(existing_sch.keys())

    from_date = date.fromisoformat(args.from_date)
    if args.to_date:
        to_date = date.fromisoformat(args.to_date)
    elif have_dates:
        to_date = date.fromisoformat(min(have_dates)) - timedelta(days=1)
    else:
        to_date = date.today() - timedelta(days=1)

    if from_date > to_date:
        print(f"Nothing to do: --from {from_date} is after --to {to_date}")
        return

    all_dates = [d.isoformat() for d in date_range(from_date, to_date)]
    needed    = [d for d in all_dates if d not in have_dates]

    print(f"Range          : {from_date} → {to_date}  ({len(all_dates)} calendar days)")
    print(f"Already have   : {len(all_dates) - len(needed)} date(s)")
    print(f"To fetch       : {len(needed)} date(s)")
    if needed:
        print(f"  {', '.join(needed)}")

    if not needed:
        print("All dates already present — nothing to fetch.")
        return

    if args.dry_run:
        print("\nDry-run mode: no data fetched. Remove --dry-run to proceed.")
        return

    # ── Playwright session ────────────────────────────────────────────────────
    new_schedules: dict[str, list] = {}
    remaining = list(needed)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)

        for target_ymd in list(remaining):
            if target_ymd not in remaining:
                continue  # already captured via a multi-date response

            print(f"\n[{target_ymd}] ", end="", flush=True)
            raw = await fetch_date(browser, target_ymd)

            if not raw or not raw.get("schedules"):
                print(f"  → no data")
                remaining.remove(target_ymd)
                continue

            # Validate schema (rowIdx format warnings are non-fatal; skip hard errors only)
            warnings, errors = validate_raw_cache(raw)
            for msg in warnings:
                print(f"  WARN: {msg}", file=sys.stderr)
            if errors:
                for msg in errors:
                    print(f"  ERROR: {msg}", file=sys.stderr)
                print(f"  → schema errors; skipping this response")
                remaining.remove(target_ymd)
                continue

            # Normalise and collect every new date returned
            captured_count = 0
            for date_key, entries in raw["schedules"].items():
                if date_key in have_dates:
                    continue  # don't overwrite existing data
                normalized = [normalize_entry(e, date_key) for e in entries]
                new_schedules[date_key] = normalized
                captured_count += 1
                print(f"  ✓ {date_key}: {len(normalized)} entries")
                if date_key in remaining:
                    remaining.remove(date_key)

            if captured_count == 0:
                print(f"  → response had no new dates (target date not in GAS window)")
                if target_ymd in remaining:
                    remaining.remove(target_ymd)

        await browser.close()

    # ── Merge & save ─────────────────────────────────────────────────────────
    print(f"\n─── Merge ───────────────────────────────────────────")
    merged = dict(sorted({**existing_sch, **new_schedules}.items()))
    added  = len(new_schedules)
    total  = sum(len(v) for v in merged.values())

    print(f"Existing dates : {len(existing_sch)}")
    print(f"New dates added: {added}  →  {sorted(new_schedules.keys())}")
    print(f"Total dates    : {len(merged)}")
    print(f"Total entries  : {total}")

    if not new_schedules:
        print("Nothing new was captured — file unchanged.")
        return

    # Back up before writing
    if OUTPUT_FILE.exists():
        BACKUP_FILE.write_bytes(OUTPUT_FILE.read_bytes())
        print(f"Backed up → {BACKUP_FILE.name}")

    output = {
        **{k: v for k, v in existing.items() if k not in ("schedules", "fetched_at")},
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timezone":   existing.get("timezone", TIMEZONE),
        "schedules":  merged,
    }
    OUTPUT_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved → {OUTPUT_FILE}")
    print(f"\nNext steps:")
    print(f"  python3 scripts/generate_flight_data.py")
    print(f"  git add data/flight_schedule.json flight-data.js")
    print(f"  git commit -m 'backfill: historical flight data {args.from_date} → {to_date}'")
    print(f"  git pull --rebase origin main && git push origin main")


if __name__ == "__main__":
    asyncio.run(main())
