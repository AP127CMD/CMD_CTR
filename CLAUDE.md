# AP127 Command Center — Project Reference

> **Keep this file updated** after every significant change.  
> GitHub repo: `https://github.com/nuguitar/AP127_Command_Center`  
> Live URL: `https://nuguitar.github.io/AP127_Command_Center/`

---

## Project Purpose

A real-time flight-schedule dashboard for a flight training academy.  
Highlights batch **AP-127** (the "focus" cohort) across five views:  
Board · Gantt · Weekly · Analytics · Roster.

Data is scraped every 30 minutes via GitHub Actions → committed to the repo → deployed to GitHub Pages automatically.

---

## Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | React 18 (CDN UMD) | No build step; loaded via `unpkg.com` |
| Transpiler | Babel Standalone 7.29 | `<script type="text/babel">` in-browser |
| Fonts | Inter + JetBrains Mono | Google Fonts |
| Scraper | Playwright (Python 3.11) | Headless Chromium |
| CI/CD | GitHub Actions | Cron every 30 min, deploys Pages |
| Hosting | GitHub Pages | Serves repo root as static site |

---

## File Structure

```
/
├── index.html                  # Shell: App component, Sidebar, MobileTopBar, VIEWS array
├── flight-data.js              # AUTO-GENERATED — do not edit (run generate_flight_data.py)
├── requirements.txt            # playwright>=1.50.0
├── .github/workflows/
│   └── fetch_schedule.yml     # cron every 30 min — fetch + deploy
├── data/
│   ├── flight_schedule.json        # Merged source of truth (all historical dates)
│   └── flight_schedule.backup.json # Rolling pre-write backup (gitignored)
├── scripts/
│   ├── fetch_schedule.py      # Playwright scraper → merges into flight_schedule.json
│   ├── generate_flight_data.py # Transforms JSON → flight-data.js
│   └── rebuild_history.py     # One-time utility: reconstruct full history from git commits
└── js/
    ├── app-shared.js          # Context, helpers, shared components
    ├── view-daily.js          # DAY GLANCE view — single-day comprehensive dashboard
    ├── view-board.js          # BOARD view — sortable ops table
    ├── view-gantt.js          # GANTT view — timeline bars
    ├── view-weekly.js         # WEEKLY view — date columns with cards
    ├── view-summary.js        # ANALYTICS view — stats, pie chart, breakdowns
    └── view-roster.js         # ROSTER view — instructor × date heat-map
```

> `js/view-mobile.js` exists but is **unused** (replaced by responsive layout in Round 5+).

---

## Architecture Patterns

### No-build React
- All scripts loaded via CDN `<script>` tags in `index.html`
- View files use `type="text/babel"` and export via `window.*`
- `index.html` inline `<script type="text/babel" data-presets="env,react">` boots the app
- Load order matters: `app-shared.js` → all views → `index.html` inline script

### Global exports pattern
Every view/shared file attaches its components to `window`:
```js
// app-shared.js
Object.assign(window, { AppCtx, AppProvider, useApp, ThemeStyle, ... });

// view-board.js
window.OpsBoard = OpsBoard;
```

### `useMemo` aliasing per file (avoid name collisions)
```js
const { useMemo: useM_b } = React;   // view-board.js
const { useMemo: useM_g } = React;   // view-gantt.js
const { useMemo: useM_w } = React;   // view-weekly.js
const { useMemo: useM_s, useState: useS_s } = React;  // view-summary.js
const { useMemo: useM_r, useState: useS_r } = React;  // view-roster.js
```

### AppContext (app-shared.js)
Central state provided by `<AppProvider>` in `index.html`:

| Key | Type | Description |
|-----|------|-------------|
| `date` | string | Selected date (YYYY-MM-DD) |
| `setDate` | fn | Change selected date |
| `filters` | object | `{ batches, instructors, tails, statuses, search }` — each key is `null` (all shown) or `string[]` (subset) |
| `setFilters` | fn | |
| `drawer` | string\|null | Flight ID shown in slide-over Drawer |
| `setDrawer` | fn | |
| `highlightAP127` | bool | AP-127 focus mode |
| `setHighlightAP127` | fn | |
| `hideOthers` | bool | Show only AP-127 flights |
| `setHideOthers` | fn | |
| `tweaks` | object | `{ theme, showSim, showStandby, groupBy }` |
| `setTweak` | fn | `setTweak(key, value\|updaterFn)` |
| `dayFlights` | array | Flights for selected date, filtered |
| `flightById` | fn | `id => Flight\|undefined` |
| `isMobile` | bool | True if phone/small viewport |

### Mobile detection
```js
// In App component (index.html)
const isMobile = windowW < 768 || (windowW < 1100 && windowH < 560);
```
Handles both portrait AND landscape phones (landscape width > 768 but height < 560).

---

## Data Pipeline

```
GitHub Actions (cron */30 * * * *)
  └─ fetch_schedule.py (up to 3 retries, 20/40 s backoff)
       └─ validate_raw_cache()        ← hard-fail on schema break; data not saved if errors
       └─ normalize_entry() × N       ← sentinel cleanup, derived booleans, durationMin
       └─ MERGE with existing flight_schedule.json
            ├─ dates in fresh fetch   → overwrite stored version (newest status wins)
            └─ dates outside window   → kept as-is (historical preservation)
       └─ backup → data/flight_schedule.backup.json (gitignored)
       └─ write data/flight_schedule.json
  └─ generate_flight_data.py
       └─ transform()                 ← renames fields, strips actuals from non-Completed
       └─ write flight-data.js        ← window.FLIGHT_DATA consumed by React dashboard
  └─ git commit & push (git pull --rebase before push to handle concurrent runs)
  └─ GitHub Pages deploy
  └─ on failure → open GitHub Issue (label: fetch-failure) so stale data is noticed
```

**Playwright browser is cached** between runs (`actions/cache` keyed on `requirements.txt` hash) — avoids ~300 MB download every 30 min. On cache hit only OS deps are installed.

### Stage 1 — `data/flight_schedule.json`

Intermediate source-of-truth. Written by `fetch_schedule.py`; read by `generate_flight_data.py`. Do not edit manually.

```json
{
  "fetched_at": "2026-05-12T18:50:57Z",
  "timezone":   "Asia/Bangkok",
  "schedules":  { "2026-05-12": [ {…} ], … },
  "instructors": […],
  "resources":  […],
  "leaves":     […]
}
```

