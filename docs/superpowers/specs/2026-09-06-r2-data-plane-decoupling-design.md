# R2 Data-Plane Decoupling + Minimum Portal→Telegram Latency

**Date:** 2026-09-06
**Status:** Design — approved, pre-implementation
**Repos touched:** `AP127CMD/CMD_CTR` (primary), `AP127CMD/CMDV2`, `AP127CMD/DB001`
**Related:** `2026-07-27-rpc-based-schedule-fetch-design.md` (the RPC scraper this builds on)

---

## 1. Problem

Two coupled problems, one root cause.

### 1a. Cloudflare Pages free-tier build cap is being exceeded ~29×

The CF Pages **Free plan allows 500 builds/month, counted per account across all projects**.
Measured deployment rates (2026-08-30 → 2026-09-06, CF API):

| Pages project | deploys/day | projected/month | trigger |
|---|---|---|---|
| `ap127-cmd-ctr` | ~95 | ~2,850 | every Pi/CI flight-data commit |
| `ap127-ngt2` | ~93 | ~2,790 | every CMDV2 `refresh-data.yml` commit |
| `ap127-db001` | ~296 | ~8,900 | every dispatcher-driven `update-cache.yml` commit (*/5 cron) |
| **combined** | **~484** | **~14,540** | — |

All deployments currently succeed (0 "build limit exceeded" in the last 625 per project), so
enforcement is presently lax or the account is on a higher tier — but the ecosystem is one
policy change away from its entire data pipeline stopping. The user's stated constraint is
"stay within the free plan for all services."

Every metered service *other* than Pages builds has ample headroom:

| Service | Free limit | Current usage | Status |
|---|---|---|---|
| GitHub Actions (CMD_CTR/CMDV2/DB001) | unlimited (public repos) | — | fine |
| CF Workers requests | 100,000/day | ~1,200/day total (dispatcher + watchdog + monitor) | fine |
| CF Workers CPU | ~10 ms/invocation (free) | watchdog trimmed via `flight-data-recent.js` | managed |
| **CF Pages builds** | **500/month/account** | **~14,540/month** | **the only real constraint** |

**Root cause:** the Pi's fetch *rate* costs nothing metered — scraping Google Apps Script is
free. What consumes quota is that every data change is committed to a Git-integrated Pages repo,
so it triggers a full site rebuild. Decouple the data payloads from the Pages build and the
fetch rate becomes effectively unbounded.

### 1b. Portal→Telegram latency is ~18–23 min worst case

- A single RPC scrape of the ~18-date window takes **~12 min** (serial `getStudentSchedule`
  calls, ~33 s/date). `Type=oneshot` on the systemd timer means cycles never overlap, so the
  effective cadence is a fresh commit every **~12–18 min**.
- The watchdog Worker polls the feed on a ***/5 cron**, adding up to **5 min** more before a
  detected change becomes a Telegram message.
- Worst case: portal change → up to ~18 min to be scraped → up to ~5 min to be noticed →
  **~23 min to Telegram.**

The user wants the highest achievable refresh rate for schedule updates and Telegram notices.

---

## 2. Goals / Non-goals

**Goals**
1. All three Pages projects stop rebuilding on data-only changes; combined Pages builds drop
   from ~14,540/mo to code-deploy-only (~10–20/mo) — comfortably within the 500/mo free cap.
2. The Pi's fetch cadence is limited only by scrape duration and Google bot-detection headroom,
   not by any metered quota.
3. Minimise portal→Telegram latency: remove the watchdog poll wait, and (Phase 2) cut scrape
   duration so the effective cadence drops from ~12–18 min toward ~3–6 min.
4. Preserve today's Git history of `data/flight_schedule.json` and `flight-data.js` — it has
   been load-bearing for incident debugging.
5. Every new knob is env/secret-tunable; nothing hard-codes a cadence that can't be dialed back
   if bot-detection reacts.

**Non-goals**
- Changing the scrape *mechanism* (still the `getStudentSchedule` RPC from
  `2026-07-27-rpc-based-schedule-fetch-design.md`).
- Custom domains for the data Worker (`workers.dev` subdomain is sufficient).
- Moving `data/flight_schedule.json` / `portal_fingerprint.json` / `backoff_state.json` out of
  Git — they are shared pipeline state the Pi and CI both `git pull` every cycle and must stay.
