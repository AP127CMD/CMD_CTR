"""Dev tool: probe the Ops Portal's internal google.script.run API (read-only).

Usage:  python scripts/probe_portal_api.py [fn] [json-args...]
  no args        → list all server function names
  fn + args      → call one read-only function and print the JSON result
                   e.g.  python scripts/probe_portal_api.py getSofForDate '{"date":"2026-07-16"}'

Full verified inventory: AP127_Docs README §4.1.1 (probed 2026-07-16).
SAFETY: refuses to call mutating functions (submit*/write*/fix*/backfill*/ensure*).
"""
import asyncio
import json
import re
import sys

from playwright.async_api import async_playwright

from fetch_schedule import SCRIPT_URL, LOAD_TIMEOUT_MS, _get_content_frame, _rpc

MUTATING = re.compile(r"^(submit|write|fix|backfill|ensure)", re.I)


async def main():
    fn = sys.argv[1] if len(sys.argv) > 1 else None
    args = [json.loads(a) for a in sys.argv[2:]]
    if fn and MUTATING.match(fn):
        sys.exit(f"REFUSED: {fn} looks like a mutating function — this tool is read-only.")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await (await browser.new_context()).new_page()
        print(f"Navigating to portal …", file=sys.stderr)
        await page.goto(SCRIPT_URL, wait_until="networkidle", timeout=LOAD_TIMEOUT_MS)
        frame = await _get_content_frame(page)
        await page.wait_for_timeout(2000)

        if not fn:
            names = await frame.evaluate(
                "() => Object.keys(google.script.run).filter(k => typeof google.script.run[k] === 'function')"
            )
            skip = {"withSuccessHandler", "withFailureHandler", "withLogger", "withUserObject"}
            for n in sorted(set(names) - skip):
                print(("MUTATING  " if MUTATING.match(n) else "read?     ") + n)
        else:
            result = await _rpc(frame, fn, *args, timeout_s=120)
            print(json.dumps(result, ensure_ascii=False, indent=2))

        await browser.close()


asyncio.run(main())