Every schedule entry has exactly these fields:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | String form of `rowIdx`; `ACTUAL_ONLY_<n>` for unplanned flights |
| `date` | `string` | `YYYY-MM-DD` — duplicated inside entry for flat-list querying |
| `rowIdx` | `number\|string` | `number` for scheduled entries; `string` (`ACTUAL_ONLY_<n>`) for unplanned flights |
| `status` | `string` | `"Pending"` · `"Completed"` · `"Canceled"` |
| `isActual` | `boolean` | `true` when post-flight actuals are recorded |
| `isSimulator` | `boolean` | `true` when `type` contains `"(SIM)"` |
| `isStandby` | `boolean` | `true` when source condition contained `"(Standby)"` — suffix stripped from `condition` |
| `start` | `string` | Scheduled start `HH:MM` (Asia/Bangkok) |
| `end` | `string` | Scheduled end `HH:MM` (Asia/Bangkok) |
| `duration` | `string\|null` | Display string `"H…:MM"`. `null` if absent |
| `durationMin` | `number\|null` | Total minutes (e.g. `180`). `null` if duration absent |
| `student` | `string\|null` | `null` when source was `"-"` |
| `instructor` | `string\|null` | `null` when source was `"-"` |
| `batch` | `string` | e.g. `"AP-127"` |
| `lesson` | `string` | Lesson code or label |
| `condition` | `string\|null` | Flight condition after `"(Standby)"` stripping. `null` if empty |
| `type` | `string\|null` | Aircraft type. `null` if absent |
| `tail` | `string\|null` | Registration e.g. `"HS-TPW"`. `null` if unassigned |
| `actualType` | `string\|null` | `"Dual"` · `"Solo"` · `"SPIC"`. `null` if not flown |
| `tkoff` | `string\|null` | Actual take-off `HH:MM`. `null` if not flown |
| `ldgTime` | `string\|null` | Actual landing `HH:MM`. `null` if not flown |
| `airborne` | `string\|null` | Actual airborne `"H…:MM"`. `null` if not flown |
| `ldg` | `number` | Landing count (0 if not flown) |
| `to` | `number` | Take-off count (0 if not flown) |
| `inst` | `number` | Instrument approaches (0 if not flown) |

**Normalization rules** (`fetch_schedule.py → normalize_entry`):

| Raw source value | Normalized to |
|---|---|
| `"-"` in any string field | `null` |
| `""` in `actualType`, `condition`, `type` | `null` |
| `rowIdx` numeric string `"3105"` | `number` `3105` |
| `rowIdx` `"ACTUAL_ONLY_*"` | kept as `string` |
| `condition` ending `" (Standby)"` | suffix stripped; `isStandby: true` |
| `type` containing `"(SIM)"` | `isSimulator: true` |
| Unknown `status` | defaulted to `"Pending"` |

**Upstream schema validation** (`validate_raw_cache`) — runs before normalization:

| Severity | Check |
|---|---|
| **Hard error** (data not saved) | Missing top-level keys; missing required entry fields; `isActual` not bool; `ldg`/`to`/`inst` not int; malformed `duration` or `start`/`end` format |
| **Warning** (logged to stderr) | New top-level or entry fields; unknown `status` values; unexpected `rowIdx` format |

**Known source quirks:**

| Quirk | Explanation |
|---|---|
| `rowIdx = "ACTUAL_ONLY_<n>"` | Unplanned flights logged post-hoc; no scheduled slot. Multiple entries can share the same token. |
| `tail = null` | Aircraft not yet assigned (standby entries, classroom slots) |
| `student = null` | Meetings or slots without a named student |
| Duplicate `ACTUAL_ONLY_` ids | Source limitation; unfixable without upstream changes |

---

### Stage 2 — `flight-data.js`

Auto-generated by `generate_flight_data.py`. Exposes `window.FLIGHT_DATA`. **Do not edit directly.**

```js
window.FLIGHT_DATA = {
  fetchedAt:   "2026-05-12T18:50:57Z",
  tz:          "Asia/Bangkok",
  flights:     [ … ],   // flat array across all dates
  instructors: [ … ],
  resources:   [ … ],
  leaves:      [ … ]
}
```

Field mapping from `flight_schedule.json` → `flight-data.js`:

| `flight-data.js` | `flight_schedule.json` | Notes |
|---|---|---|
| `id` | `id` / `rowIdx` | `isActual` entries without `ACTUAL_ONLY_` prefix get it added |
| `date` | `date` | |
| `status` | `status` | |
| `isSim` | `isSimulator` | renamed |
| `isStandby` | `isStandby` | |
| `start` | `start` | |
| `end` | `end` | |
| `durMin` | `durationMin` | renamed; recalculated from `duration` if absent |
| `duration` | `duration` | |
| `student` | `student` | |
| `instructor` | `instructor` | |
| `batch` | `batch` | |
| `lesson` | `lesson` | |
| `cond` | `condition` | renamed |
| `type` | `type` | |
| `tail` | `tail` | |
| `tkoff`, `ldgTime`, `airborne`, `to`, `ldg`, `inst` | same | **Completed flights only**; omitted if null |

### Key constants (app-shared.js)
```js
const FLIGHTS         = window.FLIGHT_DATA.flights;
const HIGHLIGHT_BATCH = 'AP-127';
const ALL_DATES       = [...];   // every calendar day between first and last flight
const DEFAULT_DATE    = ...;     // today if in range, else nearest future date
```

---

## Themes

Three themes via CSS custom properties on `body[data-theme="..."]`:

| Token | Cockpit (dark) | Light | Warm (dark amber) |
|-------|----------------|-------|-------------------|
| `--bg` | near-black | near-white | jet black |
| `--col-pending` | amber | dark amber | bright amber |
| `--col-done` | green | dark green | bright green |
| `--col-cancel` | red-orange | dark red | bright red |
| `--col-sim` | purple/indigo | dark purple | bright purple |
| `--col-stby` | blue | dark blue | bright blue |
| `--highlight` | magenta (AP-127) | dark magenta | bright magenta |

**Batch color system** — shared CSS variables used across all views and all three themes:

| Variable | Color | Batch |
|----------|-------|-------|
| `--batch-ap124` | Blue `oklch(0.70 0.15 250)` | AP-124 |
| `--batch-ap126` | Green `oklch(0.78 0.14 145)` | AP-126 |
| `--batch-ap127` | Magenta `oklch(0.78 0.20 316)` | AP-127 (= `--highlight`) |
| `--batch-ap128` | Orange `oklch(0.76 0.15 50)` | AP-128 |
| `--batch-ap129` | Mustard `oklch(0.82 0.12 84)` | AP-129 |

Color space: `oklch()` + `color-mix(in oklch, ...)` throughout.

---

## Views

### 0 — DAY GLANCE (`view-daily.js`)
Comprehensive single-day dashboard — the default landing view. Summarizes every
aspect of one date (defaults to today via `localToday()`, changeable via calendar popup).
- **Top bar**: always shows "AP127 COMMAND CENTER" title + "DAY AT A GLANCE" sub-label + `RefreshButton`
- **Date hero**: compact `DateCalendarTrigger` button ("WED 20 MAY ▾") opens floating calendar; TODAY badge shown when viewing today
- **Hero KPI strip**: TOTAL · COMPLETED (+rate) · PENDING (+standby) · CANCELED · HOURS (flown/planned) · SIM · A/C USED · INSTR · ◆ AP-127
- **Schedule Pulse** (SVG, 06–18): Catmull-Rom smooth curves; filled area per batch using `--batch-ap*` colors; fluorescent-green total line `oklch(0.88 0.30 130)`; grey horizontal axis; tight padding — chart fills full container width; every-hour labels (6, 7, … 18) with edge labels left/right-aligned. Includes AP-124/126/127/128/129.
- **Batch Breakdown** (side-by-side with Pulse): bar chart grouped into **AP / HP / OTHER** sections; each bar colored with `--batch-ap*`; shows flight count + hours
- **Status Mix**: SVG donut + legend — mutually-exclusive buckets (standby → completed → canceled → pending); **SIM excluded**
- **Instructor Load**: bars represent **hours** (not flight count); bar fill color = % of 8-hour workday (green ≥100% · amber ≥75% · red ≥50% · grey <50%); sorted by hours descending; shows `Xh` + `%` on the right
- **Aircraft Fleet**: grouped by type with **DA40TDI first, DA40CS second**; each type gets a distinct palette color; shows flight count + hours
- **◆ AP-127 SPOTLIGHT** (full-width, magenta accent): AP-127 KPIs, today's AP-127 flight roster (click row → Drawer), and lesson chips. "VS SCHOOL" comparison section removed.
- Self-contained: inlines its own `DailyDonut`, `DKPI`, `Section`, `StackBar` components; no `FocusControls`

