# Data-Plane Decoupling + Min Portal→Telegram Latency — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Data updates stop triggering Cloudflare Pages builds, and schedule changes reach Telegram within seconds of a Pi commit — all on the free plan with **no payment method on file**.

**Architecture:** A stateless `ap127-data` Worker proxies `raw.githubusercontent.com` — the data is already committed to git every cycle; the Worker re-serves `flight-data.js` / `flight-data-recent.js` / `cache.json` with a browser `Content-Type` + 60 s edge cache. `Cache-Control: no-cache` (watchdog/dispatcher) bypasses both caches for a seconds-fresh read. Browsers and backend Workers read from the Worker; git commits still happen but Pages **build watch paths** exclude the data files so no rebuild fires. The watchdog gains `POST /notify` so a Pi/CI publish triggers the Telegram diff immediately.

**Tech Stack:** Cloudflare Workers (wrangler, no bindings), plain Vitest (fetch/caches stubbed), bash (`pi-native/run_fetch.sh`), GitHub Actions YAML, Python 3 (Phase 2).

**Spec:** `docs/superpowers/specs/2026-09-06-r2-data-plane-decoupling-design.md`

## Global Constraints

- **Data Worker URL (verbatim everywhere):** `https://ap127-data.anusorn-tanmetha.workers.dev`
- **Keys → upstream:** `flight-data.js` & `flight-data-recent.js` → `raw.githubusercontent.com/AP127CMD/CMD_CTR/main/…`; `cache.json` → `raw.githubusercontent.com/AP127CMD/DB001/main/cache.json`.
- **No new secrets except `WATCHDOG_NOTIFY_KEY`** (= the watchdog's existing `WATCHDOG_API_KEY` value) on the Pi `.env` and the CMD_CTR repo. No R2, no bucket, no write token.
- All three repos (`CMD_CTR`, `CMDV2`, `DB001`) are **public** → Actions minutes free; do not privatise.
- `/notify` calls and any curl to the Worker are **non-fatal** — never break the git commit path.
- **Do not `git push` a repo until its rollout step says so** — CMD_CTR/CMDV2/DB001 auto-deploy on push; the browser repoint must not land before the Worker is live.
- Commit style: small, TDD where logic exists, conventional prefixes, trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **Unchanged:** `STALE_TAKEOVER_MIN=35` (dispatcher), `DATA_STALE_LIMIT_MIN=60` (`ap127-watchdog-monitor`).

---

## Status — PHASE 1 SHIPPED & VERIFIED LIVE (2026-09-06)

| Piece | State |
|---|---|
| `ap127-data` Worker | Deployed. 20 vitest green. Live-fixed 3 bugs: HEAD support; dropped `?_=` buster (raw.github 404s on forced origin miss); slice Range locally (Fastly returned a stale `Content-Range` total). Stale-fallback on any upstream non-200. |
| CMD_CTR `index.html` (r46) | Loads `flight-data.js` from the Worker. Verified live: 6,109 flights, console clean, Day Glance renders. |
| CMDV2 5 entrypoints + `flight-data.js` deleted + `refresh_snapshots.mjs` trimmed + `refresh-data.yml` | Verified live: 5,175 flights, console clean, overview/crosscheck render. |
| DB_Share `functions/mirror/[[path]].js` | Routes data files to the Worker (would have 404'd once CMDV2 deleted `flight-data.js`). Verified live: PROGRESS V4 renders. |
| Backend Workers | **Kept on raw.github** — a Worker can't fetch a same-account `*.workers.dev` URL (CF 1042; verified). Only the `dispatcher` gained `Cache-Control: no-cache` on its age fetch. Both redeployed. |
| Watchdog `/notify` + `NOTIFY_KEY` + cron `*/2` | Deployed. 136 vitest green. `/notify` → 202 verified; wrong key → 401. |
| Pi + CI `/notify` callers | Committed + pushed. `WATCHDOG_NOTIFY_KEY` set on the Pi `.env` and the CMD_CTR repo. Pi confirmed running the new `run_fetch.sh`. |
| `[CI Skip]` on all 4 data-commit sites | **Replaces build-watch-paths** (Pages API silently drops `path_excludes`). Verified live: `ap127-db001` + `ap127-cmd-ctr` data commits → deployment status `idle` (skipped, off the 500/mo cap). |
| Dispatcher DB001 → */15 | Deployed. Verified live: dispatched at :15, skipped :05/:10; DB001 update-cache runs now 15 min apart. |
| Docs | CLAUDE.md ×3 + `/Users/nugui/CLAUDE.md` + spec + this plan + `AP127_Docs` §10 — done. |

**Remaining:** `pi-native/README.md` touch-up · 48 h soak watch · **Phase 2** (below).

---

## Task 2: Deploy the Worker + verify

**Files:** none. `cd /Users/nugui/flight-schedule-feed/data-worker`.

- [ ] **Step 1: Deploy**

Run: `npx wrangler deploy`
Expected: `Published ap127-data` + the `https://ap127-data.anusorn-tanmetha.workers.dev` route. (No bucket, no secret — the Worker has no bindings.)

- [ ] **Step 2: Verify the contract against the live Worker**

```bash
U=https://ap127-data.anusorn-tanmetha.workers.dev
curl -sI "$U/flight-data.js"        | grep -Ei 'HTTP/|content-type|cache-control'   # 200, application/javascript, max-age=60
curl -sI "$U/cache.json"            | grep -Ei 'content-type'                        # application/json
curl -s -H 'Range: bytes=0-599' "$U/flight-data-recent.js" | grep -o '"fetchedAt":"[^"]*"'   # prints the timestamp
curl -s -H 'Cache-Control: no-cache' -o /dev/null -w 'no-cache GET: %{http_code}\n' "$U/flight-data-recent.js"  # 200
curl -s -o /dev/null -w 'unknown key: %{http_code}\n' "$U/secrets.env"               # 404
```
Expected: all as annotated.

- [ ] **Step 3: No commit** (deploy only).

---

## Task 3: Repoint CMD_CTR's browser consumer

**Files:** `flight-schedule-feed/index.html:37`

- [ ] **Step 1: Swap the script src**

Line 37 — replace:
```html
<script src="flight-data.js?v=1778610943"></script>
```
with:
```html
<script src="https://ap127-data.anusorn-tanmetha.workers.dev/flight-data.js"></script>
```

- [ ] **Step 2: Bump the cache token**

Run: `cd /Users/nugui/flight-schedule-feed && grep -o '?v=r[0-9]*' index.html | sort -u`
Bump every `?v=r45` → `?v=r46` in `index.html`.

- [ ] **Step 3: Commit + push**

```bash
git add index.html
git commit -m "r46: load flight-data.js from the ap127-data Worker

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git pull --rebase
git push origin main
```

- [ ] **Step 4: Verify live** (after the Pages deploy, ~1 min)

- Browser preview `https://ap127-cmd-ctr.pages.dev` — Network: `flight-data.js` → `ap127-data.anusorn-tanmetha.workers.dev`, 200, `content-type: application/javascript`.
- Console clean; a flight-count view shows the same numbers as before.

---

## Task 4: Repoint CMDV2's browser consumers + drop the mirror

**Files:** `AP127_V2/index.html:53`, `legacy.html:67`, `ops/index.html:37`, `crosscheck/index.html:91`, `overview/index.html:64`; delete `AP127_V2/flight-data.js`; `AP127_V2/scripts/refresh_snapshots.mjs`

- [ ] **Step 1: Swap all five script tags** to
  `<script src="https://ap127-data.anusorn-tanmetha.workers.dev/flight-data.js"></script>`
  (preserve indentation; `crosscheck`/`overview` were `../flight-data.js`).

Confirm none missed: `cd /Users/nugui/AP127_V2 && grep -rn 'src="\.\{0,3\}/\{0,1\}flight-data\.js' --include=*.html .` → no matches.

- [ ] **Step 2: Delete the stale mirror**

Run: `git rm flight-data.js`

- [ ] **Step 3: Trim `refresh_snapshots.mjs`**

- Remove the `await refreshSource('flight-data', …)` block and the now-unused `FLIGHT_SRC` const.
- Change `NGT_SRC` from `'https://ap127-db001.pages.dev/cache.json'` to `'https://ap127-data.anusorn-tanmetha.workers.dev/cache.json'`.
- Leave the `progress-data` block + `PROGRESS_SRC` untouched.
- Update the file header comment (source 1 is no longer mirrored — the browser reads it from the Worker).

Run: `node --check scripts/refresh_snapshots.mjs` → clean.

- [ ] **Step 4: Bump CMDV2's cache token** per its CLAUDE.md rule (`?v=pNNN` in `index.html`).

- [ ] **Step 5: Commit + push**

```bash
git add index.html legacy.html ops/index.html crosscheck/index.html overview/index.html scripts/refresh_snapshots.mjs
git rm flight-data.js
git commit -m "pNNN: load flight-data.js from the ap127-data Worker; drop the local mirror

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git pull --rebase && git push origin main
```

- [ ] **Step 6: Verify live**

- `https://ap127-ngt2.pages.dev`, `/overview/`, `/crosscheck/` — render; Network shows the Worker; console clean.
- `https://ap127-dashboardr1.pages.dev` (DB_Share proxy) — Detail view still renders.
- `gh workflow run "Refresh data snapshots" -R AP127CMD/CMDV2` → run logs no longer mention flight-data; progress/ngt still refresh.

---

## Task 5: Repoint + deploy the backend Workers

**Files:** `AP127_V2/watchdog/src/index.js` (`FLIGHT_SRC`), `AP127_NGT_001/dispatcher/worker.js` (`FEED_URL`)

- [ ] **Step 1: Watchdog `FLIGHT_SRC`**

`AP127_V2/watchdog/src/index.js` — change
```js
const FLIGHT_SRC = 'https://raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data-recent.js';
```
to
```js
const FLIGHT_SRC = 'https://ap127-data.anusorn-tanmetha.workers.dev/flight-data-recent.js';
```
`fetchFeedText()` already sends `{ headers: { 'cache-control': 'no-cache' } }` — that triggers the Worker's fresh-read path. Update the adjacent comment.

- [ ] **Step 2: Dispatcher `FEED_URL`**

`AP127_NGT_001/dispatcher/worker.js` line ~81 — change the `raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data-recent.js` URL to `https://ap127-data.anusorn-tanmetha.workers.dev/flight-data-recent.js`. In `feedAgeMinutes()` the fetch sends `Range: bytes=0-599`; **also add** `'Cache-Control': 'no-cache'` to that fetch's headers so the age check is never fooled by a cached read. Update the comment about `raw.github` honouring Range → the Worker forwards Range.

- [ ] **Step 3: Tests**

```bash
cd /Users/nugui/AP127_V2/watchdog && npx vitest run          # 135 green
cd /Users/nugui/AP127_NGT_001/dispatcher && npx vitest run   # 3 green
```

- [ ] **Step 4: Commit + deploy**

```bash
cd /Users/nugui/AP127_V2/watchdog
git add src/index.js && git commit -m "feat(watchdog): read the feed from the ap127-data Worker

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
npx wrangler deploy

cd /Users/nugui/AP127_NGT_001
git add dispatcher/worker.js && git commit -m "feat(dispatcher): read feed age from the ap127-data Worker (no-cache)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git pull --rebase && git push origin main   # dispatcher auto-deploys via deploy-dispatcher.yml
```

- [ ] **Step 5: Verify** — `wrangler tail ap127-watchdog` and `wrangler tail ap127-dispatcher` across a couple of ticks: no `Upstream HTTP` errors; dispatcher logs a plausible `feed age N min` (not `age-unknown`).

Note: Step 4 pushes the watchdog `/notify` + cron commit (`07897115`) and the dispatcher `*/15` commit (`797faff35`) too — they're already committed locally, this is where they ship.

---

## Task 6: Deploy the watchdog `/notify` + wire the callers

**Files:** `flight-schedule-feed/pi-native/run_fetch.sh`, `flight-schedule-feed/pi-native/.env.example`, `flight-schedule-feed/.github/workflows/fetch_schedule.yml`

The watchdog code (`/notify` route + `*/2` cron) is committed (`07897115`) and deploys in Task 5 Step 4. This task adds the callers.

- [ ] **Step 1: Pi — call `/notify` at the end of `run_fetch.sh`**

Append after the final CMDV2-refresh curl block:
```bash
# Push-trigger the watchdog so a schedule change reaches Telegram in seconds
# rather than on its next */2 cron tick. Non-fatal, single attempt.
if [ -n "${WATCHDOG_NOTIFY_KEY:-}" ]; then
  curl -fsS -m 15 -X POST \
    -H "X-API-Key: ${WATCHDOG_NOTIFY_KEY}" \
    "https://ap127-watchdog.anusorn-tanmetha.workers.dev/notify" >/dev/null \
    && echo "watchdog /notify ✓" \
    || echo "WARNING: watchdog /notify failed (non-fatal)" >&2
fi
```

- [ ] **Step 2: Document the env key**

Append to `pi-native/.env.example`:
```bash
# API key for the watchdog's POST /notify push endpoint. Same value as the
# ap127-watchdog Worker's WATCHDOG_API_KEY secret. See
# docs/superpowers/specs/2026-09-06-r2-data-plane-decoupling-design.md
WATCHDOG_NOTIFY_KEY=
```

- [ ] **Step 3: CI — add a step after `Trigger CMDV2 refresh` in `fetch_schedule.yml`**

```yaml
      - name: Notify watchdog
        if: success() && steps.backoff.outputs.skip != 'true'
        env:
          WATCHDOG_NOTIFY_KEY: ${{ secrets.WATCHDOG_NOTIFY_KEY }}
        run: |
          [ -n "$WATCHDOG_NOTIFY_KEY" ] || { echo "key unset — skipping"; exit 0; }
          curl -fsS -m 15 -X POST -H "X-API-Key: $WATCHDOG_NOTIFY_KEY" \
            https://ap127-watchdog.anusorn-tanmetha.workers.dev/notify >/dev/null \
            && echo "watchdog notified" || echo "::warning::watchdog /notify failed"
```

- [ ] **Step 4: Lint + commit + push**

```bash
cd /Users/nugui/flight-schedule-feed
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/fetch_schedule.yml')); print('ok')"
shellcheck pi-native/run_fetch.sh || true
git add pi-native/run_fetch.sh pi-native/.env.example .github/workflows/fetch_schedule.yml
git commit -m "feat: push-trigger the watchdog after a data publish

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git pull --rebase && git push origin main
```

- [ ] **Step 5: Secrets** (user)

```bash
gh secret set WATCHDOG_NOTIFY_KEY -R AP127CMD/CMD_CTR      # value = the watchdog's WATCHDOG_API_KEY
```
```bash
ssh dietpi@DietPi.local "grep -q WATCHDOG_NOTIFY_KEY ~/flight-schedule-feed/pi-native/.env || echo 'WATCHDOG_NOTIFY_KEY=<key>' >> ~/flight-schedule-feed/pi-native/.env"
```

- [ ] **Step 6: Verify** — after the next Pi commit, `wrangler tail ap127-watchdog` shows a run within seconds of the commit (not aligned to the even minute). `curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-API-Key: <key>" https://ap127-watchdog.anusorn-tanmetha.workers.dev/notify` → `202`.

---

## Task 7: Pages build watch paths

**Files:** none (CF API / dashboard).

- [ ] **Step 1: Try the API**

```bash
TOK=$(python3 -c "import re;print(re.search(r'oauth_token = \"([^\"]+)\"',open('/Users/nugui/.wrangler/config/default.toml').read()).group(1))")
ACC=ae38e04e56d0ae52d3ec47ad29977587
curl -s -X PATCH -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/pages/projects/ap127-cmd-ctr" \
  -d '{"build_config":{"path_excludes":["flight-data.js","flight-data-recent.js","data/*"]}}' \
  | python3 -m json.tool | head -30
```
If `path_excludes` is accepted, repeat for:
- `ap127-ngt2`: `["flight-data.js","flight-data-recent.js","progress-data.js","ngt-data.js"]`
- `ap127-db001`: `["cache.json","student.html"]`

- [ ] **Step 2: Dashboard fallback** (if the API rejects it)

Per project: **dash.cloudflare.com → Workers & Pages → `<project>` → Settings → Build → Build watch paths → Exclude paths**, one per line, Save.

- [ ] **Step 3: Verify a data-only push is skipped**

After the next Pi commit (data-only):
```bash
TOK=…; ACC=ae38e04e56d0ae52d3ec47ad29977587
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/pages/projects/ap127-cmd-ctr/deployments?page=1&per_page=5" \
  | python3 -c 'import json,sys;[print(d["created_on"], d["latest_stage"]["status"], d["deployment_trigger"]["metadata"]["commit_message"][:44]) for d in json.load(sys.stdin)["result"]]'
```
Expected: no new deployment for the data-only commit.

- [ ] **Step 4: No commit.**

---

## Task 8: Portal mindmap + docs + soak

**Files:** `AP127_Portal/mindmap.html`, `flight-schedule-feed/CLAUDE.md`, `AP127_V2/CLAUDE.md`, `AP127_NGT_001/CLAUDE.md`, `AP127_Docs/README.md`, `flight-schedule-feed/pi-native/README.md`, `/Users/nugui/CLAUDE.md`

- [ ] **Step 1: `AP127_Portal/mindmap.html`** — update the mermaid diagram: add an `ap127-data Worker` node between the fetch workflows and the render nodes; the `R1 -->|raw.githubusercontent.com| WF3` edge and the "flight-data.js + full app code" node labels change to reflect the Worker serving the data and `refresh-data.yml` no longer mirroring it. Commit + push.

- [ ] **Step 2: CLAUDE.md ×4 + `AP127_Docs/README.md`** per the universal update rule:
  - `flight-schedule-feed/CLAUDE.md` — new "## Data plane" section (Worker URL, proxy model, `no-cache` bypass, build-watch-paths, `/notify`, Phase-2 knobs); update the fetch-roles table.
  - `AP127_V2/CLAUDE.md` — feed via the Worker; `flight-data.js` deleted; `refresh-data.yml` flight-data step gone; watchdog `*/2` + `/notify`; build watch paths.
  - `AP127_NGT_001/CLAUDE.md` — dispatcher DB001 every 15 min; build watch paths.
  - `AP127_Docs/README.md` — §2.1/§2.2/§2.4 + §10 dated log entry; `git commit && git push` in `AP127_Docs`.
  - `pi-native/README.md` — `WATCHDOG_NOTIFY_KEY`, the `/notify` call, Phase-2 cadence.
  - `/Users/nugui/CLAUDE.md` — rewrite the "Data pipeline" ecosystem bullet.
  - Commit each repo's CLAUDE.md (these pushes DO each trigger one Pages build — fine).

- [ ] **Step 3: Soak 48 h** — checklist:
  - CF deployment counts for all 3 projects flat (code deploys only). Re-run the counting script from the spec investigation.
  - `https://ap127-data.anusorn-tanmetha.workers.dev/flight-data-recent.js` `fetchedAt` tracks the newest CMD_CTR commit within ~1–2 min.
  - `ap127-watchdog` `/status` → `healthy:true`; Telegram message timestamps within seconds of the matching commit.
  - `ap127-dispatcher` tail: no `dispatcher-failure`; DB001 dispatched only on :00/:15/:30/:45.
  - No open fetch/cache/dispatch issues on any repo.

---

## PHASE 2 — cut scrape duration (after the 48 h soak)

### Task 9: Parallelise the per-date RPC

**Files:** `flight-schedule-feed/scripts/fetch_schedule.py`, `flight-schedule-feed/scripts/tests/test_concurrency.py` (new)

**Interface produced:** env var `FETCH_RPC_CONCURRENCY` (int, default `4`, `1` = today's serial behaviour).

- [ ] **Step 1: Read the date loop** — the sequential per-date `getStudentSchedule` / `_fetch_one_date` block in `scrape_window()` and its retry / stable-empty helpers. Determine whether the per-date code is `async` Playwright or `sync_api`.

- [ ] **Step 2: Write the failing test**

`scripts/tests/test_concurrency.py`:
```python
import asyncio
from scripts.fetch_schedule import _gather_dates_bounded

def test_bounded_concurrency_runs_all_and_caps_parallelism():
    active = 0
    peak = []
    async def fake(date):
        nonlocal active
        active += 1; peak.append(active)
        await asyncio.sleep(0.05)
        active -= 1
        return (date, {"flights": [date]})
    dates = [f"2026-09-{d:02d}" for d in range(1, 11)]
    out = asyncio.run(_gather_dates_bounded(dates, fake, concurrency=3))
    assert sorted(out) == sorted(dates)
    assert 2 <= max(peak) <= 3

def test_concurrency_one_is_serial():
    order = []
    async def fake(date):
        order.append(("s", date)); await asyncio.sleep(0.01); order.append(("e", date))
        return (date, {})
    asyncio.run(_gather_dates_bounded(["a","b","c"], fake, concurrency=1))
    assert order == [("s","a"),("e","a"),("s","b"),("e","b"),("s","c"),("e","c")]
```

- [ ] **Step 3: Run — expect fail** — `python -m pytest scripts/tests/test_concurrency.py -v` → `ImportError`.

- [ ] **Step 4: Implement the helper** in `scripts/fetch_schedule.py`:
```python
async def _gather_dates_bounded(dates, fetch_one, concurrency):
    """Run fetch_one(date) -> (date, result) for every date, <= concurrency at a time.
    concurrency=1 is exactly serial. Returns {date: result}."""
    sem = asyncio.Semaphore(max(1, int(concurrency)))
    out = {}
    async def run(date):
        async with sem:
            d, res = await fetch_one(date)
            out[d] = res
    await asyncio.gather(*(run(d) for d in dates))
    return out
```

- [ ] **Step 5: Run — expect pass.**

- [ ] **Step 6: Wire into `scrape_window()`**
```python
FETCH_RPC_CONCURRENCY = int(os.environ.get("FETCH_RPC_CONCURRENCY", "4"))
# replace the sequential date loop:
async def _one(date):
    return date, await _fetch_one_date_async(date)   # existing per-date logic, unchanged
results = await _gather_dates_bounded(target_dates, _one, FETCH_RPC_CONCURRENCY)
for d, res in results.items():
    schedules[d] = res
```
If the per-date code is `sync_api` Playwright: give each concurrency slot its own `context.new_page()` (a page is not thread/task-safe to share) and wrap the sync call in `asyncio.to_thread`. Decide from Step 1; note the choice in the commit message. Keep the Canceled-mode pass + leave/cancel backfill sequential. Keep every guard (`FETCH_DATE_ATTEMPTS`, stable-empty re-check, `REGRESSION_GUARD_MAX_STREAK`, frozen archive).

- [ ] **Step 7: Full suite** — `python -m pytest scripts/tests/ -v` → all green.

- [ ] **Step 8: Commit.**

- [ ] **Step 9: Live-test** — deploy with the Pi's `.env` at `FETCH_RPC_CONCURRENCY=1` (unchanged behaviour), then `=4`; watch 3–4 cycles; diff `data/flight_schedule.json` for the window against a concurrency-1 baseline (counts + statuses must match); watch for `schema-drift` / regression-guard / empty-RPC warnings; record the full-window scrape time (target ≤ 3 min). Back to `2`/`1` on any drift.

### Task 10: Flip the Pi cadence

**Files:** `flight-schedule-feed/pi-native/ap127-fetch.timer`, `flight-schedule-feed/pi-native/run_fetch.sh`

**Precondition:** Task 9 proven ≥ 24 h at concurrency 4, scrape ≤ ~4 min, no drift.

- [ ] **Step 1:** `ap127-fetch.timer` — `OnUnitActiveSec=5min` → `OnUnitActiveSec=3min`.
- [ ] **Step 2:** `run_fetch.sh` — `STANDBY_MAX_AGE_MIN="${STANDBY_MAX_AGE_MIN:-6}"` → `:-3`; update the comment.
- [ ] **Step 3:** Commit + push + deploy to the Pi:
```bash
ssh dietpi@DietPi.local "cd ~/flight-schedule-feed && git pull --rebase && sudo cp pi-native/ap127-fetch.timer /etc/systemd/system/ap127-fetch.timer && sudo systemctl daemon-reload && sudo systemctl restart ap127-fetch.timer"
```
(Confirm the deployed unit path against `pi-native/install.sh`.)
- [ ] **Step 4: Monitor a week** — cycles ~3–5 min apart, no rise in failed cycles, no new `userHtmlFrame`/session-expired patterns, Pi monitor green. Revert knobs independently if Google reacts.
- [ ] **Step 5:** Final docs pass — measured cadence numbers into all CLAUDE.md + `AP127_Docs` §10.

---

## Self-Review

**Spec coverage:** §4.1 Worker → Task 1 (done). §4.2 writers-unchanged → nothing to do. §4.3 freshness → Task 2 verify + Task 5 no-cache. §4.4 readers → Tasks 3/4/5. §4.5 build watch paths → Task 7. §4.6 `/notify` → Tasks 5 (deploy) + 6 (callers). §4.7 DB001 */15 → Task 11 (done, deploys Task 5). §5.1 → Task 9. §5.2 → Task 10. §6 rollout order → task order. §7 rollback → per-task, all git-revertible. §8 docs → Task 8. §9 open items → build-watch-paths API (Task 7 Step 1); dispatcher `scheduledTime` (Task 11 comment, done).

**Placeholder scan:** `<key>` / `pNNN` / `r46` are operator substitutions. Task 9 Step 6 sync-vs-async decision needs the file open (Step 1) — both paths given.

**Type consistency:** `_gather_dates_bounded(dates, fetch_one, concurrency)` identical Steps 2/4/6. `shouldDispatchDb001(scheduledTimeMs)` (done, `797faff35`). `/notify` → `202 {ok:true}` (done) consumed as `202` in Task 6.
