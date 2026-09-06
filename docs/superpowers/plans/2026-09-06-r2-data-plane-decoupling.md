# R2 Data-Plane Decoupling + Min Portal→Telegram Latency — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `flight-data.js` / `flight-data-recent.js` / `cache.json` to an R2-backed Worker so data commits stop triggering Cloudflare Pages builds, and make schedule changes reach Telegram within seconds of a Pi commit.

**Architecture:** A new `ap127-data` Worker fronts an R2 bucket — public `GET` (JS/JSON content-type, 60 s cache, Range, ETag), token-gated `PUT`. The Pi, CI, and DB001 `PUT` their generated data to it each cycle; browsers and backend Workers read from it. Data is still committed to Git (history + shared pipeline state), but Pages "build watch paths" exclude the data files so no rebuild fires. The watchdog gains a `POST /notify` push endpoint so a Pi/CI publish triggers the Telegram diff immediately instead of waiting up to 5 min for its cron.

**Tech Stack:** Cloudflare Workers + R2 (wrangler), Node/Vitest (plain, mock-R2 — matches the watchdog's test style), bash (`pi-native/run_fetch.sh`), GitHub Actions YAML, Python 3 (`scripts/fetch_schedule.py`, Phase 2).

**Spec:** `docs/superpowers/specs/2026-09-06-r2-data-plane-decoupling-design.md`

## Global Constraints

- **Repos:** `AP127CMD/CMD_CTR` (local `/Users/nugui/flight-schedule-feed`), `AP127CMD/CMDV2` (`/Users/nugui/AP127_V2`), `AP127CMD/DB001` (`/Users/nugui/AP127_NGT_001`). All three are **public** → GitHub Actions minutes are free; do not privatise.
- **Data Worker URL (canonical, used verbatim everywhere):** `https://ap127-data.anusorn-tanmetha.workers.dev`
- **R2 bucket name:** `ap127-data`
- **Allowlisted keys:** `flight-data.js`, `flight-data-recent.js`, `cache.json` — nothing else.
- **CF account:** `ae38e04e56d0ae52d3ec47ad29977587`, subdomain `anusorn-tanmetha.workers.dev`.
- **All writer PUTs and the `/notify` call are NON-FATAL** — log a warning, never break the Git commit path. A *persistent* failure escalates via that writer's existing issue/`report_pi_failure` mechanism.
- **Every writer PUT is conditional** — only PUT after a real data change (piggyback on the existing "nothing to commit" gates), to keep R2 writes proportional to real updates.
- **Cadence knobs are env/secret-tunable.** Phase 2 timer/concurrency changes must each revert with a single variable.
- **Unchanged thresholds:** cloud takeover `STALE_TAKEOVER_MIN=35` (`AP127_NGT_001/dispatcher/worker.js`), Telegram staleness page `DATA_STALE_LIMIT_MIN=60` (`ap127-watchdog-monitor`).
- **Commit style:** small, frequent, TDD where logic exists. Conventional-commit prefixes (`feat:`/`fix:`/`chore:`/`docs:`). Co-author trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **Do not `git push` any repo until its rollout step says so** — CMD_CTR/CMDV2/DB001 auto-deploy on push and the browser repoint must not land before R2 is serving.

---

## File Structure

**New — `flight-schedule-feed/data-worker/`**
- `src/index.js` — the Worker: routing, `GET` (full + Range + 304), `PUT` (auth + allowlist + size cap), headers. One file, ~150 lines.
- `src/lib.js` — pure helpers: `contentTypeFor(key)`, `isAllowedKey(key)`, `parseRange(header)`. Unit-tested in isolation.
- `test/lib.test.js` — pure-helper tests.
- `test/worker.test.js` — handler tests against a `FakeR2` stub.
- `wrangler.toml` — name `ap127-data`, `main src/index.js`, R2 binding `R2` → `ap127-data`.
- `package.json` — `type: module`, `vitest` + `wrangler` devDeps, `test`/`deploy` scripts (mirror `AP127_V2/watchdog/package.json`).
- `README.md` — what it is, the write-token model, how to seed/redeploy.
- `.gitignore` — `node_modules`.

**Modified**
- `flight-schedule-feed/pi-native/run_fetch.sh` — R2 PUT helper + `/notify` call.
- `flight-schedule-feed/pi-native/.env.example` — document `DATA_WRITE_TOKEN`, `WATCHDOG_NOTIFY_KEY`.
- `flight-schedule-feed/.github/workflows/fetch_schedule.yml` — PUT step + `/notify` step.
- `flight-schedule-feed/index.html:37` — `<script src>` → Worker URL.
- `AP127_NGT_001/.github/workflows/update-cache.yml` — PUT step for `cache.json`.
- `AP127_NGT_001/dispatcher/worker.js` — DB001 target gated to `% 15 === 0`.
- `AP127_V2/index.html:53`, `legacy.html:67`, `ops/index.html:37`, `crosscheck/index.html:91`, `overview/index.html:64` — `<script src>` → Worker URL.
- `AP127_V2/flight-data.js` — **delete**.
- `AP127_V2/scripts/refresh_snapshots.mjs` — drop the `flight-data` step; repoint `ngt-data` to the Worker.
- `AP127_V2/watchdog/src/index.js` — `FLIGHT_SRC` → Worker URL; add `POST /notify`.
- `AP127_V2/watchdog/wrangler.toml` — cron `*/5` → `*/2`.
- `AP127_Portal/mindmap.html` — update the mermaid diagram text (docs only; not a functional consumer).
- `CLAUDE.md` files + `AP127_Docs/README.md` — per the universal update rule (Task 14).

---

## PHASE 1 — R2 decoupling + watchdog push

### Task 1: `ap127-data` Worker (code + tests)

**Files:**
- Create: `flight-schedule-feed/data-worker/package.json`, `wrangler.toml`, `.gitignore`, `src/lib.js`, `src/index.js`, `test/lib.test.js`, `test/worker.test.js`, `README.md`

**Interfaces:**
- Produces: HTTP contract —
  - `GET /<key>` → `200` body bytes, `Content-Type` (`application/javascript; charset=utf-8` for `.js`, `application/json; charset=utf-8` for `.json`), `Cache-Control: public, max-age=60, stale-while-revalidate=240`, `ETag`, `Access-Control-Allow-Origin: *`, `Accept-Ranges: bytes`. `Range: bytes=A-B` → `206` + `Content-Range`. `If-None-Match` hit → `304`. Unknown key → `404`.
  - `PUT /<key>` with `Authorization: Bearer <DATA_WRITE_TOKEN>` → `200 {"ok":true,"key","size","etag"}`. No/bad token → `401`. Bad key → `400`. Body > 8·1024·1024 → `413`.
  - Any other method → `405`; `OPTIONS` → `204` with CORS.
- Consumes: `env.R2` (R2 bucket binding), `env.DATA_WRITE_TOKEN` (secret).

- [ ] **Step 1: Scaffold package + config**

`flight-schedule-feed/data-worker/package.json`:
```json
{
  "name": "ap127-data-worker",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "vitest": "^1.6.0",
    "wrangler": "^3.60.0"
  }
}
```

`flight-schedule-feed/data-worker/wrangler.toml`:
```toml
name = "ap127-data"
main = "src/index.js"
compatibility_date = "2025-01-01"

[[r2_buckets]]
binding = "R2"
bucket_name = "ap127-data"
```

`flight-schedule-feed/data-worker/.gitignore`:
```
node_modules
.wrangler
```

- [ ] **Step 2: Write failing pure-helper tests**

`flight-schedule-feed/data-worker/test/lib.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { contentTypeFor, isAllowedKey, parseRange } from '../src/lib.js';

describe('isAllowedKey', () => {
  it('accepts the three data files', () => {
    expect(isAllowedKey('flight-data.js')).toBe(true);
    expect(isAllowedKey('flight-data-recent.js')).toBe(true);
    expect(isAllowedKey('cache.json')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isAllowedKey('secrets.env')).toBe(false);
    expect(isAllowedKey('../flight-data.js')).toBe(false);
    expect(isAllowedKey('')).toBe(false);
  });
});

describe('contentTypeFor', () => {
  it('maps .js and .json', () => {
    expect(contentTypeFor('flight-data.js')).toBe('application/javascript; charset=utf-8');
    expect(contentTypeFor('cache.json')).toBe('application/json; charset=utf-8');
  });
});

describe('parseRange', () => {
  it('parses a bounded range', () => {
    expect(parseRange('bytes=0-599')).toEqual({ offset: 0, length: 600 });
  });
  it('parses an open-ended range', () => {
    expect(parseRange('bytes=100-')).toEqual({ offset: 100 });
  });
  it('returns null for junk or missing', () => {
    expect(parseRange(null)).toBeNull();
    expect(parseRange('items=1-2')).toBeNull();
  });
});
```

- [ ] **Step 3: Run — expect fail**

Run: `cd /Users/nugui/flight-schedule-feed/data-worker && npm install && npx vitest run test/lib.test.js`
Expected: FAIL — `Cannot find module '../src/lib.js'`.

- [ ] **Step 4: Implement `src/lib.js`**

```js
const ALLOWED = new Set(['flight-data.js', 'flight-data-recent.js', 'cache.json']);

export function isAllowedKey(key) {
  return ALLOWED.has(key);
}

export function contentTypeFor(key) {
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/javascript; charset=utf-8';
}

// Returns {offset, length?} for a single "bytes=A-B" / "bytes=A-" range, else null.
export function parseRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  if (m[2] === '') return { offset: start };
  const end = Number(m[2]);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}
```

- [ ] **Step 5: Run — expect pass**

Run: `npx vitest run test/lib.test.js`
Expected: PASS (9 assertions).

- [ ] **Step 6: Write failing handler tests**

`flight-schedule-feed/data-worker/test/worker.test.js`:
```js
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index.js';

// Minimal in-memory R2 stub covering the surface index.js uses.
class FakeR2 {
  constructor() { this.store = new Map(); }
  async put(key, body) {
    const buf = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
    this.store.set(key, buf);
    return { httpEtag: `"etag-${key}-${buf.length}"` };
  }
  async get(key, opts) {
    const buf = this.store.get(key);
    if (!buf) return null;
    const etag = `"etag-${key}-${buf.length}"`;
    let slice = buf;
    if (opts && opts.range) {
      const { offset, length } = opts.range;
      slice = buf.slice(offset, length == null ? undefined : offset + length);
    }
    return {
      httpEtag: etag,
      size: buf.length,
      body: new Blob([slice]).stream(),
      async arrayBuffer() { return slice.buffer; },
      writeHttpMetadata() {},
    };
  }
}

const TOKEN = 'test-write-token';
let env;
beforeEach(() => { env = { R2: new FakeR2(), DATA_WRITE_TOKEN: TOKEN }; });

const req = (method, path, opts = {}) =>
  new Request(`https://ap127-data.example${path}`, { method, ...opts });

describe('PUT', () => {
  it('401 without a bearer token', async () => {
    const res = await worker.fetch(req('PUT', '/flight-data.js', { body: 'x' }), env);
    expect(res.status).toBe(401);
  });
  it('400 for a key not in the allowlist', async () => {
    const res = await worker.fetch(req('PUT', '/evil.js', {
      body: 'x', headers: { Authorization: `Bearer ${TOKEN}` },
    }), env);
    expect(res.status).toBe(400);
  });
  it('413 for an oversize body', async () => {
    const big = 'a'.repeat(8 * 1024 * 1024 + 1);
    const res = await worker.fetch(req('PUT', '/flight-data.js', {
      body: big, headers: { Authorization: `Bearer ${TOKEN}` },
    }), env);
    expect(res.status).toBe(413);
  });
  it('200 and round-trips to GET', async () => {
    const put = await worker.fetch(req('PUT', '/flight-data.js', {
      body: 'window.FLIGHT_DATA = {"fetchedAt":"2026-09-06T00:00:00Z"}',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }), env);
    expect(put.status).toBe(200);
    const got = await worker.fetch(req('GET', '/flight-data.js'), env);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(got.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=240');
    expect(await got.text()).toContain('fetchedAt');
  });
});

describe('GET', () => {
  beforeEach(async () => {
    await worker.fetch(req('PUT', '/flight-data-recent.js', {
      body: 'window.FLIGHT_DATA = {"fetchedAt":"2026-09-06T00:00:00Z","x":123}',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }), env);
  });
  it('404 for an unknown key', async () => {
    const res = await worker.fetch(req('GET', '/nope.js'), env);
    expect(res.status).toBe(404);
  });
  it('304 when If-None-Match matches', async () => {
    const first = await worker.fetch(req('GET', '/flight-data-recent.js'), env);
    const etag = first.headers.get('etag');
    const res = await worker.fetch(req('GET', '/flight-data-recent.js', {
      headers: { 'If-None-Match': etag },
    }), env);
    expect(res.status).toBe(304);
  });
  it('206 with Content-Range for a byte range', async () => {
    const res = await worker.fetch(req('GET', '/flight-data-recent.js', {
      headers: { Range: 'bytes=0-18' },
    }), env);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-18\//);
    expect((await res.text()).length).toBe(19);
  });
});

describe('other methods', () => {
  it('405 for DELETE', async () => {
    const res = await worker.fetch(req('DELETE', '/flight-data.js'), env);
    expect(res.status).toBe(405);
  });
  it('204 for OPTIONS', async () => {
    const res = await worker.fetch(req('OPTIONS', '/flight-data.js'), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
```

- [ ] **Step 7: Run — expect fail**

Run: `npx vitest run test/worker.test.js`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 8: Implement `src/index.js`**

```js
import { isAllowedKey, contentTypeFor, parseRange } from './lib.js';

const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=240';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, Range',
};

function keyFromPath(pathname) {
  return decodeURIComponent(pathname.replace(/^\/+/, ''));
}

async function handleGet(key, request, env, ctx) {
  const rangeSpec = parseRange(request.headers.get('Range'));
  const cache = caches.default;

  if (!rangeSpec) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }

  const obj = rangeSpec
    ? await env.R2.get(key, { range: rangeSpec })
    : await env.R2.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: CORS });

  const etag = obj.httpEtag;
  const inm = request.headers.get('If-None-Match');
  if (inm && inm === etag) {
    return new Response(null, { status: 304, headers: { ...CORS, ETag: etag, 'Cache-Control': CACHE_CONTROL } });
  }

  const headers = {
    ...CORS,
    'Content-Type': contentTypeFor(key),
    'Cache-Control': CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };

  if (rangeSpec) {
    const total = obj.size; // full object size on a range get
    const start = rangeSpec.offset;
    const len = rangeSpec.length ?? (total - start);
    headers['Content-Range'] = `bytes ${start}-${start + len - 1}/${total}`;
    return new Response(obj.body, { status: 206, headers });
  }

  const res = new Response(obj.body, { status: 200, headers });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

async function handlePut(key, request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.DATA_WRITE_TOKEN}`) {
    return new Response('Unauthorized', { status: 401, headers: CORS });
  }
  if (!isAllowedKey(key)) {
    return new Response('Bad key', { status: 400, headers: CORS });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    return new Response('Too large', { status: 413, headers: CORS });
  }
  const put = await env.R2.put(key, bytes, {
    httpMetadata: { contentType: contentTypeFor(key) },
  });
  return new Response(
    JSON.stringify({ ok: true, key, size: bytes.length, etag: put.httpEtag }),
    { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const key = keyFromPath(new URL(request.url).pathname);
    if (request.method === 'GET') {
      if (!isAllowedKey(key)) return new Response('Not found', { status: 404, headers: CORS });
      return handleGet(key, request, env, ctx);
    }
    if (request.method === 'PUT') return handlePut(key, request, env);
    return new Response('Method not allowed', { status: 405, headers: CORS });
  },
};
```

- [ ] **Step 9: Run — expect pass**

Run: `npx vitest run`
Expected: PASS — all `lib.test.js` + `worker.test.js` cases green.

Note: the `FakeR2` returns `size` as the full object length on a range get, matching real R2 behaviour (`R2ObjectBody.size` is the object size, not the slice). If a test shows `Content-Range` total wrong, that is the bug to fix in `handleGet`, not the test.

- [ ] **Step 10: Write `README.md`**

```markdown
# ap127-data Worker

R2-backed static file server for the AP127 flight-data plane. Decouples data
updates from Cloudflare Pages builds (see
`../docs/superpowers/specs/2026-09-06-r2-data-plane-decoupling-design.md`).

- **URL:** https://ap127-data.anusorn-tanmetha.workers.dev
- **Bucket:** `ap127-data` (R2)
- **Keys:** `flight-data.js`, `flight-data-recent.js`, `cache.json` (allowlisted)

## Endpoints
- `GET /<key>` — public. JS/JSON content-type, `Cache-Control: max-age=60`,
  `Range` + `ETag`/`If-None-Match` supported.
- `PUT /<key>` — `Authorization: Bearer $DATA_WRITE_TOKEN`. 8 MiB cap.

## Deploy
    npm install
    npm test
    npx wrangler r2 bucket create ap127-data   # first time only
    npx wrangler secret put DATA_WRITE_TOKEN    # first time / rotation
    npm run deploy

## Seed / manual write
    curl -X PUT -H "Authorization: Bearer $DATA_WRITE_TOKEN" \
      --data-binary @flight-data.js \
      https://ap127-data.anusorn-tanmetha.workers.dev/flight-data.js
```

- [ ] **Step 11: Commit**

```bash
cd /Users/nugui/flight-schedule-feed
git add data-worker
git commit -m "feat: ap127-data Worker — R2-backed data-plane server

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Deploy the Worker + create the bucket + seed R2

**Files:** none (infra). Requires the user for the secret value.

- [ ] **Step 1: Generate the write token**

Run: `openssl rand -hex 32`
Record the output as `DATA_WRITE_TOKEN` (used again in Tasks 3–5). Do not commit it.

- [ ] **Step 2: Create the bucket**

Run: `cd /Users/nugui/flight-schedule-feed/data-worker && npx wrangler r2 bucket create ap127-data`
Expected: `Created bucket 'ap127-data'`.

- [ ] **Step 3: Set the secret** (user runs this — paste the token at the prompt)

Run: `npx wrangler secret put DATA_WRITE_TOKEN`
Expected: `Success! Uploaded secret DATA_WRITE_TOKEN`.

- [ ] **Step 4: Deploy**

Run: `npm run deploy`
Expected: `Published ap127-data` with the `workers.dev` route.

- [ ] **Step 5: Seed the three keys from current live data**

```bash
cd /Users/nugui/flight-schedule-feed
T='<DATA_WRITE_TOKEN>'
U='https://ap127-data.anusorn-tanmetha.workers.dev'
git pull --rebase
curl -fsS -X PUT -H "Authorization: Bearer $T" --data-binary @flight-data.js        "$U/flight-data.js"
curl -fsS -X PUT -H "Authorization: Bearer $T" --data-binary @flight-data-recent.js "$U/flight-data-recent.js"
curl -fsS https://ap127-db001.pages.dev/cache.json | \
  curl -fsS -X PUT -H "Authorization: Bearer $T" --data-binary @- "$U/cache.json"
```
Expected: three `{"ok":true,...}` responses.

- [ ] **Step 6: Verify the read contract**

```bash
U='https://ap127-data.anusorn-tanmetha.workers.dev'
curl -sI "$U/flight-data.js" | grep -Ei 'content-type|cache-control|etag'   # application/javascript, max-age=60, ETag present
curl -s -H 'Range: bytes=0-599' "$U/flight-data-recent.js" | grep -o '"fetchedAt":"[^"]*"'  # prints the timestamp
curl -s -o /dev/null -w '%{http_code}\n' "$U/secrets.env"                    # 404
```
Expected: content-type/cache-control/ETag correct; `fetchedAt` printed from the 600-byte range; `404` for a non-allowlisted key.

- [ ] **Step 7: No commit** (infra only). Record the token in the user's password manager.

---

### Task 3: Pi writer — `run_fetch.sh` PUTs to R2

**Files:**
- Modify: `flight-schedule-feed/pi-native/run_fetch.sh`
- Modify: `flight-schedule-feed/pi-native/.env.example`

**Interfaces:**
- Consumes: `DATA_WRITE_TOKEN` from `pi-native/.env` (loaded by systemd `EnvironmentFile`); the Worker `PUT` contract from Task 1.
- Produces: R2 objects `flight-data.js`, `flight-data-recent.js` updated on every successful Pi data commit.

- [ ] **Step 1: Add the helper + call site**

In `flight-schedule-feed/pi-native/run_fetch.sh`, immediately **after** the block:
```bash
git commit -m "chore: update flight data $(date -u +%Y-%m-%dT%H:%M:%SZ) (orangepi-zero2w)"
```
and **before** the `pushed=false` push loop, insert:
```bash
# ─── Publish to the data plane (R2 via the ap127-data Worker) ────────────────
# Non-fatal: R2 being briefly unreachable must not stop the git push that still
# records the data. A persistent failure is surfaced via report_pi_failure at
# the end of the run (see r2_failed tracking below). Runs BEFORE the push so
# browsers get fresh data even if push contention delays the commit landing.
DATA_WORKER_URL="${DATA_WORKER_URL:-https://ap127-data.anusorn-tanmetha.workers.dev}"
r2_failed=false
put_r2() {
  local key=$1 file=$2 attempt
  for attempt in 1 2 3; do
    if curl -fsS -m 30 -X PUT \
        -H "Authorization: Bearer ${DATA_WRITE_TOKEN:-}" \
        --data-binary @"$file" \
        "${DATA_WORKER_URL}/${key}" >/dev/null; then
      echo "R2 ✓ ${key}"
      return 0
    fi
    sleep $((attempt * 2))
  done
  echo "WARNING: R2 PUT ${key} failed after 3 attempts" >&2
  r2_failed=true
  return 1
}
if [ -n "${DATA_WRITE_TOKEN:-}" ]; then
  put_r2 flight-data.js        flight-data.js
  put_r2 flight-data-recent.js flight-data-recent.js
else
  echo "WARNING: DATA_WRITE_TOKEN unset — skipping R2 publish" >&2
fi
```

Then at the very end of the script, **after** the CMDV2 refresh curl block, append:
```bash
if [ "${r2_failed:-false}" = true ]; then
  echo "R2 publish failed this cycle — opening/refreshing the Pi-failure issue." >&2
  report_pi_failure
fi
```

- [ ] **Step 2: Document the secret**

Append to `flight-schedule-feed/pi-native/.env.example`:
```bash
# Bearer token for PUTs to the ap127-data Worker (R2 data plane).
# Same value as the Worker's DATA_WRITE_TOKEN secret. See
# docs/superpowers/specs/2026-09-06-r2-data-plane-decoupling-design.md
DATA_WRITE_TOKEN=

# API key for the watchdog's POST /notify push endpoint (same value as the
# ap127-watchdog Worker's WATCHDOG_API_KEY secret).
WATCHDOG_NOTIFY_KEY=
```

- [ ] **Step 3: Shellcheck**

Run: `cd /Users/nugui/flight-schedule-feed && shellcheck pi-native/run_fetch.sh || true`
Expected: no new errors introduced by this diff (pre-existing warnings, if any, unchanged).

- [ ] **Step 4: Commit (do not push yet)**

```bash
git add pi-native/run_fetch.sh pi-native/.env.example
git commit -m "feat(pi): publish flight data to R2 via ap127-data Worker

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Deploy to the Pi and verify one cycle**

```bash
# add the token to the Pi's env
ssh dietpi@DietPi.local "grep -q DATA_WRITE_TOKEN ~/flight-schedule-feed/pi-native/.env || \
  echo 'DATA_WRITE_TOKEN=<token>' >> ~/flight-schedule-feed/pi-native/.env"
# push CMD_CTR so the Pi's next `git pull --rebase` picks up run_fetch.sh
git push origin main
# on the Pi, next timer cycle runs the new script; watch it
ssh dietpi@DietPi.local "journalctl -u ap127-fetch -n 40 -f"
```
Expected in the log: `R2 ✓ flight-data.js` and `R2 ✓ flight-data-recent.js` on a cycle that commits.
Then: `curl -s https://ap127-data.anusorn-tanmetha.workers.dev/flight-data-recent.js | grep -o '"fetchedAt":"[^"]*"'` matches the Pi's latest commit timestamp.

Note: this `git push` deploys CMD_CTR Pages once (build watch paths not set until Task 12). Acceptable — one build.

---

### Task 4: CI fallback writer — `fetch_schedule.yml` PUTs to R2

**Files:**
- Modify: `flight-schedule-feed/.github/workflows/fetch_schedule.yml`

**Interfaces:**
- Consumes: repo secret `DATA_WRITE_TOKEN`; Worker `PUT` contract.
- Produces: same two R2 objects updated when the cloud fallback fetches.

- [ ] **Step 1: Add repo secret** (user)

Run: `gh secret set DATA_WRITE_TOKEN -R AP127CMD/CMD_CTR` (paste the token) — or via the GitHub UI.
Expected: `✓ Set secret DATA_WRITE_TOKEN for AP127CMD/CMD_CTR`.

- [ ] **Step 2: Add the PUT step**

In `fetch_schedule.yml`, immediately **after** the `Commit updated data` step and **before** `Trigger CMDV2 refresh`, add:
```yaml
      # Publish the regenerated data to R2 (ap127-data Worker) so browsers and
      # backend Workers read fresh data without a Pages rebuild. Non-fatal.
      - name: Publish data to R2
        if: success() && steps.backoff.outputs.skip != 'true'
        env:
          DATA_WRITE_TOKEN: ${{ secrets.DATA_WRITE_TOKEN }}
        run: |
          U='https://ap127-data.anusorn-tanmetha.workers.dev'
          for f in flight-data.js flight-data-recent.js; do
            for a in 1 2 3; do
              if curl -fsS -m 30 -X PUT -H "Authorization: Bearer $DATA_WRITE_TOKEN" \
                   --data-binary @"$f" "$U/$f" >/dev/null; then
                echo "R2 ok: $f"; break
              fi
              [ "$a" = 3 ] && echo "::warning::R2 PUT $f failed after 3 attempts"
              sleep $((a * 2))
            done
          done
```

- [ ] **Step 3: Lint the YAML**

Run: `cd /Users/nugui/flight-schedule-feed && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/fetch_schedule.yml')); print('ok')"`
Expected: `ok`.

- [ ] **Step 4: Commit + push**

```bash
git add .github/workflows/fetch_schedule.yml
git commit -m "feat(ci): publish flight data to R2 in fetch_schedule.yml

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 5: Verify on the next scheduled proof run** (or `gh workflow run "Fetch Flight Schedule & Deploy" -R AP127CMD/CMD_CTR -f force=true`)

Expected: the `Publish data to R2` step logs `R2 ok: flight-data.js` / `R2 ok: flight-data-recent.js`.

---

### Task 5: DB001 writer — `update-cache.yml` PUTs `cache.json`

**Files:**
- Modify: `AP127_NGT_001/.github/workflows/update-cache.yml`

**Interfaces:**
- Consumes: repo secret `DATA_WRITE_TOKEN`; Worker `PUT` contract.
- Produces: R2 object `cache.json` updated whenever `update-cache.yml` commits a change.

- [ ] **Step 1: Add repo secret** (user)

Run: `gh secret set DATA_WRITE_TOKEN -R AP127CMD/DB001` (paste the token).

- [ ] **Step 2: Add the PUT step**

In `update-cache.yml`, immediately **after** the `Push AP127 slice to Cloudflare KV` step, add:
```yaml
      # Publish cache.json to R2 (ap127-data Worker) so CMDV2's ngt-data
      # snapshot reads it without a DB001 Pages rebuild. Non-fatal.
      - name: Publish cache.json to R2
        if: success()
        env:
          DATA_WRITE_TOKEN: ${{ secrets.DATA_WRITE_TOKEN }}
        run: |
          [ -n "$DATA_WRITE_TOKEN" ] || { echo "DATA_WRITE_TOKEN unset — skipping"; exit 0; }
          U='https://ap127-data.anusorn-tanmetha.workers.dev'
          for a in 1 2 3; do
            if curl -fsS -m 30 -X PUT -H "Authorization: Bearer $DATA_WRITE_TOKEN" \
                 --data-binary @cache.json "$U/cache.json" >/dev/null; then
              echo "R2 ok: cache.json"; exit 0
            fi
            [ "$a" = 3 ] && echo "::warning::R2 PUT cache.json failed after 3 attempts"
            sleep $((a * 2))
          done
```

- [ ] **Step 3: Lint + commit + push**

```bash
cd /Users/nugui/AP127_NGT_001
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/update-cache.yml')); print('ok')"
git add .github/workflows/update-cache.yml
git commit -m "feat(ci): publish cache.json to R2 in update-cache.yml

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 4: Verify**

Run: `gh workflow run "Update cache.json" -R AP127CMD/DB001` then check the run log for `R2 ok: cache.json`, then `curl -s https://ap127-data.anusorn-tanmetha.workers.dev/cache.json | head -c 80`.

---

### Task 6: Watchdog `POST /notify` push endpoint + `*/2` cron

**Files:**
- Modify: `AP127_V2/watchdog/src/index.js`
- Modify: `AP127_V2/watchdog/wrangler.toml`
- Test: `AP127_V2/watchdog/test/notify.test.js` (new)

**Interfaces:**
- Consumes: existing `runWatchdog(env)` (line ~170), existing `env.WATCHDOG_API_KEY`.
- Produces: `POST /notify` — header `X-API-Key: <WATCHDOG_API_KEY>` required → `202 {"ok":true}` and `ctx.waitUntil(runWatchdog(env))`; wrong/missing key → `401`.

- [ ] **Step 1: Write the failing test**

`AP127_V2/watchdog/test/notify.test.js`:
```js
import { describe, it, expect, vi } from 'vitest';

// handleFetch is not exported; test via the default export's fetch, stubbing runWatchdog
// is not possible without a seam, so this test asserts routing + auth only, using a
// KV stub so runWatchdog short-circuits cheaply on the "no snapshot" path.
import worker from '../src/index.js';

function fakeKV() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => void m.set(k, v),
  };
}

const env = () => ({
  KV: fakeKV(),
  WATCHDOG_API_KEY: 'k',
  TELEGRAM_BOT_TOKEN: 't',
  TELEGRAM_CHAT_ID: '1',
});

const ctx = { waitUntil: () => {} };

describe('POST /notify', () => {
  it('401 without the API key', async () => {
    const res = await worker.fetch(
      new Request('https://w/notify', { method: 'POST' }), env(), ctx);
    expect(res.status).toBe(401);
  });
  it('202 with the API key', async () => {
    const res = await worker.fetch(
      new Request('https://w/notify', { method: 'POST', headers: { 'X-API-Key': 'k' } }),
      env(), ctx);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `cd /Users/nugui/AP127_V2/watchdog && npx vitest run test/notify.test.js`
Expected: FAIL — `/notify` currently falls through to the 404/default handler (not 202).

- [ ] **Step 3: Add the route**

In `AP127_V2/watchdog/src/index.js` `handleFetch`, immediately after the `OPTIONS` preflight block and before `GET /status`, add:
```js
  // POST /notify — push trigger: a Pi/CI publish calls this so the diff runs
  // immediately instead of waiting up to one cron interval. runWatchdog()
  // already no-ops cheaply when extractFeedSig shows the feed is unchanged,
  // so a duplicate or spurious notify is harmless.
  if (url.pathname === '/notify' && request.method === 'POST') {
    if (request.headers.get('X-API-Key') !== env.WATCHDOG_API_KEY) {
      return json({ error: 'unauthorized' }, 401);
    }
    ctx.waitUntil(runWatchdog(env));
    return json({ ok: true }, 202);
  }
```

- [ ] **Step 4: Thread `ctx` into `handleFetch`**

`handleFetch(request, env)` has no `ctx`. Change its signature to `handleFetch(request, env, ctx)` and update the default export:
```js
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWatchdog(env));
  },
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },
};
```

- [ ] **Step 5: Run — expect pass**

Run: `npx vitest run test/notify.test.js && npx vitest run`
Expected: `notify.test.js` PASS; full suite still green.

- [ ] **Step 6: Tighten the cron**

`AP127_V2/watchdog/wrangler.toml`: change
```toml
crons = ["*/5 * * * *"]
```
to
```toml
crons = ["*/2 * * * *"]
```

- [ ] **Step 7: Commit + deploy**

```bash
cd /Users/nugui/AP127_V2/watchdog
git add src/index.js wrangler.toml test/notify.test.js
git commit -m "feat(watchdog): POST /notify push trigger + tighten cron to */2

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
npm run deploy
```
Expected: `Published ap127-watchdog` with `schedule: */2 * * * *`.

- [ ] **Step 8: Smoke-test live**

Run: `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "X-API-Key: <WATCHDOG_API_KEY>" https://ap127-watchdog.anusorn-tanmetha.workers.dev/notify`
Expected: `202`. (Get the key from `wrangler secret list` context / the user.)