### A — BOARD (`view-board.js`)
Sortable table of all flights for selected date.
- Columns: STATUS · BATCH · STUDENT · INSTRUCTOR · LESSON · START · DUR · END · A/C · TAIL
- Stat hero tiles: TOTAL · PENDING · COMPLETED · CANCELED · AP-127 · STANDBY · SIM
- `DateCalendarTrigger` + `FilterBar` above table
- FocusControls (◆ AP-127 + **ONLY**) + `RefreshButton` in header top-right

### B — GANTT (`view-gantt.js`)
Timeline bars for selected date, grouped by INSTRUCTOR / TAIL / BATCH.
- `FOCUS` label (renamed from "GROUP") with chip toggle
- Default group: **instructor**
- Time ruler: 06:00 – 18:00. Both desktop and mobile show plain hour numbers (`6`, `9`, `12`…); mobile labels every 3rd hour only to avoid overlap.
- **Single scroll viewport** (`overflow:auto`, both axes): the hour ruler is `position:sticky top:0` and the label column is `position:sticky left:0` (mobile only — desktop keeps the transparent row background). On mobile the inner content has `min-width:720` so the timeline isn't cramped — swipe sideways to reach all hours.
- Track widths responsive: 190/180px desktop → 90/64px mobile
- Right column: DUTY PERIOD (instructor) or FLT HRS (tail/batch)
- Rows sorted **purely alphabetically** for all groupBy modes (TAIL still secondarily by aircraft type then alpha)
- Clicking a bar opens Drawer

### C — WEEKLY (`view-weekly.js`)
Dates grouped into Mon-Sun calendar weeks; one week shown at a time with prev/next nav.
- Week navigation bar: `‹ PREV` · week label (`DD – DD MMM YYYY`) · `NEXT ›` · WK N/total
- Current week's dates shown as equal-width grid columns (CSS grid `repeat(N, 1fr)`)
- Each column header shows date + P/C/X/S counts + TODAY/PAST badge
- Cards show time · batch · student · tail
- `buildWeeks(dates)` helper groups ALL_DATES by Mon boundary
- Defaults to the week containing today (or nearest future week)

### D — ANALYTICS (`view-summary.js`)
Aggregate stats with date-range filter (default: last 7 days → today).
- **SumTiles**: TOTAL · PENDING · COMPLETED · CANCELED · STANDBY · SIM
- **AP BATCH COMPARISON**: SVG donut chart, AP-xxx batches only
  - AP-127 always gets `var(--highlight)` (magenta); other batches use `BATCH_COLORS[]`
  - `BATCH_COLORS`: blue · green · amber · red-orange · teal · purple · mint
- **◆ AP-127 STUDENTS**: All cohort members seeded from full `FLIGHTS` (0-hr students appear); sorted by barMode metric. Anonymous `"—"` entries excluded.
- **Bar mode toggle**: `# FLIGHTS` | `HOURS` chips — **HOURS is the default**; controls sort order + bar widths for all breakdowns
  - Bar container width ∝ selected metric; inner coloured segments flex-proportional to status flight counts
- **BATCH BREAKDOWN** / **INSTRUCTOR BREAKDOWN** / **STUDENT BREAKDOWN**: each row shows **Completed ✓ / Canceled ✗** count in green/red + hours on the right side; sorted by active metric

### E — ROSTER (`view-roster.js`)
**PM tool** — workload heat-map.
- Rows: instructors, batches, **or students** (toggle VIEW chip: INSTRUCTOR · BATCH · STUDENT)
- **◆ AP-127 ONLY** filter chip — shows only AP-127 rows and date totals
- Columns: ALL_DATES
- Cell color = load: green (1 flt) · amber (2–3) · red (4+)
- ◆ badge on cells with AP-127 flights
- DAILY TOTAL footer row (respects AP-127 only filter)
- Respects `highlightAP127` / `hideOthers` (opacity dimming)
- Sticky first column + sticky header row
- **Click cell → inline detail overlay** listing all flights for that row × date
  - Each flight shows time, student/instructor, lesson, tail, STBY badge
  - Tap flight in overlay → sets date + opens global Drawer
  - Click backdrop or ✕ to dismiss

### F — SLOT FINDER (`view-slotfinder.js`)
Manual slot finder — pick date, duration, buffer, type, FI subset, SP subset, time window, RWY-close window → list every open slot.
- FI multi-checkbox + SP multi-checkbox (hard-coded AP-127 SP names)
- Buffer pads every flight on both sides (correct "minimum gap to neighbours" semantics)
- Slot card shows FI × A/C qualified pairs grouped by FI, plus free SPs when SP filter applied
- Resource timeline (FIs + tails) at top shows scheduled flights, search-window tint, RWY-close tint, available-slot highlights