- Touching the 35-min cloud-takeover threshold or the 60-min Telegram-staleness page in
  `ap127-watchdog-monitor` — both remain correct.

---

## 3. Architecture overview

```
                    ┌──────────────────────────────────────────┐
   Pi run_fetch.sh ─┤ PUT /flight-data.js                      │
   CI fetch_schedule┤ PUT /flight-data-recent.js   (Bearer)    │
   CI update-cache  ┤ PUT /cache.json                          │
                    │                                          │
                    │      ap127-data  Worker  ── R2 bucket    │
                    │      (public GET, token PUT)  ap127-data  │
                    └───────────────┬──────────────────────────┘
                                    │ GET (60 s cache, Range, ETag)
        ┌───────────────────────────┼─────────────────────────────┐
        │                           │                             │
  browser <script src>      watchdog Worker              dispatcher Worker
  CMD_CTR + CMDV2 pages     /flight-data-recent.js      /flight-data-recent.js
                            + POST /notify (push)        (Range 0-599)

   Git commits still happen (history + shared state) but Pages "build watch
   paths" exclude the data files, so no rebuild fires.
```

Two phases. **Phase 1** is low-risk and delivers the quota fix plus most of the latency win.
**Phase 2** speeds up the scrape itself and needs careful live testing against Google's GAS
flakiness history.

---

## 4. Phase 1 — R2 decoupling + watchdog push

### 4.1 `ap127-data` Worker

- **Location:** `flight-schedule-feed/data-worker/` (new). `src/index.js`, `wrangler.toml`,
  `test/` (Vitest + `@cloudflare/vitest-pool-workers`), `README.md`.
- **Deploy:** `npx wrangler deploy` from that dir. Not Git-integrated. Manual/CI deploy on
  change (the Worker changes rarely).
- **Bindings:** `R2` → bucket `ap127-data` (new, created via `wrangler r2 bucket create`).
- **Secret:** `DATA_WRITE_TOKEN` (via `wrangler secret put`). A long random string.
- **URL:** `https://ap127-data.anusorn-tanmetha.workers.dev`
- **Key allowlist:** `flight-data.js`, `flight-data-recent.js`, `cache.json`. Any other key →
  404 (GET) / 400 (PUT).

**`GET /<key>`**
- Full request: check `caches.default` first; on miss, `R2.get(key)`, build response,
  `ctx.waitUntil(cache.put(...))`.
- `Range` request (`Range: bytes=…`): bypass the edge cache, `R2.get(key, { range })`, return
  `206` with `Content-Range` + `Accept-Ranges: bytes`.
- Headers on 200/206:
  - `Content-Type`: `application/javascript; charset=utf-8` for `*.js`,
    `application/json; charset=utf-8` for `*.json`
  - `Cache-Control: public, max-age=60, stale-while-revalidate=240`
  - `ETag`: pass through R2 `httpEtag`
  - `Access-Control-Allow-Origin: *`
  - `Accept-Ranges: bytes`
- `If-None-Match` matches current ETag → `304`.
- Key not in R2 → `404`.

**`PUT /<key>`**
- `Authorization: Bearer <DATA_WRITE_TOKEN>` — missing/wrong → `401`.
- Key not in allowlist → `400`.
- Body > 8 MiB → `413`.
- `R2.put(key, body, { httpMetadata: { contentType } })`.
- Response `200 {"ok":true,"key":…,"size":…,"etag":…}`.

**Other methods / paths** → `405` / `404`. `OPTIONS` → CORS preflight 204.

