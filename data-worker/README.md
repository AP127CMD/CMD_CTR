# ap127-data Worker

R2-backed static file server for the AP127 flight-data plane. Decouples data
updates from Cloudflare Pages builds — see
`../docs/superpowers/specs/2026-09-06-r2-data-plane-decoupling-design.md` and
`../docs/superpowers/plans/2026-09-06-r2-data-plane-decoupling.md`.

- **URL:** https://ap127-data.anusorn-tanmetha.workers.dev
- **Bucket:** `ap127-data` (R2)
- **Keys (allowlisted):** `flight-data.js`, `flight-data-recent.js`, `cache.json`

## Endpoints

| Method | Behaviour |
|---|---|
| `GET /<key>` | Public. `Content-Type` js/json, `Cache-Control: public, max-age=60, stale-while-revalidate=240`, `ETag` + `If-None-Match` → 304, `Range` → 206. Unknown key → 404. |
| `PUT /<key>` | `Authorization: Bearer $DATA_WRITE_TOKEN`. 8 MiB cap. Bad key → 400, bad token → 401. |
| `OPTIONS` | 204 + CORS (`*`). Other methods → 405. |

## Develop / test

```
npm install
npm test
```

Tests are plain vitest against an in-memory R2 stub (matches `AP127_V2/watchdog`).

## Deploy

```
npx wrangler r2 bucket create ap127-data     # first time only
npx wrangler secret put DATA_WRITE_TOKEN      # first time / rotation — value: openssl rand -hex 32
npm run deploy
```

## Seed / manual write

```
T=<DATA_WRITE_TOKEN>
U=https://ap127-data.anusorn-tanmetha.workers.dev
curl -fsS -X PUT -H "Authorization: Bearer $T" --data-binary @flight-data.js        "$U/flight-data.js"
curl -fsS -X PUT -H "Authorization: Bearer $T" --data-binary @flight-data-recent.js "$U/flight-data-recent.js"
curl -fsS https://ap127-db001.pages.dev/cache.json | \
  curl -fsS -X PUT -H "Authorization: Bearer $T" --data-binary @- "$U/cache.json"
```

## Writers (production)

- Pi: `pi-native/run_fetch.sh` PUTs `flight-data*.js` each successful cycle.
- CI fallback: `.github/workflows/fetch_schedule.yml`.
- DB001: `AP127_NGT_001/.github/workflows/update-cache.yml` PUTs `cache.json`.

All writes are non-fatal and conditional on a real data change.
