# ap127-data Worker

Stateless proxy in front of `raw.githubusercontent.com` for the AP127
flight-data plane. Re-serves the data files with a browser-usable
`Content-Type` + a 60 s edge cache, so data commits no longer trigger a
Cloudflare Pages rebuild. **No bindings, no storage, no secrets.**

See `../docs/superpowers/specs/2026-09-06-r2-data-plane-decoupling-design.md`.

- **URL:** https://ap127-data.anusorn-tanmetha.workers.dev
- **Keys (allowlisted → upstream):**
  | key | upstream |
  |---|---|
  | `flight-data.js` | `raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data.js` |
  | `flight-data-recent.js` | `raw.githubusercontent.com/AP127CMD/CMD_CTR/main/flight-data-recent.js` |
  | `cache.json` | `raw.githubusercontent.com/AP127CMD/DB001/main/cache.json` |

## Behaviour

| Request | Response |
|---|---|
| `GET /<key>` | 200, `Content-Type` js/json, `Cache-Control: public, max-age=60, stale-while-revalidate=240`, upstream `ETag`, `Accept-Ranges: bytes`. Served from the edge cache (~60 s) on repeat. |
| `GET` with `Cache-Control: no-cache` | Bypasses our edge cache **and** raw.github's (adds `?_=<ts>`), fetches fresh. Used by the watchdog / dispatcher. |
| `GET` with `Range: bytes=…` | Forwarded upstream → 206 + `Content-Range` (the dispatcher's `bytes=0-599` age check). |
| `GET` with `If-None-Match` | Forwarded upstream → 304 when unchanged. |
| unknown key | 404 (no upstream fetch) |
| `PUT` / `DELETE` / … | 405 |
| `OPTIONS` | 204 + CORS (`*`) |
| upstream 5xx / unreachable | 502 |

## Develop / test / deploy

```
npm install
npm test          # plain vitest, fetch + caches stubbed
npx wrangler deploy
```

Freshness: browser reads land within ~1 min of a git push (our 60 s cache) plus
raw.github propagation (usually seconds, up to ~5 min). The watchdog's
`no-cache` reads see the push within seconds.
