# Readiness Planner — Pi job

Builds the FR570 watch payload every 15 min. It reads Garmin readiness and the
Garmin Coach plan, plus AP127 flights from this repo's data, runs the R1–R7
rules, relays Apply requests (dry-run until signed off) and publishes to the
`ap127-readiness` Worker.

- Run once: `.venv/bin/python -m readiness --print`
- Sign in (owner types the password): `.venv/bin/python -m readiness login`
- Tests (Mac): `python3 -m pytest tests -q`
- Thresholds: `rules.json`. Owner settings: `settings.json` (gitignored, from `settings.example.json`)
- Secret: `.env` holds `READINESS_PI_KEY` (gitignored)
- Units: `ap127-readiness.service` / `.timer` (Nice 10, MemoryMax 150M)

Spec: `/Users/nugui/CLAUDE/Garmin/docs/superpowers/specs/2026-10-03-readiness-planner-design.md`
