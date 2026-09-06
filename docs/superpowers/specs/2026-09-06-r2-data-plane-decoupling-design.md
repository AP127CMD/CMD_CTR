# Data-Plane Decoupling + Minimum Portal→Telegram Latency

**Date:** 2026-09-06
**Status:** Design — approved; implementation in progress
**Repos touched:** `AP127CMD/CMD_CTR` (primary), `AP127CMD/CMDV2`, `AP127CMD/DB001`
**Related:** `2026-07-27-rpc-based-schedule-fetch-design.md` (the RPC scraper this builds on)
**Storage model:** originally specced R2; switched to a stateless `raw.githubusercontent.com`
proxy Worker (2026-09-06) because enabling R2 requires a payment method on file. Filename kept
for link stability.

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

**Chosen storage model: a stateless proxy, not R2.** Enabling R2 requires activating it in the
Cloudflare dashboard, which puts a payment method on file even though this workload ($0, far
under 10 GB / 1M writes / 10M reads) would never be billed. To keep the "free plan, no card"
constraint hard, the `ap127-data` Worker instead **proxies `raw.githubusercontent.com`** — the
data is already committed to git every cycle; the Worker just re-serves it with a browser-usable
`Content-Type` and a 60 s edge cache. No bindings, no storage, no secrets, no write path.

```
   Pi / CI / DB001  ── git commit + push ──►  GitHub (main)
                                                  │
                        ┌──────────── raw.githubusercontent.com ────────────┐
                        │                                                   │
       (Cloudflare Workers can't fetch a same-account            (fetch on miss / on no-cache)
        *.workers.dev URL — CF 1042 — so they read raw           │
        directly)                                                │
                        │                              ┌─────────┴─────────────────┐
        ┌───────────────┴───────────┐                  │  ap127-data Worker        │
   watchdog Worker          dispatcher Worker          │  (stateless proxy)        │
   /flight-data-recent.js   /flight-data-recent.js     │  GET flight-data.js       │
   + POST /notify (push)    (Range bytes=0-599)        │  GET flight-data-recent.js│
                                                       │  GET cache.json           │
                                                       │  60 s edge cache · Range  │
                                                       │  · ETag · stale-fallback  │
                                                       └─────────┬─────────────────┘
                                                                 │ GET
                                          ┌──────────────────────┴──────────┐
                                    browser <script src>           DB_Share /mirror proxy
                                    CMD_CTR + CMDV2 pages           (routes data files here)

   Git commits still happen (history + shared state) but every data-commit
   message carries [CI Skip], so Cloudflare Pages skips the build.
```

Two phases. **Phase 1** is low-risk and delivers the quota fix plus most of the latency win.
**Phase 2** speeds up the scrape itself and needs careful live testing against Google's GAS
flakiness history.

---

## 4. Phase 1 — data-plane proxy + watchdog push

### 4.1 `ap127-data` Worker

- **Location:** `flight-schedule-feed/data-worker/` (new). `src/index.js`, `src/lib.js`,
  `wrangler.toml`, `test/` (plain Vitest — `fetch` + `caches` stubbed, matches the watchdog's
  test style), `README.md`, `package.json`, `.gitignore`.
- **Deploy:** `npx wrangler deploy` from that dir. Not Git-integrated. Redeploy on change (rare).
- **Bindings / secrets:** none.
- **URL:** `https://ap127-data.anusorn-tanmetha.workers.dev`
- **Key → upstream map** (allowlist; anything else → `404` with no upstream fetch):
  | key | upstream |
  |---|---|
  | `flight-data.js` | `raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data.js` |
  | `flight-data-recent.js` | `raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data-recent.js` |
  | `cache.json` | `raw.githubusercontent.com/AP127CMD/DB001/main/cache.json` |

**`GET`/`HEAD` `/<key>`**
- Plain GET: check `caches.default` (keyed by the bare upstream URL); on miss `fetch(upstream)`,
  buffer the body, `ctx.waitUntil(cache.put(...))`, serve.