---

### Task 7: Pi + CI call `/notify` after publishing

**Files:**
- Modify: `flight-schedule-feed/pi-native/run_fetch.sh`
- Modify: `flight-schedule-feed/.github/workflows/fetch_schedule.yml`

**Interfaces:**
- Consumes: Task 6's `POST /notify`; `WATCHDOG_NOTIFY_KEY` (Pi `.env`) / `WATCHDOG_NOTIFY_KEY` repo secret (CI).

- [ ] **Step 1: Pi — add the call**

In `run_fetch.sh`, at the very end (after the CMDV2 refresh curl, after the `r2_failed` check), append:
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

- [ ] **Step 2: CI — add the step**

In `fetch_schedule.yml`, after `Trigger CMDV2 refresh`:
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

- [ ] **Step 3: Secrets** (user)

```bash
gh secret set WATCHDOG_NOTIFY_KEY -R AP127CMD/CMD_CTR      # value = the watchdog's WATCHDOG_API_KEY
ssh dietpi@DietPi.local "grep -q WATCHDOG_NOTIFY_KEY ~/flight-schedule-feed/pi-native/.env || \
  echo 'WATCHDOG_NOTIFY_KEY=<key>' >> ~/flight-schedule-feed/pi-native/.env"
```

- [ ] **Step 4: Lint, commit, push**