### G — AUTO SLOT FINDER (`view-autoslotfinder.js`)
Auto-ranks AP-127 students by progress (most-behind first) and proposes the best open slot per student.
- **Rank source**: fetches `cache.json` from `nuguitar.github.io/AP127_NGT_001/` on mount (with raw GitHub fallback); cached in `localStorage` for 6h; manual **⟳ SYNC SP INFO** button (blue)
- **Sort modes**: `MOST BEHIND` (default, sort by `done` ASC), `LONGEST IDLE`, `LEADER FIRST`
- **Rank classes**: rank ≤ 3 = bad (red) · top 40% = mid (amber) · rest = ok (green)
- **Name mapping**: `asfShortName("Akaravit Khwanngam")` → `"Akaravit K."` — joins with flight `student` field
- **FI/SE defaults**: `asfGetOverride` reads `student.fi` + `student.se` from NGT cache → maps to full FI name + normalised acType; falls back to last flight then "Any"
- **Per-student slot search**: per-SP `asfBuildBusyMap` with that SP's own buffer; cascading reservation via `augmentedFlights` (activated virtual flights block other SPs)
- **Student card**: rank pill + name + nick + next lesson + idle days; expandable → mini-timeline + slot cards; summary row is a `<div>` (not button) to avoid button-in-button nesting
- **Per-SP filter row** (always visible): FI / SE TYPE / DURATION / BUFFER dropdowns
- **`AsfSlotBtn`**: slot card with time, combos, RESERVE ▲ (opens `AsfAcPickerModal`) / RELEASE ▼; A/C tail chips directly reserve that FI+tail on click; hover synced with timeline + mini-timeline
- **`AsfTimePicker`**: button + `position:fixed` popup (hour select 06–18, minute select 0/15/30/45, ✓ confirm); height 28px matches other filter buttons
- **TYPE / FI FILTER**: `AsfMultiCheck` (exact port of `SfMultiCheck` from Slot Finder) — `position:absolute` panel, backdrop div, `string[]` state (empty = all); checkbox-style dropdown; **ALL mode renders all boxes checked** — unchecking one item in ALL mode produces "all except that item" (not just that one); checking the last remaining de-selected item normalizes back to `[]` (ALL)
- **Main timeline** (`AsfTimeline`): FI tab + A/C tab; grey = scheduled, green = available (click → `AsfTimelineSlotModal`), highlight = reserved (click → `AsfTimelineReleaseModal`); hover synced
- **Modals**: `AsfAcPickerModal` (pick FI+tail) · `AsfTimelineSlotModal` (available slot detail + reserve) · `AsfTimelineReleaseModal` (release reserved) · `AsfProposeModal` (dispatcher text + copy)
- **Date change**: releases all reservations and recalculates
- **`dynHourEnd`**: timeline end hour = `max(18, ceil(last_flight_end_min / 60))` for the day; passed to `AsfTimeline` and `AsfMiniTimeline` as `hourEnd` prop
- **Persistence**: `ASF_SETTINGS_LS_KEY` saves filters/toggles/window/sort/topN to `localStorage`; survives reload. Reservations and per-SP overrides are date-scoped and intentionally NOT persisted. `↺ RESET` button restores `ASF_DEFAULTS`.
- **Bulk operations**: `⚡ AUTO RESERVE` (when zero reservations) picks the earliest matched slot for every ranked SP, cascading through a local augmented flight list. `📋 EXPORT ALL` (when ≥1 reservation) copies a dispatcher-ready proposal text to clipboard.
- **Cascade feedback**: `baselineSlotsByStudent` recomputes slots without reservations; each SP card shows an amber `−N BLOCKED` chip (reduced) or red `BLOCKED BY OTHERS` chip (eliminated) when other reservations consumed their options. Suppressed for SPs that have their own reservation.
- **Controls**: DATE · TYPE · SHOW (top N) · FI FILTER · FROM/TO · RWY CLOSE · ⚡ AUTO RESERVE / 📋 EXPORT ALL · RELEASE ALL · WITH SLOTS ONLY · **SP-FI MATCHED** (toggle, default ON) · EXPAND ALL · COLLAPSE · ↺ RESET
- Reuses `SF_AP127_FI_QUALS` / `SF_AP127_FI_NAMES` from `view-slotfinder.js` (must be loaded first)

---

## Shared Components (app-shared.js)

| Component | Description |
|-----------|-------------|
| `ThemeStyle` | Injects CSS custom-property theme rules |
| `ArtboardShell` | Wrapper div: `position:relative; width/height:100%` |
| `DateCalendarTrigger` | Compact button showing current date ("WED 20 MAY ▾"); click opens `DateCalendarPopup` |
| `DateCalendarPopup` | Floating month-grid calendar; only `ALL_DATES` dates are selectable; prev/next month nav; today + selected date highlighted |
| `RefreshButton` | "⟳ SYNC" button in every view header; calls `window.location.reload(true)` to bypass browser cache |
| `FilterBar` | Collapsible checkbox-style filter panel — SEARCH input + FILTERS toggle button; sections: BATCH · STATUS · AIRCRAFT (grouped by type, DA40TDI first) · INSTRUCTOR; each item has checkbox + ONLY button; items sorted alphabetically; active-count badge; CLEAR ALL button |
| `FocusControls` | Compact `◆ AP-127` + `ONLY` chips — used in every view header (top-right). `ONLY` shows exclusively AP-127 flights. |
| `LastUpdate` | Data-freshness chip (`● UPDATED DD MON HH:MM` in Bangkok time) — in every view header; self-hides on mobile unless `showOnMobile` (MobileTopBar passes that). Replaced the old sidebar-footer block. |
| `ViewIcon` | SVG icon per view id: `daily` · `board` · `gantt` · `weekly` · `summary` · `roster` |
| `Drawer` | Slide-over flight detail panel (right side, 380px wide) |
| `StatusPill` | Colored rounded status badge |
| `StandbyTag` | Dashed STBY badge |
| `FlightDot` | 7px colored square dot |
| `ConditionTag` | Small condition text pill |
| `Tag` | Generic text badge |
| `HighlightBar` | Left-edge highlight stripe for AP-127 rows |
| `InlineSettings` | Legacy settings bar — exported but no longer used in any view |

### Drawer — Completed flight rows
For `status === 'Completed'`, shows two additional rows:
- **ACTUAL TIMES**: `tkoff` (T/O time) · `ldgTime` (LDG time) · `airborne` (duration)
- **T/O · LDG · INST**: `to` count · `ldg` count · `inst` count

### Helper functions
```js
localToday()       // "YYYY-MM-DD" in local (Bangkok) time — use this, never new Date().toISOString().slice(0,10)
minutesOf(hhmm)    // "06:30" → 390
fmtDay(dateStr)    // "2026-05-12" → { wd:"MON", mo:"MAY", day:12, y:2026 }
fmtHM(hhmm)        // identity or "—"
isPast(dateStr)    // bool (uses localToday())
isToday(dateStr)   // bool (uses localToday())
STATUS_COLOR(f)    // returns CSS var string
flightAlpha(f, hlOn) // 0.22 if dimmed, 1.0 otherwise
```

---

## Layout (index.html App component)

```
<AppProvider>
  <ThemeStyle/>
  <div flex row height:100%>

    [DESKTOP only]
    <Sidebar width=sidebarW/>          ← persistent, drag-resizable 180–360px
    <ResizeHandle 5px cursor:ew-resize/>

    [MOBILE only, when sidebarOpen]
    <Backdrop/>
    <Sidebar mobile onClose/>          ← fixed overlay, 256px wide

    <main flex:1 column>
      [MOBILE only] <MobileTopBar/>    ← hamburger + wordmark + current view icon/label
      <ViewContainer flex:1>
        {view === 'daily'   → <DailyBoard/>}
        {view === 'board'   → <OpsBoard/>}
        {view === 'gantt'   → <GanttBoard/>}
        {view === 'weekly'  → <WeeklyBoard/>}
        {view === 'summary' → <SummaryBoard/>}
        {view === 'roster'  → <RosterBoard/>}
      </ViewContainer>
    </main>

  </div>
</AppProvider>
```

### Sidebar sections (both desktop and mobile overlay)
1. Wordmark: green pulse dot · "AP127 COMMAND CENTER" · ✕ (mobile only)
2. Nav: view buttons with `ViewIcon` + label (active item shows a description line)
3. Settings: THEME chips (COCKPIT · LIGHT · WARM)
4. Flex spacer

> **AP-127 FOCUS** and **HIDE OTHERS** were moved OUT of the sidebar into each view's header (`FocusControls` component).  
> **SIM** and **STBY** toggle chips were removed entirely.  
> The **last-update** block was moved out of the sidebar footer into each view header via the shared `LastUpdate` component (on mobile it lives in `MobileTopBar` instead).