- `Cache-Control: no-cache` (or `no-store`) request: skip our edge cache; fetch with
  `Cache-Control: no-cache` forwarded (Fastly revalidates) and `cache: 'no-store'` (skip
  Cloudflare's subrequest cache). **No `?_=` query-buster** — raw.github 404s intermittently on
  a forced origin miss (learned live 2026-09-06).
- `Range: bytes=…`: **fetch the full object, slice locally**, return `206` + a `Content-Range`
  computed against the true length. Never forward `Range` upstream — GitHub's Fastly edge was
  observed returning a stale (wrong) `Content-Range` total.
- `If-None-Match` (non-range): forwarded upstream → `304` passthrough.
- Response headers on 200/206: `Content-Type` js/json, `Cache-Control: public, max-age=60,
  stale-while-revalidate=240`, upstream `ETag`, `Access-Control-Allow-Origin: *`, `Accept-Ranges: bytes`.
- **Upstream non-200 / unreachable → serve the last good copy from the edge cache** (raw.github
  blips must not take the data plane down); only a cold cache falls through to `502`.

**`HEAD`** → same headers, empty body. **Other methods** (`PUT`, `DELETE`, …) → `405`.
`OPTIONS` → `204` + CORS. Unknown key → `404` (no upstream fetch).

**Tests (plain vitest, `fetch` + `caches` stubbed):** unknown key → 404 + no fetch; `flight-data.js`
→ 200 JS type + CMD_CTR raw URL; `cache.json` → JSON type + DB001 raw URL; `no-cache` → forwards
`no-cache` + `cache:'no-store'`, no query buster; `Range` → 206 sliced locally, correct
`Content-Range`, no upstream Range; `If-None-Match` → 304; upstream 500 → 502; **upstream 404 with
a primed cache → 200 from cache**; `PUT`/`DELETE` → 405; `OPTIONS` → 204 + ACAO `*`; `HEAD` → 200
empty body; second plain GET → no new upstream fetch.

### 4.2 Writers — **unchanged**

There is no write path. The Pi, `fetch_schedule.yml`, and `update-cache.yml` keep committing
data to git exactly as they do today; that git state *is* the data plane. No new secrets, no
`curl PUT`, no ordering concerns.

### 4.3 Freshness characteristics

- **Browser reads** (via the Worker) land within our 60 s edge cache + raw.github propagation.
  GitHub purges the `raw.githubusercontent.com` CDN on push (usually seconds, occasionally up to
  ~5 min). Net: data visible to a dashboard ~1–5 min after a Pi commit — fine for a schedule view.
- **Watchdog / dispatcher reads** go straight to raw.github (not the Worker — CF 1042) with
  `Cache-Control: no-cache`, so a `/notify`-triggered diff sees a push within ~1 min of
  raw.github propagation. Telegram then fires in seconds. The `*/2` cron is the backstop.

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
| `AP127_Portal/mindmap.html` | — | **not a functional consumer** — the "flight-data" strings are labels inside a mermaid architecture diagram. Update the diagram text to match §3 (docs only). |

Cross-origin `<script src>` still loads synchronously and sets `window.FLIGHT_DATA`; load order
and downstream init are unaffected. DB_Share needs a one-line change: its `functions/mirror/[[path]].js`
proxy routes `flight-data.js` / `flight-data-recent.js` / `cache.json` to the `ap127-data`
Worker instead of `ap127-ngt2.pages.dev` (CMDV2 no longer holds those files); everything else
still proxies from CMDV2.

**Backend Workers — STAY on `raw.githubusercontent.com`.** A Cloudflare Worker cannot fetch
another Worker on the same account by its `*.workers.dev` URL (blocked, surfaces as CF error 1042
/ a 404). Verified live 2026-09-06: pointing `watchdog` `FLIGHT_SRC` at the `ap127-data` Worker
made every run fail `Upstream HTTP 404`. So:

| File | Change |
|---|---|
| `AP127_V2/watchdog/src/index.js` (`FLIGHT_SRC`) | **unchanged** — `raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data-recent.js`. `fetchFeedText()` already sends `cache-control: no-cache`, so a `/notify` diff sees a push within ~1 min of raw.github propagation. |
| `AP127_NGT_001/dispatcher/worker.js` (`FEED_URL`) | **unchanged** — same raw.github URL. Add `Cache-Control: no-cache` to the `feedAgeMinutes()` fetch so the age check isn't fooled by a stale read. |
| `AP127_V2/scripts/refresh_snapshots.mjs` | runs on GitHub Actions (not a Worker) so it CAN use the `ap127-data` Worker. **remove** the `flight-data` mirror step entirely; repoint the `ngt-data` step from `ap127-db001.pages.dev/cache.json` → the Worker's `/cache.json`; leave `progress-data` unchanged |

- Delete `AP127_V2/flight-data.js` from the CMDV2 repo (no longer mirrored; the browser reads it
  from the Worker at runtime).
- `refresh-data.yml`'s `git add` drops `flight-data.js` (keeps `progress-data.js` / `ngt-data.js`).
- `refresh-data.yml` keeps its hourly cron but its commits carry `[CI Skip]` (§4.5), so the
  committed `progress-data.js` / `ngt-data.js` snapshots ship to the deploy on real code pushes
  rather than hourly. They are runtime-fetched fallbacks, so a stale committed copy is low-risk.

### 4.5 Stop the Pages builds — `[CI Skip]` in data commit messages

Build watch paths turned out to be **dashboard-only** (`PATCH …/pages/projects/{name}` accepts
`path_excludes` with `success:true` but silently drops it). Instead, every data-commit message
gets a trailing **`[CI Skip]`** token, which Cloudflare Pages recognises and skips the build
(deployment status `idle`, does not count against the 500/mo). Verified live 2026-09-06 on both
`ap127-db001` and `ap127-cmd-ctr`.

| Commit site | New message tail |
|---|---|
| `pi-native/run_fetch.sh` | `…update flight data <ts> (orangepi-zero2w) [CI Skip]` |
| `.github/workflows/fetch_schedule.yml` (Commit updated data) | `…update flight data <ts> [CI Skip]` |
| `AP127_V2/.github/workflows/refresh-data.yml` | `…refresh data snapshots <ts> [CI Skip]` |
| `AP127_NGT_001/.github/workflows/update-cache.yml` | `…update cache.json [<ts>] [CI Skip]` |

- Cloudflare checks the **head commit** of the push. The Pi/CI rebase-retry loops replay the
  original `[CI Skip]` commit, so it stays the head.
- **No GitHub workflow is push-triggered by any of these commits** (all the data workflows are
  `schedule`/`workflow_dispatch`; only DB001's `deploy-dispatcher.yml` is push-triggered, on
  `dispatcher/**`), so `[CI Skip]` only ever affects the Pages build.
- A real code push must NOT contain `[CI Skip]` in its message — then it builds and deploys
  normally, shipping whatever the current data files are.

### 4.6 Watchdog push endpoint (kills the poll wait)

`AP127_V2/watchdog/src/index.js` already factors its check into `runWatchdog(env)` (called by
`scheduled`). Add:

- **`POST /notify`** in `handleFetch` — `handleFetch` gains a `ctx` param. Require
  `X-API-Key: <NOTIFY_KEY>` (a dedicated `wrangler secret`, falling back to `WATCHDOG_API_KEY`
  if unset). On match: `ctx.waitUntil(runWatchdog(env))`, return `202 {"ok":true}`; else `401`.
  - `runWatchdog` already no-ops cheaply when `extractFeedSig` shows the feed is unchanged, so a
    spurious or duplicate notify is safe. No payload — the handler just re-fetches raw.github.
- **Callers** — after a successful data publish, `curl -fsS -m 15 -X POST -H "X-API-Key: …"
  https://ap127-watchdog.anusorn-tanmetha.workers.dev/notify` (non-fatal, 1 attempt):
  - `pi-native/run_fetch.sh` — at the end, after the CMDV2 refresh curl. Reads `WATCHDOG_NOTIFY_KEY`
    from `pi-native/.env`.
  - `.github/workflows/fetch_schedule.yml` — after the CMDV2 dispatch step. Repo secret
    `WATCHDOG_NOTIFY_KEY`.
  - Both hold the same value as the watchdog's `NOTIFY_KEY` secret.
- **Cron backstop** — tighten the watchdog cron `*/5` → `*/2` in its `wrangler.toml`. Invocations
  rise ~288/day → ~720/day (vs 100,000/day free). Per-invocation CPU is unchanged (still reads
  the small `flight-data-recent.js`, still short-circuits on unchanged `extractFeedSig`).

### 4.7 DB001 cache refresh: */5 → */15

`AP127_NGT_001/dispatcher/worker.js` `scheduled()` runs every 5 min (`*/5` cron) and
*unconditionally* dispatches `DB001/update-cache.yml` on every tick — 288 GitHub Actions runs/day
for a cache that only needs to track flight-data freshness (~12–18 min today, ~3–5 min after
Phase 2). After decoupling this is no longer a Pages-build cost, but it is wasted CI churn.

- Gate the DB001 dispatch on the tick time: dispatch only when
  `new Date(event.scheduledTime).getUTCMinutes() % 15 === 0` (fires at :00/:15/:30/:45).
- The dispatcher's own 5-min cron and its CMD_CTR stale-check are **unchanged** — only the DB001
  target is spaced out.
- `update-cache.yml`'s own `0 * * * *` fallback cron stays as the safety net.
- Result: DB001 cache refreshes every 15 min (~96 runs/day, down from 288).

**Phase 1 result:** portal change → Pi scrape (≤ ~18 min, unchanged in Phase 1) → `git push` +
`/notify` → the watchdog reads `flight-data-recent.js` via the Worker with `no-cache` (bypasses
both caches, sees the push in seconds) → Telegram within **seconds**. The ~5 min poll wait is
gone. Pages builds flatline. Fetch cadence has no metered ceiling. DB001 CI churn drops to a
third.

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
| Cloud takeover | 35 min | **unchanged** | `AP127_NGT_001/dispatcher/worker.js` `STALE_TAKEOVER_MIN` |
| Telegram staleness page | 60 min | **unchanged** | `ap127-watchdog-monitor` `DATA_STALE_LIMIT_MIN` |
| Watchdog cron backstop | 5 min | 2 min (Phase 1) | watchdog `wrangler.toml` |

The 35 / 60 min thresholds still provide ~2 missed-fetch and ~real-outage headroom against the
new faster cadence — widening the margin, not shrinking it.

---

## 6. Rollout order

1. Deploy `ap127-data` Worker (`wrangler deploy`, tests green). No bucket, no secret.
2. Verify by hand against the live Worker: `GET` each key (content-type, `max-age=60`), a
   `Range: bytes=0-599` on `flight-data-recent.js` returns the `fetchedAt`, `Cache-Control:
   no-cache` returns a fresh read, an unknown key is 404.
3. Repoint **one** browser consumer (`flight-schedule-feed/index.html`); push; load the live
   site; confirm the request goes to the Worker, data is current, console clean.
4. Repoint the remaining browser consumers; delete `AP127_V2/flight-data.js`; trim
   `refresh_snapshots.mjs`; push CMDV2.
5. Repoint the backend Workers (`watchdog` `FLIGHT_SRC`, `dispatcher` feed URL); deploy both.
6. Add the watchdog `POST /notify` endpoint + Pi/CI callers; tighten its cron to `*/2`; deploy.
7. Gate the dispatcher's DB001 target to */15 (§4.7); push (auto-deploys).
8. Add `[CI Skip]` to the four data-commit messages (§4.5); push.
9. **Soak 48 h:** CF API deployment count per project flatlines to ~0; feed stays fresh via the
   Worker; watchdog + dispatcher error-free; Telegram latency in seconds after a Pi commit.
10. **Phase 2:** implement §5.1 behind `FETCH_RPC_CONCURRENCY=1`; test at `4` for several cycles
    with output diffing; then flip the timer + `STANDBY_MAX_AGE_MIN`; monitor bot-detection for
    a week.

## 7. Rollback

- **Browser:** revert the one-line `<script src>` changes (Git) and re-run a real build. Sites
  are back on the bundled `flight-data.js`.
- **`[CI Skip]`:** remove the token from the four commit-message strings; data commits build again.
- **Backend Workers:** revert `FLIGHT_SRC` / feed URL to `raw.githubusercontent.com`; redeploy.
- **Watchdog:** remove `/notify` callers; restore `*/5` cron.
- **Phase 2:** `FETCH_RPC_CONCURRENCY=1` restores serial scraping; revert the timer /
  `STANDBY_MAX_AGE_MIN` to `5min` / `6`.
- The `ap127-data` Worker is stateless — it can stay deployed unused, or be deleted; either way
  zero cost, no side effects.

## 8. Documentation updates (per the AP127 universal update rule)

- `flight-schedule-feed/CLAUDE.md` — new "Data plane" section: the Worker URL, the proxy model
  (raw.github, `no-cache` bypass), the `[CI Skip]` mechanism, the `/notify` push, the Phase-2
  cadence knobs. Update the fetch-roles table.
- `AP127_V2/CLAUDE.md`, `AP127_NGT_001/CLAUDE.md` — note the feed source is now the `ap127-data`
  Worker; note the `[CI Skip]` mechanism.
- `AP127_Docs/README.md` — §2.1 / §2.2 / §2.4 architecture + §10 dated log entry; deploy the
  docs site.
- `pi-native/README.md` — the new `WATCHDOG_NOTIFY_KEY` env key, the `/notify` call, the Phase-2
  cadence change.
- Bump CMD_CTR's `index.html` cache token per its update rule (the `<script src>` line changes).

## 9. Resolved during implementation (2026-09-06)

- **CF 1042** — a Worker can't fetch a same-account `*.workers.dev` URL. So the watchdog and
  dispatcher stay on `raw.githubusercontent.com`; only browsers + GitHub-Actions consumers use
  the `ap127-data` Worker. (§3, §4.3, §4.4)
- **raw.github 404s on `?_=` cache-busters** — dropped the query buster; the Worker relies on the
  `no-cache` request header + `cache: 'no-store'`, and serves a stale edge copy on any upstream
  non-200. (§4.1)
- **Fastly stale `Content-Range`** — the Worker fetches the full object and slices Range locally.
  (§4.1)
- **`/notify` gate** — a dedicated `NOTIFY_KEY` secret (not the admin `WATCHDOG_API_KEY`).
- **`event.scheduledTime`** — lands cleanly on 5-min boundaries; the `% 15 === 0` gate verified
  live (DB001 dispatched at :00/:15, skipped at :05/:10).
- **DB_Share** — its `/mirror` proxy needed a code change (route data files to the `ap127-data`
  Worker) or it 404s once CMDV2's `flight-data.js` is deleted. Done.

## Still open

- (none)