```bash
cd /Users/nugui/flight-schedule-feed
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/fetch_schedule.yml')); print('ok')"
git add pi-native/run_fetch.sh .github/workflows/fetch_schedule.yml
git commit -m "feat: push-trigger the watchdog after a data publish

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 5: Verify end-to-end**

After the next Pi commit: the watchdog log (`wrangler tail ap127-watchdog` or its `/status`) shows a run within seconds of the commit, not on the next even-minute. Make a trivial real schedule change if one is available, or trust the `/notify` 202 + a `wrangler tail` line.

---

### Task 8: Repoint CMD_CTR's browser consumer

**Files:**
- Modify: `flight-schedule-feed/index.html:37`

- [ ] **Step 1: Swap the script src**

`flight-schedule-feed/index.html` line 37 — replace:
```html
<script src="flight-data.js?v=1778610943"></script>
```
with:
```html
<script src="https://ap127-data.anusorn-tanmetha.workers.dev/flight-data.js"></script>
```

- [ ] **Step 2: Bump the cache token** (per CMD_CTR's update rule — the other `?v=rNN` script tags)

Run: `cd /Users/nugui/flight-schedule-feed && grep -o '?v=r[0-9]*' index.html | sort -u`
Then bump every `?v=r45` → `?v=r46` in `index.html` (leave the now-removed flight-data line alone).

- [ ] **Step 3: Commit + push**

```bash
git add index.html
git commit -m "r46: load flight-data.js from the ap127-data Worker (R2)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 4: Verify live** (after the Pages deploy completes, ~1 min)