---

## Styling Conventions

```css
.mono  { font-family: 'JetBrains Mono', monospace; }
.num   { font-variant-numeric: tabular-nums; }
.uc    { text-transform: uppercase; letter-spacing: 0.06em; }
```

Scrollable flex-column pattern (prevents height-collapse bug):
```jsx
{/* Outer: scroll container */}
<div style={{ flex:1, minHeight:0, overflowY:'auto' }}>
  {/* Inner: content layout */}
  <div style={{ display:'flex', flexDirection:'column', gap:16, padding:'10px' }}>
    {/* ... content ... */}
  </div>
</div>
```

---

## Local Development

```bash
# Start local server (from project root)
python3 -m http.server 7420
# Open http://localhost:7420/

# Refresh data from live source
python3 scripts/fetch_schedule.py
python3 scripts/generate_flight_data.py

# Or use Claude Code preview (launch.json already configured at .claude/launch.json)
```

The `.claude/launch.json` runs `python3 -m http.server 7420` from the project root.

---

## Data Refresh Flow

```
GitHub Actions (cron */30 * * * *)
  └─ fetch_schedule.py (3 attempts, 20/40 s backoff)
       └─ fetch fresh window (~10 days) from source
       └─ merge into data/flight_schedule.json (history preserved)
       └─ backup → data/flight_schedule.backup.json
  └─ generate_flight_data.py    → flight-data.js
  └─ git pull --rebase && git commit & push
  └─ GitHub Pages deploy
  └─ on failure → GitHub Issue opened (label: fetch-failure)
```

When pushing local changes that conflict with a data commit:
```bash
git pull --rebase origin main
# If conflict on flight-data.js or flight_schedule.json:
git checkout --theirs data/flight_schedule.json flight-data.js
python3 scripts/rebuild_history.py --apply   # re-merge from full git history
python3 scripts/generate_flight_data.py
git add data/flight_schedule.json flight-data.js
GIT_EDITOR=true git rebase --continue
git push origin main
```

To rebuild the full historical dataset from scratch (e.g. after restoring from backup):
```bash
python3 scripts/rebuild_history.py           # dry-run — prints what would be written
python3 scripts/rebuild_history.py --apply   # writes data/flight_schedule.json
python3 scripts/generate_flight_data.py
```

**Cache strategy — three layers:**

| Resource | Mechanism |
|---|---|
| `index.html` | `no-cache, no-store, must-revalidate` meta tags → browser always revalidates with server on every load/refresh; GitHub Pages returns 304 if unchanged (no download) |
| `js/*.js` | `?v=rXX` token in `index.html` script tags — **bump whenever a `js/` file changes** |
| `flight-data.js` | `?v=<unix-timestamp>` written by `generate_flight_data.py` — changes automatically with every data fetch |

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| No build step (CDN React + Babel) | Zero toolchain setup; pure static files; GitHub Pages compatible |
| `window.*` exports | Only way for multiple `text/babel` scripts to share components |
| `useMemo` aliasing per file | Avoids `useMemo` redeclaration conflicts across script tags |
| `oklch()` color space | Better perceptual uniformity for status colors; `color-mix(in oklch, ...)` for tints |
| AP-127 always uses `var(--highlight)` | Never shares palette index with other batches — ensured by separate `colorIdx` counter |
| Shared `--batch-ap*` CSS vars | All batch colors defined once in `ThemeStyle` and consumed by every view — single source of truth |
| Fetch merges rather than overwrites | Source only provides a rolling ~10-day window; merging preserves all historical dates in `flight_schedule.json` |
| `rebuild_history.py` | One-time and recovery tool — replays all git commits to reconstruct the fullest possible dataset |
| Playwright browser cached in CI | `actions/cache` keyed on `requirements.txt` — avoids a ~200 MB CDN download every 30-min run; always run `install --with-deps` so binary + OS deps are both present regardless of cache state |
| `no-cache` meta tags on `index.html` | GitHub Pages can't set custom HTTP headers; meta-equivalent directives tell browsers to revalidate `index.html` on every refresh so users always get the latest `?v=` tokens for JS/data files |
| Flex scroll anti-pattern fix | `flex:1, minHeight:0, overflowY:auto` on outer + non-flex inner prevents children shrinking instead of scrolling |
| isMobile uses both width AND height | Catches landscape phones (width > 768 but height < 560) |
| ROSTER view as PM tool | Only view showing cross-day utilization at a glance — essential for scheduling |

---

## Rounds Summary