**Tests (TDD, write first):**
- GET unknown key → 404
- GET known key returns bytes + correct `Content-Type` + `Cache-Control`
- GET with `If-None-Match: <etag>` → 304
- GET with `Range: bytes=0-99` → 206, `Content-Range`, body length 100
- PUT without token → 401; PUT bad key → 400; PUT oversize → 413
- PUT valid → 200, then GET returns the new bytes with the right content type
- round-trip: PUT `flight-data-recent.js`, GET `Range: bytes=0-599`, assert `"fetchedAt"`
  substring present (the dispatcher's real access pattern)

### 4.2 Seed R2

Before any consumer is repointed: `curl -X PUT` the *current* `flight-data.js`,
`flight-data-recent.js` (from `flight-schedule-feed/`) and `cache.json` (from a fresh
`ap127-db001.pages.dev/cache.json` fetch) into R2 via the Worker. Verify each GET.

### 4.3 Writers

All writers use the same helper shape — `curl -sf -X PUT`, **3 attempts** with a short sleep,
non-fatal (log a warning; a *persistent* failure escalates per that writer's existing
mechanism). Rationale for non-fatal: R2 being briefly unreachable should not stop a Git commit
that still records the data and still feeds `raw.githubusercontent.com`.

| Writer | File(s) | Placement | Escalation on repeated failure |
|---|---|---|---|
| `pi-native/run_fetch.sh` | `flight-data.js`, `flight-data-recent.js` | immediately **after** `generate_flight_data.py`, **before** `git add` | `report_pi_failure` (existing) |
| `.github/workflows/fetch_schedule.yml` | same two | new step after the generate step, gated `if: steps.backoff.outputs.skip != 'true'` | existing `fetch-failure` issue step |
| `DB001/.github/workflows/update-cache.yml` | `cache.json` | new step after `build-student.js` | existing `update-cache` failure issue step |

- `DATA_WRITE_TOKEN`:
  - Pi: add to `pi-native/.env` and document in `pi-native/.env.example`.
  - CMD_CTR repo: Actions secret.
  - DB001 repo: Actions secret.
- Ordering note: the Pi PUTs to R2 *before* the Git commit/push. R2 may momentarily lead Git by
  a few seconds; that is harmless (data is monotonic and the next cycle reconciles). If the Git
  push then fails, R2 is briefly ahead — also harmless.

### 4.4 Readers

**Browser `<script src>` — swap path for the Worker URL, drop `?v=` (Worker sets a 60 s cache):**

| File | Line | New src |
|---|---|---|
| `flight-schedule-feed/index.html` | 37 | `https://ap127-data.anusorn-tanmetha.workers.dev/flight-data.js` |
| `AP127_V2/index.html` | 53 | same |
| `AP127_V2/legacy.html` | 67 | same |
| `AP127_V2/ops/index.html` | 37 | same |
| `AP127_V2/crosscheck/index.html` | 91 | same (was `../flight-data.js`) |
| `AP127_V2/overview/index.html` | 64 | same (was `../flight-data.js`) |
| `AP127_Portal/mindmap.html` | TBD — inspect during impl | same if it is a `<script src>`; if a `fetch()`, point that at the Worker |

Cross-origin `<script src>` still loads synchronously and sets `window.FLIGHT_DATA`; load order
and downstream init are unaffected. DB_Share inherits the change automatically (it proxies
CMDV2's rendered output).

**Backend Workers — repoint from `raw.githubusercontent.com` to the Worker:**

| File | Change |
|---|---|
| `AP127_V2/watchdog/src/index.js` (`FLIGHT_SRC`, ~line 16) | → `https://ap127-data.anusorn-tanmetha.workers.dev/flight-data-recent.js` |
| `AP127_NGT_001/dispatcher/worker.js` (stale-check URL, ~line 82) | → `…/flight-data-recent.js` (Range `bytes=0-599` still supported) |
| `AP127_V2/scripts/refresh_snapshots.mjs` | **remove** the `flight-data` mirror step entirely; repoint the `ngt-data` step from `ap127-db001.pages.dev/cache.json` → `…/cache.json`; leave `progress-data` (from `ap127-data-api` Worker) unchanged |

- Delete `AP127_V2/flight-data.js` from the CMDV2 repo (no longer mirrored; CMDV2 reads it from
  the Worker at runtime).
- `refresh-data.yml` keeps running on its hourly cron for `progress-data.js` / `ngt-data.js`
  only. Those commits are covered by build watch paths (§4.5).

### 4.5 Pages build watch paths (dashboard, one-time)

Settings → Build → Build watch paths → **Exclude paths**:

| Project | Exclude paths |
|---|---|
| `ap127-cmd-ctr` | `flight-data.js`, `flight-data-recent.js`, `data/*` |
| `ap127-ngt2` | `flight-data.js`, `flight-data-recent.js`, `progress-data.js`, `ngt-data.js` |
| `ap127-db001` | `cache.json`, `student.html` |

- Semantics: exclude rules evaluated first; a push whose changed files are *all* excluded →
  build skipped, does not count against the 500/mo.
- Known Cloudflare override: a build fires regardless when a push has **0** file changes, **20+
  commits**, or **3000+ files changed**. The Pi's rebase-retry loop can in principle bundle
  many commits after a long outage — rare, and a handful of extra builds/month is immaterial.
- Implementation will first attempt `PATCH /accounts/{acc}/pages/projects/{name}` with the
  `build_config` `path_includes` / `path_excludes` fields; if the API rejects them, this is a
  ~2-min manual dashboard task per project with the exact values above.

### 4.6 Watchdog push endpoint (kills the poll wait)

`AP127_V2/watchdog/src/index.js` already factors its check into `runWatchdog(env)` (called by
`scheduled`). Add:

- **`POST /notify`** in `handleFetch` — require `X-API-Key: <WATCHDOG_API_KEY>` (the existing
  secret). On success: `ctx.waitUntil(runWatchdog(env))`, return `202 {"ok":true}`.
  - `runWatchdog` already no-ops cheaply when `extractFeedSig` shows the feed is unchanged, so a
    spurious or duplicate notify is safe.
- **Callers** — after a successful data publish, `curl -sf -X POST -H "X-API-Key: …"
  https://<watchdog>/notify` (non-fatal, 1 attempt):
  - `pi-native/run_fetch.sh` — after the existing "Triggering CMDV2 refresh" curl.
  - `.github/workflows/fetch_schedule.yml` — after the CMDV2 dispatch step.
  - Reuse the watchdog's existing `WATCHDOG_API_KEY` value as the `/notify` gate (see §9);
    add it as a secret to the Pi `.env` and the CMD_CTR repo.
- **Cron backstop** — tighten the watchdog cron `*/5` → `*/2` in its `wrangler.toml`. Invocations
  rise ~288/day → ~720/day (vs 100,000/day free). Per-invocation CPU is unchanged (still reads
  the small `flight-data-recent.js`, still short-circuits on unchanged `extractFeedSig`).

**Phase 1 result:** portal change → Pi scrape (≤ ~18 min, unchanged in Phase 1) → commit + R2
PUT + `/notify` → Telegram within **seconds**. The ~5 min poll wait is gone. Pages builds
flatline. Fetch cadence has no metered ceiling.

---

## 5. Phase 2 — cut scrape duration (the remaining latency)

After Phase 1 the dominant latency is the **~12 min serial scrape**. Phase 2 parallelises it.

### 5.1 Parallelise the per-date RPC

- `scripts/fetch_schedule.py` currently calls `getStudentSchedule({date})` once per date,
  sequentially, ~33 s/date × ~18 dates.
- Change: dispatch the per-date RPCs with **bounded concurrency** `FETCH_RPC_CONCURRENCY`
  (default **4**, env-tunable, `1` = today's behaviour). All existing safety layers stay:
  per-date retry (`FETCH_DATE_ATTEMPTS`), the stable-empty re-check, the merge-step regression
  guard (`REGRESSION_GUARD_MAX_STREAK`), and the frozen pre-migration archive override.
- The Canceled-mode second pass and the leave/cancel-record backfill (`LEAVE_DETAIL_MAX_PER_RUN`,
  `CANCEL_DETAIL_MAX_PER_RUN`) stay sequential for now — they are already capped per run.
- **Risk:** the historical "GAS returns stale/empty under rapid successive requests" note
  (CLAUDE.md) predates the RPC rewrite and referred to the Timeline date-picker DOM. The RPC is
  a clean JSON call, but concurrency must be proven live: run at concurrency 4 for several
  cycles, diff output against a concurrency-1 baseline for the same window, and watch the
  `schema-drift` / regression-guard signals. Back off to 2 or 1 via the env var if drift
  appears.
- Target: full window in **≤ 3 min**.

### 5.2 Tighten the Pi cadence (only after 5.1 is proven)

- `pi-native/ap127-fetch.timer`: `OnUnitActiveSec=5min` → **`3min`**.
- `pi-native/run_fetch.sh`: `STANDBY_MAX_AGE_MIN` default `6` → **`3`** (still a duplicate-work
  guard, now just above the new timer interval).
- Effective cadence becomes **~3–5 min**, bounded by scrape duration.
- **Bot-detection watch:** faster scrapes mean more `getStudentSchedule` calls/hour against
  Google (~110/hr today → ~360/hr at 3-min cadence + concurrency 4). The Pi uses a real
  persistent authenticated Chromium (low-risk profile), but this must be monitored for a week
  after rollout via the Mac Pi monitor and the fetch logs. Both knobs revert with one env var
  each if Google reacts.

### 5.3 Cadence relationships to keep

| Knob | Today | Phase 2 | File |
|---|---|---|---|
| Pi timer interval | 5 min | 3 min | `ap127-fetch.timer` |
| Pi duplicate-work guard | 6 min | 3 min | `run_fetch.sh` `STANDBY_MAX_AGE_MIN` |
| Cloud takeover | 35 min | **unchanged** | `DB001/dispatcher/worker.js` `STALE_TAKEOVER_MIN` |
| Telegram staleness page | 60 min | **unchanged** | `ap127-watchdog-monitor` `DATA_STALE_LIMIT_MIN` |
| Watchdog cron backstop | 5 min | 2 min (Phase 1) | watchdog `wrangler.toml` |

The 35 / 60 min thresholds still provide ~2 missed-fetch and ~real-outage headroom against the
new faster cadence — widening the margin, not shrinking it.

---

## 6. Rollout order

1. Create R2 bucket; deploy `ap127-data` Worker with tests green; set `DATA_WRITE_TOKEN`.
2. Seed R2 with current files; verify GET / Range / ETag by hand.
3. Add the writer PUT step to **the Pi only**; watch 2–3 cycles; confirm via Worker logs +
   `curl GET` that R2 tracks Git.
4. Add the writer PUT steps to `fetch_schedule.yml` and `update-cache.yml`.
5. Repoint **one** browser consumer (`flight-schedule-feed/index.html`); load the live site,
   confirm data freshness + clean console.
6. Repoint the remaining browser consumers and the backend Workers; delete `AP127_V2/flight-data.js`;
   trim `refresh_snapshots.mjs`.
7. Add the watchdog `POST /notify` endpoint + callers; tighten its cron to `*/2`.
8. Set build watch paths on all three Pages projects.
9. **Soak 48 h:** CF API deployment count per project flatlines to ~0; feed stays fresh;
   watchdog + dispatcher error-free; Telegram latency measured in seconds after a Pi commit.
10. **Phase 2:** implement §5.1 behind `FETCH_RPC_CONCURRENCY=1`; test at `4` for several
    cycles with output diffing; then flip the timer + `STANDBY_MAX_AGE_MIN`; monitor
    bot-detection for a week.

## 7. Rollback

- **Browser:** revert the one-line `<script src>` changes (Git) and re-run a real build. Sites
  are back on the bundled `flight-data.js`.
- **Build watch paths:** clear the exclude lists in the dashboard; builds resume immediately.
- **Writers:** the PUT steps are non-fatal and independent — remove them or leave them writing
  to an unread bucket.
- **Watchdog:** remove `/notify` callers; restore `*/5` cron.
- **Phase 2:** `FETCH_RPC_CONCURRENCY=1` restores serial scraping; revert the timer /
  `STANDBY_MAX_AGE_MIN` to `5min` / `6`.
- The `ap127-data` Worker + R2 bucket can stay deployed unused — zero cost, no side effects.

## 8. Documentation updates (per the AP127 universal update rule)

- `flight-schedule-feed/CLAUDE.md` — new "Data plane" section: the Worker URL, the R2 write
  path, build-watch-paths config, the `/notify` push, the Phase-2 cadence knobs. Update the
  fetch-roles table.
- `AP127_V2/CLAUDE.md`, `AP127_NGT_001/CLAUDE.md` — note the feed source is now the `ap127-data`
  Worker; note build watch paths.
- `AP127_Docs/README.md` — §2.1 / §2.2 / §2.4 architecture + §10 dated log entry; deploy the
  docs site.
- `pi-native/README.md` — the two new secrets, the PUT step, the Phase-2 cadence change.
- Bump CMD_CTR's `index.html` cache token per its update rule (the `<script src>` line changes).

## 9. Open items to resolve during implementation

- `AP127_Portal/mindmap.html` — confirm how it consumes `flight-data` and fold into §4.4.
- Whether build watch paths are settable via the CF API (`build_config.path_excludes`) or
  dashboard-only.
- Confirm the watchdog's `WATCHDOG_API_KEY` is the right gate for `/notify` (vs. a dedicated
  key) — reuse unless there is a reason to separate.
- DB001 `update-cache.yml` is driven by the dispatcher every 5 min; after decoupling this is no
  longer a build cost, but dropping it to */15 would cut ~200 GH Actions runs/day for a cache
  that only needs to track flight-data freshness. Optional, not required by this spec.