- Open `https://ap127-cmd-ctr.pages.dev` in the browser preview.
- Network tab: `flight-data.js` request goes to `ap127-data.anusorn-tanmetha.workers.dev`, `200`, `content-type: application/javascript`.
- Console: no errors; a view that shows flight counts renders the same numbers as before.
- `read_console_messages` clean.

---

### Task 9: Repoint CMDV2's browser consumers + drop the mirror

**Files:**
- Modify: `AP127_V2/index.html:53`, `AP127_V2/legacy.html:67`, `AP127_V2/ops/index.html:37`, `AP127_V2/crosscheck/index.html:91`, `AP127_V2/overview/index.html:64`
- Delete: `AP127_V2/flight-data.js`
- Modify: `AP127_V2/scripts/refresh_snapshots.mjs`

- [ ] **Step 1: Swap all five script tags**

Replace each of these with `<script src="https://ap127-data.anusorn-tanmetha.workers.dev/flight-data.js"></script>` (preserve surrounding attributes/indentation):
- `index.html:53` — `<script src="flight-data.js"></script>`
- `legacy.html:67` — `<script src="flight-data.js"></script>`
- `ops/index.html:37` — `<script src="flight-data.js?v=1778610943"></script>`
- `crosscheck/index.html:91` — `<script src="../flight-data.js"></script>`
- `overview/index.html:64` — `<script src="../flight-data.js"></script>`