| Round | Key Changes |
|-------|-------------|
| 1–4 | Initial implementation: Board, Gantt, Weekly, Analytics views; GitHub Pages deploy; basic AP-127 highlighting |
| 5 | Analytics scroll fix; Gantt time grid 06–18; Instructor breakdown; resizable panels (vertical — later removed) |
| 6 | Replaced NavBar with persistent Sidebar; removed Mobile tab; added hamburger overlay; sidebar drag-resize; collapsible DateStrip; AP-127 FOCUS moved to sidebar; TH last-update time |
| 7 (Round 7 in session) | LDG/TO/INST in Drawer; SVG view icons; FocusControls moved to view headers; remove SIM/STBY chips from sidebar; Gantt "FOCUS" label + instructor default; Analytics donut chart + AP batch colors; mobile landscape fix; padding reduction |
| 8 | Gantt row cleanup (no FLT sub-label); ROSTER heat-map view; AP-128 color fix; 1-week default date range in Analytics; last-update two-line fix on mobile |
| 9 | Gantt TAIL sort by aircraft type then alpha; Weekly week-by-week pagination (Mon-Sun, prev/next nav); Analytics barMode toggle (# flights vs hours), AP-127 0hr student seeding, all breakdowns sorted by active metric; Roster student groupBy, ◆ AP-127 ONLY filter, cell-click inline detail overlay |
| 10 | **Bug fixes + UX polish:** `localToday()` helper replaces all `new Date().toISOString().slice(0,10)` usages (fixes Bangkok midnight off-by-one in Board, Roster, Weekly, Analytics, DateStrip); "board" theme renamed to "warm" (no longer clashes with BOARD view name); localStorage persistence for last-used theme and view; view descriptions shown under active nav label in sidebar; Board sort-column hover affordance + title tooltips; FocusControls tooltip hints |
| 11 | **New DAY GLANCE view** (`view-daily.js`): comprehensive single-day dashboard — date hero, hero KPI strip, hourly Schedule Pulse chart, Status Mix donut, Batch Breakdown, Instructor Load + Aircraft Fleet utilization, and a dedicated full-width AP-127 Spotlight (KPIs, AP-127-vs-school completion comparison, flight roster, lesson chips). Added as the first tab and the new default landing view; new `daily` ViewIcon (sun glyph). Stale-localStorage view guard added in `App`. |
| 12 | **Schedule Pulse visual refinement**: Converted from hourly bar chart (06–21) to smoothed SVG line graph covering 6–18 hours with opaque filled areas for each batch (AP-127, AP-126, AP-124, AP-129) plus a bold total line. Expanded to full width. **Batch Breakdown redesign**: Changed from stacked status bars to SVG donut chart with legend; excluded meetings from display. **Utilization simplification**: Removed percentage columns from Instructor Load and Aircraft Fleet sections. **Aircraft Fleet cleanup**: Removed "TBD" for unassigned tails. **GANTT time header**: simplified to compact "6", "9", "12" on desktop; mobile: every 3rd hour. |
| 13 | **DAY GLANCE refinements**: Schedule Pulse made more visible (distinct colors, background fill, smoother curves, half-width); Batch Breakdown reverted to bar chart matching Pulse colors; Status Mix removed SIM slice; Instructor Load: added % column vs 8-hour benchmark; **Mobile**: burger menu now toggles (was open-only); **GANTT**: mobile time labels match desktop format (plain numbers). |
| 14 | **Bug fix**: blank white page caused by accidental extra `</div>` in JSX from Round 13 edit, which mismatched the outer container and caused Babel parse failure. |
| 15 | **Batch color system** (`--batch-ap124/126/127/128/129` CSS vars added to all themes): AP124=Blue · AP126=Green · AP127=Magenta · AP128=Orange · AP129=Mustard. `--highlight` updated to magenta (316°). `--col-sim` changed to purple/indigo to avoid clash. **DAY GLANCE**: AP-128 added to Schedule Pulse; Pulse improvements (every-hour labels 6–18, tight margins, total vs axis distinct colors); Batch Breakdown grouped AP/HP/Other; Instructor Load bar color by % load; Aircraft Fleet grouped by type (DA40TDI/DA40CS first); AP-127 Spotlight "VS SCHOOL" section removed; SIM removed from Status Mix donut. **FocusControls**: "HIDE" → "ONLY". **Page title**: sidebar/mobile wordmark updated to "AP127 COMMAND CENTER" (full form, was "AP127 CMD CN"). |
| 16 | **DAY GLANCE**: Schedule Pulse total line → fluorescent green `oklch(0.88 0.30 130)`; axis line → grey; chart fills full container (side padding removed, SVG `overflow=visible`); Instructor Load bars now represent hours (not flight count), sorted by hours. Page title updated to **"AP127 COMMAND CENTER"** in both top bar and sidebar/mobile wordmark. **ANALYTICS**: default breakdown mode → HOURS; all breakdowns show Completed ✓ / Canceled ✗ counts separately; Student breakdown excludes anonymous "—" entries. |
| 17 | **Maintenance & leave badges** across all 6 views: aircraft in maintenance show red **GND** chip + red tail name; instructors/students on leave show blue **LEAVE** chip. `isTailMaint(tail)` helper (Set-based, O(1)); `leavesOnDate(date)` helper (cached `name→reason` map). Both exported from `app-shared.js` and used in Daily, Board, Gantt, Weekly, Roster. |
| 18 | **⟳ SYNC refresh button** added to all 6 view headers — calls `window.location.reload(true)` to force full reload bypassing browser cache. **Calendar date picker**: replaced horizontal `DateStrip` pills with `DateCalendarTrigger` (compact "WED 20 MAY ▾" button) + `DateCalendarPopup` (floating month grid, Mon–Sun, only scheduled dates selectable, prev/next month nav); consistent across DAY GLANCE, BOARD, GANTT. **Checkbox FilterBar**: collapsible panel with SEARCH input + per-item checkbox + ONLY button; all items alphabetically sorted; AIRCRAFT grouped by type (DA40TDI → DA40CS → OTHER); filter state migrated from singular strings (`batch:'ALL'`) to plural arrays (`batches:null` = all, `batches:string[]` = subset). **Gantt row sort**: pure alphabetical (AP-127-first priority removed). Cache token → `r18`. |
| 22 | **New AUTO SLOT FINDER view** (`view-autoslotfinder.js`): auto-pulls AP-127 student progress from `cache.json` at `nuguitar.github.io/AP127_NGT_001/` (with raw GitHub fallback, `localStorage` cache 6h, manual `⟳ SYNC RANK` button). For each ranked SP — sorted by `MOST BEHIND` (default, lessons done ASC), `LONGEST IDLE`, or `LEADER FIRST` — runs a per-SP slot sweep using the same FI×A/C qualification logic as the manual finder (reuses `SF_AP127_FI_QUALS` / `SF_AP127_FI_NAMES`). Each card shows rank pill, name+nick, done/total+pct, next lesson, idle days, plan delta, and an expandable list of open slots with FI×A/C combos. `PROPOSE ▸` opens a modal with dispatcher-ready text + COPY TO CLIPBOARD. Added as 8th tab; new `autoslotfinder` ViewIcon (lightning + magnifier). Cache token → `r22`. |
| 23 | **AUTO SLOT FINDER enhancements**: (1) Removed Δ PLAN from each SP card line. (2) Added `AsfTimeline` component — full-width timeline showing FI rows + tail rows with grey scheduled flights, green available slots (union across all ranked SPs), and highlight-colored reserved/activated slot blocks with SP name label. (3) Per-SP inline filter row (always visible): FI, SE TYPE, DURATION dropdowns pre-populated from `student.planned[next_lesson].mins` (rounded up to nearest 15 min); user can override via dropdown. (4) Each available slot is an `AsfSlotBtn` RESERVE/RELEASE button — activating a slot injects a virtual flight into the busy map so other SPs' slot searches automatically exclude that FI/tail/time (cascading reservation). RELEASE ALL button when any slot is reserved. (5) Fixed `SfResultCard` in `view-slotfinder.js` — replaced `border:` + `borderLeft:` shorthand/longhand conflict with `background: linear-gradient()` + `boxShadow: inset 0 0 0 1px`. Cache token → `r23`. |
| 24 | **AUTO SLOT FINDER round 2**: (1) **Pre-input FI + SE TYPE** — `asfGetStudentLastFlight(spKey)` scans `FLIGHTS[]` backward for the SP's most recent non-canceled flight; default FI = that instructor, default seType = that tail's `acType` from `RESOURCES`. (2) **Mini-timeline per expanded SP card** (`AsfMiniTimeline`) — compact 20px-tall slot bar inside each expanded card showing that SP's available windows (green) and reserved slot (highlight) with hour ruler, search window tint, and RWY-close tint. (3) **Rank number always shown** — rank pill always shows the number (never replaced with ★); highlight background when reserved. (4) **RESERVE/RELEASE single toggle button** — one button in `AsfSlotBtn` toggles between `RESERVE ▲` (green) and `RELEASE ▼` (red); no separate outer-div click handler. (5) **PROPOSE in card header** — PROPOSE ▸ button appears in the student card header row only when a slot is reserved; `AsfProposeModal` now accepts `activatedSlot` (not full slot) and shows one FI line + one A/C line only. (6) **Removed DURATION + BUFFER from global search strip** — both moved to per-SP filter row (FI / SE TYPE / DURATION / BUFFER); BUFFER defaults to 30 min. (7) **Per-SP gap in slot search** — `slotsByStudent` builds a fresh `asfBuildBusyMap(augmentedFlights, ovr.gap)` per SP instead of one shared busy map, so each SP's buffer is applied independently. Cache token → `r24`. |
| 25 | **AUTO SLOT FINDER round 3**: (1) **FI/SE pre-populated from NGT site** — `asfGetOverride` now reads `student.fi` (short code e.g. "W-CHAI") and `student.se` ("DA40-TDI"/"DA40-CS") from the NGT cache.json; `ASF_FI_FULL` map converts short → full name ("WUTTHICHAI L."); `asfNormSe` strips hyphen ("DA40-TDI" → "DA40TDI") to match `RESOURCES.acType`; falls back to last FLIGHTS entry then "Any". `AP127_NGT_001/update-cache.js` updated to write `fi`/`se` fields into `cache.json`. (2) **Interactive timeline hover** — `hoveredSlot: { t, end } | null` state lifted to `AutoSlotFinderBoard`; `AsfTimeline` slot blocks fire `onSlotHover` on mouseEnter/Leave (block expands vertically + brighter glow when hovered); `AsfSlotBtn` receives `isHovered`/`onHoverChange` props (card glows + slight translateX when timeline block hovered); `AsfMiniTimeline` slot blocks also participate — all three components are bidirectionally synced on the same `hoveredSlot` key. (3) **FI filter chip row** — `AsfFiFilter` component renders a "FI FILTER" section above the search strip with SELECT ALL / CLEAR buttons and one chip per available FI; chips are multi-select toggles (null = all, `Set<string>` = subset); `fiFilter` state propagated into `candidates.candFIs` filter so de-selected FIs are excluded from slot searches. Cache token → `r25`. |
| 26 | **AUTO SLOT FINDER round 4 — 10 UX changes**: (1) **Main timeline FI / A/C tabs** — `AsfTimeline` gets internal `timelineTab` state with FI and A/C tab buttons; FI tab shows instructor rows, A/C tab shows tail rows. (2) **SYNC SP INFO** — button renamed from "SYNC RANK" with blue color (`#3b82f6`). (3) **TYPE filter** — replaced chip row with `AsfMultiCheck` dropdown (checkbox style, matching SLOT FINDER `SfMultiCheck` exactly). (4) **FI FILTER** — same; replaced chip row with `AsfMultiCheck` dropdown. (5) **`AsfTimePicker` component** — FROM/TO/CLOSED FROM/CLOSED TO now use a popup hour:min picker (height 28px matches other filters); panel is `position:fixed` with `getBoundingClientRect()` positioning; selects for hours (06–18) + minutes (00/15/30/45) + ✓ confirm button; outside-mousedown closes. (6) **PROPOSE card simplifies** — removed done/total counts; card shows only next lesson name. (7) **A/C chip as reserve button** — clicking a tail chip in `AsfSlotBtn` directly reserves that FI+tail pair without a modal; the old RESERVE button now opens `AsfAcPickerModal` to let user pick FI+tail. Same logic for clicking an available slot in the main timeline (`AsfTimelineSlotModal`). (8) **Release options** — RELEASE button added to SP card header (only when reserved); clicking a reserved slot in main timeline opens `AsfTimelineReleaseModal` with RELEASE + KEEP options. (9) **Date change releases all** — `setAsfDate` calls `setActivatedSlots({})` before changing date. (10) **Timeline available-slot click** — clicking a green available block in `AsfTimeline` opens `AsfTimelineSlotModal` with slot detail (time, combos, per-SP list) and RESERVE option. Cache token → `r26`. |
| 27 | **AUTO SLOT FINDER filter fix**: `AsfMultiDropdown` (broken — used `position:fixed` computed coords + `null\|Set` state model) replaced with `AsfMultiCheck` — an exact port of `SfMultiCheck` from `view-slotfinder.js`. Key differences: `position:absolute` panel (not fixed), backdrop `<div style={{ position:'fixed', inset:0 }}>` for outside-click, `string[]` selected state (empty = all). Both TYPE and FI FILTER now work identically to SLOT FINDER's multi-checkbox dropdowns. State model changed: `acTypeFilter: string[]`, `fiFilter: string[]` (was `null\|Set`). Cache token → `r27`. |
| 28 | **DOM nesting fix**: `AsfStudentCard` summary row changed from `<button onClick={onToggle}>` to `<div onClick={onToggle}>` — eliminates React dev-mode `validateDOMNesting` warning caused by RELEASE/PROPOSE `<button>` elements being rendered as descendants of the outer toggle button when a slot is reserved. DOM check confirmed no actual button-in-button nesting exists in the rendered HTML; the change makes the virtual DOM hierarchy clean too. Cache token → `r28`. |
| 29 | **AUTO SLOT FINDER — dynamic timeline + SP-FI matched toggle**: (1) **Dynamic timeline end** — `dynHourEnd` computed from `dateFlights` as `max(18, ceil(latest_end_min / 60))`; passed as `hourEnd` prop to `AsfTimeline` and `AsfMiniTimeline`; both components use `HOUR_END = max(ASF_HOUR_END, hourEnd)` for `SPAN_MIN` and ruler; default stays 18:00 when no flights go later. (2) **SP-FI MATCHED toggle** — `fiMatchSp` boolean state (default `true`); rendered as a CSS toggle switch in the control row next to "WITH SLOTS ONLY"; when ON, per-SP slot search pins `spCandFIs` to the SP's override FI (`ovr.fi`) when set (same as before); when OFF, all `candidates.candFIs` are used regardless of SP preference — dramatically increases combo count (e.g. 265 → 2057). Cache token → `r29`. |
| 37 | **AUTO SLOT FINDER — leave exclusion in bulkReserve + timeline grid alignment fix**: (1) **SP leave in bulk auto-reserve** — `bulkReserve` now checks `leavesMap` for each SP before running slot search (same `asfShortName` case-insensitive match used by `slotsByStudent`); on-leave SPs are skipped with `continue` so ⚡ AUTO RESERVE never proposes a slot for them. Added `leavesMap` to dependency array. (2) **Timeline header/row grid alignment** — header was using `gridTemplateColumns: 'LABEL_W auto 1fr'` (3 columns: label | FI/A/C tabs | ruler) while content rows use `'LABEL_W 1fr'` (2 columns), causing the hour ruler to be shifted right by the `auto` tab column. Fixed by collapsing header to the same 2-column grid (`'LABEL_W 1fr'`) and moving the [FI][A/C] toggle buttons inside the label cell as a flex row alongside the "TL"/"N RSRV" text. Ruler and bars in content rows now share the same column and align perfectly. Cache token → `r37`. |
| 36 | **AUTO SLOT FINDER — show ALL flights in timeline; full FI availability**: (1) **FI tab shows all instructors** — `allFIsForTimeline` now derived from `dateFlights` (all instructors on that date) instead of the static `SF_AP127_FI_NAMES` list; non-AP-127 instructors (ATHINAT H., CHAWIN K., JIRAT R., KAMONVICH O., PORNSAK P. and others) now appear as rows with their grey flight bars. (2) **A/C tab shows all tails** — `allTailsForTimeline` now takes every non-SIM tail from `dateFlights` ∪ RESOURCES; tails not in RESOURCES still appear. (3) **FI availability covers cross-batch student appearances** — `_fiSet` in `asfBuildBusyMap` expanded to ALL instructors found in the same flight list (union with `SF_AP127_FI_NAMES`), so if any instructor appears in the `student` field of another flight their busy time is correctly blocked. Cache token → `r36`. |
| 35 | **AUTO SLOT FINDER — fix hidden FAM FI / PPC flights blocking FI availability**: `asfBuildBusyMap` now detects flights where an AP-127 FI appears in the `student` field (e.g. batch `FAM FI`, `PPC` check flights — data confirmed: `SANTI SUK.` and `PHAHOLYUTH P.` fly as student with another FI as instructor). Those FIs are now pushed into `rawFI` and `fiDuty` so the slot finder correctly marks them as unavailable during those flights. `_fiSet = new Set(SF_AP127_FI_NAMES)` built once per call for O(1) lookup. Cache token → `r35`. |
| 34 | **AUTO SLOT FINDER — NONE button in TYPE / FI FILTER dropdowns**: Filter model changed from `string[]` (empty=ALL) to `null \| string[]` (`null`=ALL, `[]`=NONE, `string[]`=subset). `AsfMultiCheck` now renders both `ALL` and `NONE` buttons in the dropdown header; NONE sets `selected=[]` so all checkboxes appear unchecked and no items pass the filter — dispatcher presses NONE then checks exactly the types/FIs they want. Trigger button turns red and shows "None" label when NONE is active. All filter-logic checks updated: `acTypeFilter.length === 0` → `acTypeFilter === null`; same for `fiFilter`. `ASF_DEFAULTS` updated to `null`. Cache token → `r34`. |
| 33 | **AUTO SLOT FINDER — SP/FI leave + A/C maintenance awareness**: (1) **SP on leave** — `slotsByStudent` and `baselineSlotsByStudent` now check `leavesMap` for each SP (case-insensitive `asfShortName` match); on-leave SPs get `slots=[]` and skip the expensive slot search. `finalRecords` carries `onLeave: string\|null`; `AsfStudentCard` renders a blue `ON LEAVE` badge next to the slot count. (2) **FI on leave** — already excluded from `candidates.candFIs`; now the FI FILTER dropdown also shows a blue `LEAVE` chip next to on-leave FIs so dispatchers see why they're excluded. `AsfTimeline` FI tab now always shows the full `fiAllNames` list (was filtered to `candidates.candFIs`), with on-leave FI rows dimmed 50% + `LEAVE` badge. (3) **A/C maintenance** — already excluded from `candidates.candTails`; `AsfTimeline` A/C tab now shows a red `GND` badge on maintenance tail rows (dimmed 50%). `MAINT_TAILS` (already exported from `app-shared.js`) passed as `maintTailSet` prop. (4) **`AsfMultiCheck`** extended to support per-item `badge` field — renders a styled chip to the right of the label (blue for LEAVE, red for GND). Cache token → `r33`. |
| 32 | **AUTO SLOT FINDER — fix A/C picker flicker**: `AsfAcPickerModal` was rendered inside `AsfSlotBtn`'s div. Because `position:fixed` children don't extend their parent's pointer hit-test region, moving the mouse outside the slot button's layout box (but still over the fixed backdrop) triggered `mouseleave` → `setHoveredSlot(null)` → board re-render → visible flicker. Fix: lifted the modal to board level (`acPickerModal` state in `AutoSlotFinderBoard`, rendered alongside `tlSlotModal`/`tlReleaseModal`). `AsfSlotBtn` now receives an `onOpenPicker()` prop; `AsfStudentCard` wires it up with slot + spName + onReserve closure; `AutoSlotFinderBoard.openAcPicker` clears `hoveredSlot` before opening. Additionally, while **any** modal is open (`anyModalOpen`), the scrollable content area gets `pointerEvents:'none'` + `opacity:0.45` so no hover events can fire through the backdrop at all. Cache token → `r32`. |
| 31 | **AUTO SLOT FINDER — `AsfMultiCheck` ALL-mode checkbox fix**: When `selected = []` (ALL), every checkbox now renders as checked (`checked = selected.length === 0 \|\| selected.includes(item.v)`). Clicking a checked item in ALL mode produces "all items except that one" rather than "only that one" — so the user can de-select individual items from a fully-checked state. If the resulting explicit selection covers every available item the state normalizes back to `[]` (ALL). Cache token → `r31`. |
| 30 | **AUTO SLOT FINDER — persistence, bulk reserve, cascade feedback**: (1) **Settings persistence** — `ASF_SETTINGS_LS_KEY = 'ap127-asf-settings-v1'` stores `{acTypeFilter, fiFilter, fiMatchSp, windowFrom, windowTo, rwyEnabled, rwyFrom, rwyTo, sortMode, topN, onlyOpen}`; `asfLoadSettings()` reads on mount; single `useEffect` writes the whole bundle on any change. Reservations and per-SP overrides intentionally NOT persisted (date-scoped). New `↺ RESET` button restores all 11 fields to `ASF_DEFAULTS` and clears the localStorage key. (2) **Bulk auto-reserve** — `⚡ AUTO RESERVE` button (shown only when 0 reservations) walks `finalRecords` in rank order, picks each SP's earliest matched slot + first FI/tail pair, appends a virtual flight to a local `augmented` array so subsequent SPs see the cascade, and commits the whole map via one `setActivatedSlots`. (3) **Export all** — `📋 EXPORT ALL` button (shown when ≥1 reservation) builds a dispatcher-ready text block (`AP-127 BULK SLOT PROPOSAL — DAY DATE MON YYYY` + numbered rows) and copies via `navigator.clipboard.writeText`; shows `✓ COPIED` chip for 1.8s. (4) **Cascade feedback** — new `baselineSlotsByStudent` memo computes "slots this SP would have if no one had reserved" using `dateFlights` (not `augmentedFlights`); short-circuits to `slotsByStudent` when no reservations exist. `finalRecords` carries `baselineCount`; `AsfStudentCard` shows an amber `−N BLOCKED` chip when current slots < baseline, or a red `BLOCKED BY OTHERS` chip when current is 0. Suppressed for SPs that already have their own reservation (their slot drop is self-caused, not cascade). Cache token → `r30`. |
| — | **Fetch reliability**: Playwright browser cached in CI (saves ~2 min/run); Python script retries up to 3× with backoff; `git pull --rebase` before push prevents concurrent-run conflicts; failure opens a GitHub Issue (`fetch-failure` label). |
| — | **Workflow bug fixes**: (1) Playwright cache-hit path ran `install-deps` only — binary was never placed, causing "Executable doesn't exist" crash. Fixed by always running `playwright install chromium --with-deps` unconditionally (fast when cached, full install when cold). (2) Issue reporter got 403 because `issues: write` was missing from the workflow permissions block. |
| — | **Historical data preservation**: `fetch_schedule.py` now merges new data into existing `flight_schedule.json` instead of overwriting — dates outside the source's rolling window are kept. Rolling backup written to `flight_schedule.backup.json` before each save. `rebuild_history.py` reconstructed the full history from 111 git commits (11 dates/260 entries → 15 dates/382 entries, recovering May 5–8). |
| — | **Browser cache**: Added `no-cache / no-store / must-revalidate` meta tags to `index.html` so every refresh revalidates the page with the server. GitHub Pages can't set HTTP headers directly; this is the equivalent client-side directive. Ensures users always load the current `?v=` tokens for JS and data files after a deploy. |
