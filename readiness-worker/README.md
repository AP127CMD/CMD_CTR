# ap127-readiness

Relay between the Readiness Planner watch app (FR570) and the Pi job
(`pi-native/readiness/`). Stores the latest watch payload and the Apply queue in KV.

| Route | Key | |
|---|---|---|
| `PUT /plan` | PI_KEY | store payload (≤16 KB, `v:1`) |
| `GET /plan` | WATCH_KEY | payload + current `applies` |
| `POST /apply` `{id}` | WATCH_KEY | queue an applyable move (`ap:1` in the current plan), 10/h |
| `GET /apply/pending` | PI_KEY | pending applies |
| `POST /apply/result` `{id,st,why}` | PI_KEY | `st` ∈ ok/failed/dryrun |

Keys live in `~/.ap127-readiness/{pi,watch}.key` on the Mac, the Pi's
`pi-native/readiness/.env` and the watch build's gitignored `Secrets.mc`. Never in git.

Test: `npm test` · Deploy: `npx wrangler deploy`
Spec: `/Users/nugui/CLAUDE/Garmin/docs/superpowers/specs/2026-10-03-readiness-planner-design.md`