Run to confirm none missed: `cd /Users/nugui/AP127_V2 && grep -rn 'src="\.\?\.\?/\?flight-data\.js' --include=*.html .`
Expected: no matches.

- [ ] **Step 2: Delete the stale mirror file**

Run: `git rm flight-data.js`

- [ ] **Step 3: Trim `refresh_snapshots.mjs`**

In `AP127_V2/scripts/refresh_snapshots.mjs`:
- Delete the entire `refreshSource('flight-data', …)` block (the `await refreshSource('flight-data', async () => { … })` call and its `FLIGHT_SRC` const if unused elsewhere).
- Change `NGT_SRC` from `'https://ap127-db001.pages.dev/cache.json'` to `'https://ap127-data.anusorn-tanmetha.workers.dev/cache.json'`.
- Leave the `progress-data` block and `PROGRESS_SRC` untouched.
- Update the file header comment: source 1 is no longer "Command Center's published copy"; `flight-data.js` is now served to the browser directly by the `ap127-data` Worker and no longer mirrored here.

Run: `node --check scripts/refresh_snapshots.mjs`
Expected: no syntax error.

- [ ] **Step 4: Bump CMDV2's cache token** (its `index.html` uses `?v=pNNN` per its CLAUDE.md — bump per that rule).

- [ ] **Step 5: Commit + push**

