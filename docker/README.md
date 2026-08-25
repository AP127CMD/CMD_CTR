# AP127 fetch pipeline — Orange Pi 4 Pro deployment

**Status as of 2026-08-25: written, not yet deployed.** The Pi hasn't
arrived yet (expected 2026-08-26). This is the setup to run once it has.

## Why this exists

The Ops Portal now requires Google sign-in (org policy: "Anyone with Google
account", not fully public), and Google's own bot-detection blocks a
Playwright-launched Chromium from ever completing that sign-in — confirmed
2026-08-25, no timeout or retry count fixes it (tested up to 300s). GitHub
Actions can never pass this. A plain, unflagged, persistently-signed-in real
Chromium instance doesn't have the problem — this runs one 24/7 on your own
hardware and points the existing `scripts/fetch_schedule.py` at it over CDP
(`FETCH_CDP_ENDPOINT`), which is the exact code path proven working manually
that day. Full incident writeup: `CLAUDE.md`'s 2026-08-25 entries and
`AP127_Docs` README §10.

This does **not** replace `.github/workflows/fetch_schedule.yml` — that
keeps running on its own schedule as a fallback (harmless: its
portal-outage backoff means it mostly just logs "skip=true" once this Pi is
doing the real work). Consider slowing/disabling the CF dispatcher once
this has proven reliable for a while — not done yet, deliberately.

## One-time setup

1. **Get the Pi on your network and SSH-reachable.** (Separate runbook —
   see `/Users/nugui/CLAUDE/HomeServer/RUNBOOK.md`.)

2. **Install Docker** on the Pi if not already done (part of the same
   runbook).

3. **Clone this repo onto the Pi** (anywhere — e.g. `~/flight-schedule-feed`):
   ```bash
   git clone https://github.com/AP127CMD/CMD_CTR ~/flight-schedule-feed
   cd ~/flight-schedule-feed/docker
   ```

4. **Create the PAT** per `.env.example`'s instructions, then:
   ```bash
   cp .env.example .env
   chmod 600 .env
   # edit .env, paste the real token after GH_PAT=
   ```

5. **Bring both containers up:**
   ```bash
   docker compose up -d
   ```
   `fetch` will exit/restart-loop with `FATAL: GH_PAT is not set` if step 4
   was skipped — check `docker compose logs fetch` if it's not settling.

6. **Sign into Google — the one human step, do this within a few minutes
   of step 5** (the `chromium` container is already loading the portal
   URL and sitting on the sign-in screen):
   - Open `http://<pi-ip>:3000` in any browser.
   - Sign in with the Google account that has portal access. You're
     signing into a real, unmodified Chromium instance — Google has no
     reason to flag it, and nothing about this step is different from
     signing into Chrome normally.
   - Once you land on the actual "Flight Student Portal" page (may take
     20–30s to render after sign-in — it's just a slow app, not stuck),
     you're done. Leave that browser tab; you don't need to keep it open
     locally, the session lives in the container.

7. **Verify:**
   ```bash
   docker compose logs -f fetch
   ```
   Should show a fetch attempt within `FETCH_INTERVAL_SECONDS` (default
   300s) completing with `Saved →` and, if there was new data, `Pushed on
   attempt N` + `CMDV2 refresh-data.yml dispatched`.

## Ongoing operation

- **Logs:** `docker compose logs -f fetch` (the loop's own output) and
  `docker compose logs -f chromium` (rarely needed — mostly Selkies/Xvfb
  startup noise).
- **Restart everything:** `docker compose restart` — the signed-in session
  persists (`./chromium-config` volume), no re-login needed for a normal
  restart.
- **Update the fetch code:** the `fetch` container mounts `./repo` and runs
  `git pull --rebase` at the start of every cycle automatically — pushing
  to `main` (from anywhere, including your Mac) is enough, no redeploy
  needed. Only rebuild the image (`docker compose build fetch`) if
  `docker/fetch-cron/Dockerfile` itself changes (new Python deps, etc.).

## Session expired

Google sessions don't last forever. If `docker compose logs fetch` shows
repeated `RuntimeError('userHtmlFrame never appeared')` (the same signature
as the 2026-08-25 incident) after this has been running fine for a while,
the session likely expired. Fix: repeat step 6 above — open
`http://<pi-ip>:3000`, sign in again. Nothing else needs touching; the next
cycle will just start working again.

## Security notes

- `docker/.env` (the PAT) and `docker/chromium-config/` (the signed-in
  session) are both gitignored — **never** commit either. If you ever
  `git status` inside `docker/` and see either as untracked-but-about-to-be-
  added, stop and check `.gitignore` before proceeding.
- Chrome's CDP port (9222) is never published to the host or the internet —
  only exposed on the internal `ap127net` docker network, reachable solely
  by the `fetch` container. Only port 3000 (the login GUI) is published, and
  only for the one-time/occasional re-login step — consider firewalling it
  to your LAN only if the Pi is ever exposed beyond your home network.