```bash
git add index.html legacy.html ops/index.html crosscheck/index.html overview/index.html scripts/refresh_snapshots.mjs
git rm flight-data.js
git commit -m "pNNN: load flight-data.js from the ap127-data Worker; drop the local mirror

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 6: Verify live**

- `https://ap127-ngt2.pages.dev` — SCHEDULE/ops views render; Network shows `flight-data.js` from the Worker; console clean.
- `https://ap127-ngt2.pages.dev/overview/` and `/crosscheck/` — same check (they used `../flight-data.js`).
- DB_Share (`https://ap127-dashboardr1.pages.dev`) — the proxied Detail view still renders (it mirrors CMDV2's output).
- Trigger `refresh-data.yml` once (`gh workflow run "Refresh data snapshots" -R AP127CMD/CMDV2`); its run logs no longer mention flight-data and still refresh progress/ngt.

---

### Task 10: Repoint the backend Workers

**Files:**
- Modify: `AP127_V2/watchdog/src/index.js` (`FLIGHT_SRC`, ~line 16)
- Modify: `AP127_NGT_001/dispatcher/worker.js` (stale-check URL, ~line 82)

- [ ] **Step 1: Watchdog feed source**

`AP127_V2/watchdog/src/index.js` — change:
```js
const FLIGHT_SRC = 'https://raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data-recent.js';
```
to:
```js
const FLIGHT_SRC = 'https://ap127-data.anusorn-tanmetha.workers.dev/flight-data-recent.js';
```
Update the adjacent comment (the "2026-08-16: points at CMD_CTR's small … feed" note) to say the feed is now served by the `ap127-data` Worker from R2.

- [ ] **Step 2: Dispatcher stale-check source**

`AP127_NGT_001/dispatcher/worker.js` — change the `FEED_URL` (the `raw.githubusercontent.com/.../flight-data-recent.js` constant, ~line 82) to `https://ap127-data.anusorn-tanmetha.workers.dev/flight-data-recent.js`. The `Range: bytes=0-599` request is unchanged — Task 1 supports it. Update the comment about `raw.githubusercontent` honouring Range to reference the Worker.

- [ ] **Step 3: Run both test suites**

```bash
cd /Users/nugui/AP127_V2/watchdog && npx vitest run
cd /Users/nugui/AP127_NGT_001/dispatcher && (npx vitest run 2>/dev/null || echo "no dispatcher tests — manual check")
```
Expected: watchdog green; dispatcher unchanged logic.

- [ ] **Step 4: Commit + deploy both**

```bash
cd /Users/nugui/AP127_V2/watchdog
git add src/index.js && git commit -m "feat(watchdog): read the feed from the ap127-data Worker

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
npm run deploy

cd /Users/nugui/AP127_NGT_001
git add dispatcher/worker.js && git commit -m "feat(dispatcher): read feed age from the ap127-data Worker

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main   # dispatcher auto-deploys via deploy-dispatcher.yml
```

- [ ] **Step 5: Verify**

- `wrangler tail ap127-watchdog` over one cron tick → `Upstream HTTP` errors absent, a normal run logged.
- `wrangler tail ap127-dispatcher` over one tick → `feed age N min` logged with a plausible number (not `age-unknown`/`age-check-error`).

---

### Task 11: Dispatcher — DB001 target to */15

**Files:**
- Modify: `AP127_NGT_001/dispatcher/worker.js` (`scheduled`, ~line 119)
- Test: `AP127_NGT_001/dispatcher/test/cadence.test.js` (new, if the dir has no test setup, add a minimal `package.json` + `vitest`)

**Interfaces:**
- Produces: the DB001 dispatch fires only when `new Date(event.scheduledTime).getUTCMinutes() % 15 === 0`.

- [ ] **Step 1: Extract a testable predicate**

At module scope in `worker.js`:
```js
// DB001's cache only needs to track flight-data freshness (~12-18 min, ~3-5 min
// post-Phase-2), not the dispatcher's own 5-min tick. Dispatch it every 3rd tick.
export function shouldDispatchDb001(scheduledTimeMs) {
  return new Date(scheduledTimeMs).getUTCMinutes() % 15 === 0;
}
```

- [ ] **Step 2: Write the failing test**

`AP127_NGT_001/dispatcher/test/cadence.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { shouldDispatchDb001 } from '../worker.js';

const at = (h, m) => Date.UTC(2026, 8, 6, h, m, 0);

describe('shouldDispatchDb001', () => {
  it('fires at :00 :15 :30 :45', () => {
    for (const m of [0, 15, 30, 45]) expect(shouldDispatchDb001(at(10, m))).toBe(true);
  });
  it('skips the other 5-min ticks', () => {
    for (const m of [5, 10, 20, 25, 35, 40, 50, 55]) expect(shouldDispatchDb001(at(10, m))).toBe(false);
  });
});
```

- [ ] **Step 3: Run — expect fail**

Run: `cd /Users/nugui/AP127_NGT_001/dispatcher && npm i -D vitest >/dev/null 2>&1; npx vitest run test/cadence.test.js`
Expected: FAIL — `shouldDispatchDb001` not exported.

- [ ] **Step 4: Wire the predicate into `scheduled`**

In `scheduled(event, env, _ctx)`, replace the unconditional DB001 target push. The `targets` array currently starts with the DB001 entry; change to build it conditionally:
```js
    const targets = [];
    if (shouldDispatchDb001(event.scheduledTime)) {
      targets.push({
        url: 'https://api.github.com/repos/AP127CMD/DB001/actions/workflows/update-cache.yml/dispatches',
        label: 'DB001 update-cache.yml',
      });
    } else {
      console.log('DB001 update-cache: skipped (off-tick — runs at :00/:15/:30/:45)');
    }
```
(Keep the long explanatory comment block that was above the old DB001 entry, moved to sit above this `if`.)

- [ ] **Step 5: Run — expect pass**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Add `event.scheduledTime` guard**

`event.scheduledTime` is a number (ms). If a local `wrangler dev --test-scheduled` passes `undefined`, `new Date(undefined).getUTCMinutes()` is `NaN` and `NaN % 15 === 0` is `false` → DB001 never dispatches in dev. That is acceptable (dev only); no code change, but note it in the comment.

- [ ] **Step 7: Commit + push**

```bash
cd /Users/nugui/AP127_NGT_001
git add dispatcher/worker.js dispatcher/test/cadence.test.js dispatcher/package.json
git commit -m "feat(dispatcher): dispatch DB001 update-cache every 15 min, not 5

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 8: Verify**

`wrangler tail ap127-dispatcher` across ~20 min: `DB001 update-cache: skipped (off-tick …)` on the :05/:10 ticks, an actual dispatch on the :00/:15 tick. DB001's Actions tab shows `update-cache` runs ~15 min apart (plus its hourly `schedule:` safety net).

---

### Task 12: Pages build watch paths

**Files:** none (dashboard / API). Requires the user if the API path fails.

- [ ] **Step 1: Try the API**

```bash
TOK=$(python3 -c "import re;print(re.search(r'oauth_token = \"([^\"]+)\"',open('/Users/nugui/.wrangler/config/default.toml').read()).group(1))")
ACC=ae38e04e56d0ae52d3ec47ad29977587
for proj in ap127-cmd-ctr ap127-ngt2 ap127-db001; do
  curl -s -X PATCH -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/accounts/$ACC/pages/projects/$proj" \
    -d '{"build_config":{"path_excludes":["PLACEHOLDER"]}}' | python3 -m json.tool | head -20
done
```
If the response shows `path_excludes` accepted, set the real values:
- `ap127-cmd-ctr`: `["flight-data.js","flight-data-recent.js","data/*"]`
- `ap127-ngt2`: `["flight-data.js","flight-data-recent.js","progress-data.js","ngt-data.js"]`
- `ap127-db001`: `["cache.json","student.html"]`

- [ ] **Step 2: Dashboard fallback** (if the API rejects `path_excludes`)

For each project: **dash.cloudflare.com → Workers & Pages → `<project>` → Settings → Build → Build watch paths → Exclude paths**, enter the values above (one per line), Save.

- [ ] **Step 3: Verify a data-only push is skipped**

After the next Pi commit (data-only), check:
```bash
TOK=…; ACC=…
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/pages/projects/ap127-cmd-ctr/deployments?page=1&per_page=5" \
  | python3 -c 'import json,sys; [print(d["created_on"], d["latest_stage"]["name"], d["latest_stage"]["status"], d["deployment_trigger"]["metadata"]["commit_message"][:50]) for d in json.load(sys.stdin)["result"]]'
```
Expected: no new deployment for the data-only commit (or one with stage `queued`/status `skipped`).

- [ ] **Step 4: Verify a code push still builds** — Task 8/9 pushes already exercised this; confirm those deployments succeeded.

- [ ] **Step 5: No commit** (dashboard state).

---

### Task 13: Portal mindmap diagram + soak

**Files:**
- Modify: `AP127_Portal/mindmap.html`

- [ ] **Step 1: Update the mermaid text**

In `AP127_Portal/mindmap.html`, update the architecture diagram labels to reflect the new data plane:
- The `WF1` node "Every 30 min" → "Every ~12-18 min (Pi primary)".
- Add a node for the `ap127-data` Worker / R2 between the fetch workflows and the render nodes.
- The `R1 -->|"raw.githubusercontent.com\nflight-data.js"| WF3` edge → CMDV2 reads `flight-data.js` from the `ap127-data` Worker; `refresh-data.yml` no longer mirrors it.
- The `R1`/`R3` "flight-data.js + full app code" nodes → app code only; data served by the Worker.

Exact new mermaid is author's discretion — the constraint is that it matches §3 of the spec.

- [ ] **Step 2: Commit + push**

```bash
cd /Users/nugui/AP127_Portal
git add mindmap.html
git commit -m "docs: mindmap reflects the ap127-data Worker data plane

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 3: Soak 48 h — checklist**

- CF API deployment count for all three projects flat (only code deploys). Re-run the counting script from the spec investigation.
- `https://ap127-data.anusorn-tanmetha.workers.dev/flight-data-recent.js` `fetchedAt` tracks the newest CMD_CTR commit within ~1 cycle.
- `ap127-watchdog` `/status` `healthy: true`, `staleMinutes` low; Telegram notices arrive within seconds of a real change (check message timestamps vs commit timestamps).
- `ap127-dispatcher` tail: no `dispatcher-failure` issues; DB001 dispatched on the quarter-hours only.
- No open issues on any of the three repos related to fetch/cache/dispatch.

---

### Task 14: Documentation (universal update rule)

**Files:**
- Modify: `flight-schedule-feed/CLAUDE.md`, `AP127_V2/CLAUDE.md`, `AP127_NGT_001/CLAUDE.md`, `AP127_Docs/README.md`, `flight-schedule-feed/pi-native/README.md`
- Modify: `/Users/nugui/CLAUDE.md` (ecosystem key facts — data pipeline bullet)

- [ ] **Step 1: `flight-schedule-feed/CLAUDE.md`** — new "## Data plane (2026-09-06)" section: the Worker URL + bucket, the write-token model, which files are R2-served vs Git-only, the build-watch-paths exclude lists, the `/notify` push, and the Phase-2 cadence knobs (`FETCH_RPC_CONCURRENCY`, timer, `STANDBY_MAX_AGE_MIN`). Add a line to the fetch-roles table.

- [ ] **Step 2: `AP127_V2/CLAUDE.md`** — note the feed now comes from the `ap127-data` Worker; `flight-data.js` deleted from the repo; `refresh-data.yml` no longer mirrors flight data; watchdog cron is `*/2` + has `/notify`; build watch paths set.

- [ ] **Step 3: `AP127_NGT_001/CLAUDE.md`** — `cache.json` published to R2; dispatcher dispatches DB001 every 15 min; build watch paths set.

- [ ] **Step 4: `AP127_Docs/README.md`** — update §2.1 / §2.2 / §2.4 architecture; add a §10 dated log entry describing this change; then:
```bash
cd /Users/nugui/AP127_Docs
git add README.md && git commit -m "docs: R2 data-plane decoupling + watchdog push (2026-09-06)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 5: `pi-native/README.md`** — the two new `.env` keys, the PUT + `/notify` steps, the Phase-2 cadence change.

- [ ] **Step 6: `/Users/nugui/CLAUDE.md`** — rewrite the "Data pipeline" key-ecosystem-fact bullet to describe the Worker/R2 plane and the new thresholds.

- [ ] **Step 7: Commit each repo's CLAUDE.md** with its own push (CMD_CTR/CMDV2/DB001 pushes are data-excluded now, so a CLAUDE.md push does trigger one build each — fine).

---

## PHASE 2 — cut scrape duration (after the 48 h soak)

### Task 15: Parallelise the per-date RPC

**Files:**
- Modify: `flight-schedule-feed/scripts/fetch_schedule.py`
- Test: `flight-schedule-feed/scripts/tests/test_concurrency.py` (new)

**Interfaces:**
- Produces: env var `FETCH_RPC_CONCURRENCY` (int, default `4`, `1` = today's serial behaviour) controlling how many `getStudentSchedule` date calls are in flight at once.

- [ ] **Step 1: Locate the date loop** — the sequential `for date in dates:` block in `scrape_window()` that calls `_fetch_one_date(date)` / the `getStudentSchedule` RPC. Read it and its retry/stable-empty helpers fully before changing anything.

- [ ] **Step 2: Write the failing test**

`scripts/tests/test_concurrency.py`:
```python
import asyncio, os, time
from scripts.fetch_schedule import _gather_dates_bounded  # new helper (Step 4)

def test_bounded_concurrency_runs_all_and_caps_parallelism():
    seen_parallel = []
    active = 0
    async def fake_fetch(date):
        nonlocal active
        active += 1
        seen_parallel.append(active)
        await asyncio.sleep(0.05)
        active -= 1
        return (date, {"flights": [date]})
    dates = [f"2026-09-{d:02d}" for d in range(1, 11)]
    results = asyncio.run(_gather_dates_bounded(dates, fake_fetch, concurrency=3))
    assert sorted(results.keys()) == sorted(dates)
    assert max(seen_parallel) <= 3
    assert max(seen_parallel) >= 2  # actually parallelised

def test_concurrency_one_is_serial():
    order = []
    async def fake_fetch(date):
        order.append(("start", date))
        await asyncio.sleep(0.01)
        order.append(("end", date))
        return (date, {})
    dates = ["a", "b", "c"]
    asyncio.run(_gather_dates_bounded(dates, fake_fetch, concurrency=1))
    assert order == [("start","a"),("end","a"),("start","b"),("end","b"),("start","c"),("end","c")]
```

- [ ] **Step 3: Run — expect fail**

Run: `cd /Users/nugui/flight-schedule-feed && python -m pytest scripts/tests/test_concurrency.py -v`
Expected: FAIL — `_gather_dates_bounded` does not exist.

- [ ] **Step 4: Implement the bounded-gather helper**

Add to `scripts/fetch_schedule.py`:
```python
async def _gather_dates_bounded(dates, fetch_one, concurrency):
    """Run fetch_one(date) for every date, at most `concurrency` at a time.
    fetch_one is a coroutine returning (date, result). Returns {date: result}.
    concurrency=1 is exactly serial (see test_concurrency_one_is_serial)."""
    sem = asyncio.Semaphore(max(1, int(concurrency)))
    out = {}
    async def run(date):
        async with sem:
            d, res = await fetch_one(date)
            out[d] = res
    await asyncio.gather(*(run(d) for d in dates))
    return out
```

- [ ] **Step 5: Run — expect pass**

Run: `python -m pytest scripts/tests/test_concurrency.py -v`
Expected: PASS.

- [ ] **Step 6: Wire it into `scrape_window()`**

Replace the sequential date loop with a call to `_gather_dates_bounded`, reading concurrency from the environment:
```python
FETCH_RPC_CONCURRENCY = int(os.environ.get("FETCH_RPC_CONCURRENCY", "4"))
# … inside scrape_window(), where the per-date loop was:
async def _one(date):
    return date, await _fetch_one_date_async(date)   # existing per-date logic incl. its retry + stable-empty check
results = await _gather_dates_bounded(target_dates, _one, FETCH_RPC_CONCURRENCY)
for date, res in results.items():
    schedules[date] = res   # same merge as before
```
Keep the Canceled-mode second pass and the leave/cancel backfill **sequential and unchanged**. Keep every existing guard (`FETCH_DATE_ATTEMPTS`, the stable-empty re-check, `REGRESSION_GUARD_MAX_STREAK`, the frozen archive override).

If `_fetch_one_date` is currently synchronous Playwright code, the minimal change is to wrap the existing per-date function in `asyncio.to_thread(...)` inside `_one` rather than rewriting it async — a Playwright `sync_api` page is not safe to share across threads, so in that case use a small pool of `context.new_page()` instances (one per concurrency slot) instead. Decide during Step 1 based on which Playwright API the file uses; document the choice in the commit message.

- [ ] **Step 7: Run the full scraper test suite**

Run: `python -m pytest scripts/tests/ -v`
Expected: all existing tests still PASS (79+ per the CLAUDE.md).

- [ ] **Step 8: Commit**

```bash
git add scripts/fetch_schedule.py scripts/tests/test_concurrency.py
git commit -m "feat(scraper): bounded-concurrency per-date RPC (FETCH_RPC_CONCURRENCY, default 4)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Live-test at concurrency 1 first, then 4**

- Push with the Pi's `.env` holding `FETCH_RPC_CONCURRENCY=1`; confirm a normal cycle (unchanged behaviour).
- Set `FETCH_RPC_CONCURRENCY=4` on the Pi; watch 3–4 cycles in `journalctl -u ap127-fetch`.
- Diff the committed `data/flight_schedule.json` for the same window against a concurrency-1 baseline commit — flight counts and statuses must match.
- Watch for `schema-drift` / regression-guard warnings and any `getStudentSchedule` empty/stale responses. Back to `2` or `1` if any appear.
- Record the measured full-window scrape time (target ≤ 3 min).

---

### Task 16: Flip the Pi cadence

**Files:**
- Modify: `flight-schedule-feed/pi-native/ap127-fetch.timer`
- Modify: `flight-schedule-feed/pi-native/run_fetch.sh` (`STANDBY_MAX_AGE_MIN` default)

**Precondition:** Task 15 proven over ≥ 24 h at `FETCH_RPC_CONCURRENCY=4` with no drift and a measured scrape ≤ ~4 min.

- [ ] **Step 1: Timer interval**

`pi-native/ap127-fetch.timer` — change `OnUnitActiveSec=5min` → `OnUnitActiveSec=3min`.

- [ ] **Step 2: Duplicate-work guard default**

`pi-native/run_fetch.sh` — change:
```bash
STANDBY_MAX_AGE_MIN="${STANDBY_MAX_AGE_MIN:-6}"
```
to:
```bash
STANDBY_MAX_AGE_MIN="${STANDBY_MAX_AGE_MIN:-3}"
```
Update the surrounding comment: the guard now sits just above a 3-min timer.

- [ ] **Step 3: Commit + push + deploy to the Pi**

```bash
git add pi-native/ap127-fetch.timer pi-native/run_fetch.sh
git commit -m "feat(pi): 3-min fetch cadence (timer + standby guard)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
ssh dietpi@DietPi.local "cd ~/flight-schedule-feed && git pull --rebase && \
  sudo cp pi-native/ap127-fetch.timer /etc/systemd/system/ap127-fetch.timer && \
  sudo systemctl daemon-reload && sudo systemctl restart ap127-fetch.timer && \
  systemctl status ap127-fetch.timer --no-pager | head -5"
```
(Confirm the deployed unit path — `pi-native/install.sh` is the source of truth for where the units live.)

- [ ] **Step 4: Monitor a week**

- `journalctl -u ap127-fetch` — cycles landing ~3–5 min apart, no rise in failed cycles.
- Google bot-detection: no new `userHtmlFrame never appeared` / session-expired patterns; the Pi monitor stays green.
- If Google reacts: `STANDBY_MAX_AGE_MIN=6` and `OnUnitActiveSec=5min` (or `FETCH_RPC_CONCURRENCY=1`) each revert independently.

- [ ] **Step 5: Final docs pass** — update the cadence numbers in all the CLAUDE.md files + `AP127_Docs/README.md` §10 with the measured results.

---

## Self-Review

**Spec coverage:**
- §4.1 Worker → Task 1. §4.2 seed → Task 2. §4.3 writers → Tasks 3/4/5. §4.4 readers → Tasks 8/9/10. §4.5 build watch paths → Task 12. §4.6 `/notify` → Tasks 6/7. §4.7 DB001 */15 → Task 11. §5.1 parallelise → Task 15. §5.2 cadence → Task 16. §5.3 table → Tasks 6/16. §6 rollout order → task order + Task 13 soak. §7 rollback → each task's changes are individually revertible; noted in spec. §8 docs → Task 14 + Task 16 Step 5. §9 open items → mindmap resolved (Task 13, docs-only), build-watch-paths API (Task 12 Step 1), `/notify` key reuse (Task 6), dispatcher `scheduledTime` (Task 11 Step 6).
- Gap check: DB_Share needs no change (proxy) — verified in Task 9 Step 6. `AP127_Portal/mindmap.html` is diagram text only — Task 13.

**Placeholder scan:** `<DATA_WRITE_TOKEN>` / `<key>` / `<WATCHDOG_API_KEY>` / `pNNN` are runtime values the operator substitutes, not plan gaps. Task 15 Step 6 leaves the sync-vs-async Playwright decision to Step 1's findings — unavoidable without the file open, and the decision criteria + both code paths are given.

**Type consistency:** `put_r2` (bash, Task 3) vs `Publish data to R2` (YAML step, Task 4) — different mechanisms, same contract, intentional. `_gather_dates_bounded(dates, fetch_one, concurrency)` signature identical in Task 15 Steps 2/4/6. `shouldDispatchDb001(scheduledTimeMs)` identical in Task 11 Steps 1/2/4. Worker route `/notify` returns `202 {ok:true}` in Task 6 Step 3 and consumed as `202` in Task 7 — consistent.
