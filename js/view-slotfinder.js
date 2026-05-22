// SLOT FINDER — find open time windows for an additional AP-127 flight
// Constraints: FI qualification × aircraft type, duty span (7 h),
//              RWY close period, gap buffer (between-only), SP (optional)
const { useMemo: useM_sf, useState: useS_sf } = React;

// ─── AP-127 FI Qualification Map ─────────────────────────────────────────
// Keys must match the instructor name strings stored in FLIGHTS.instructor
const SF_AP127_FI_QUALS = {
  'CHAROENCHAI U.': ['DA40CS', 'DA42TDI'],
  'EKKAPHOP R.':    ['DA40TDI', 'DA42TDI'],
  'ITTIPOL P.':     ['DA40TDI', 'DA42TDI'],
  'KITTICHAI C.':   ['DA40CS', 'DA42TDI'],
  'KOONPHOL U.':    ['DA40CS', 'DA42TDI'],
  'NAPATTORN S.':   ['DA40TDI', 'DA42TDI'],
  'PARINYA B.':     ['DA40CS', 'DA42TDI'],
  'PHAHOLYUTH P.':  ['DA40CS', 'DA42TDI'],
  'SANTI PO.':      ['DA40CS', 'DA42TDI'],
  'SANTI SUK.':     ['DA40CS', 'DA42TDI'],
  'SOWAN C.':       ['DA40CS', 'DA42TDI'],
  'THAWATANAN P.':  ['DA40TDI', 'DA42TDI'],
  'WISANU T.':      ['DA40TDI', 'DA42TDI'],
  'WUTTHICHAI L.':  ['DA40TDI', 'DA42TDI'],
};
// Sorted alphabetically — used for timeline and dropdowns
const SF_AP127_FI_NAMES = Object.keys(SF_AP127_FI_QUALS).sort();

// ─── Static option arrays (built once outside React) ─────────────────────
// Duration: 1:00 to 5:00 in 15-min steps
const SF_DUR_OPTS = (() => {
  const opts = [];
  for (let m = 60; m <= 300; m += 15) {
    const h = Math.floor(m / 60), mm = m % 60;
    opts.push({ v: m, l: `${h}:${String(mm).padStart(2, '0')}` });
  }
  return opts;
})();

// Buffer: 0 to 60 min in 5-min steps
const SF_GAP_OPTS = (() => {
  const opts = [];
  for (let m = 0; m <= 60; m += 5) {
    opts.push({ v: m, l: m === 0 ? 'No buffer' : `${m} min` });
  }
  return opts;
})();

// ─── Constants ────────────────────────────────────────────────────────────
const SF_HOUR_START = 6;
const SF_HOUR_END   = 18;
const SF_HOUR_SPAN  = SF_HOUR_END - SF_HOUR_START; // 12
const SF_MAX_DUTY   = 420; // 7 h in minutes

// ─── Pure helpers ─────────────────────────────────────────────────────────
const sfMinsToHHMM = m => m == null
  ? '—'
  : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const sfFmtDur = m => {
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
};

// Overlap test against a sorted array of {start,end} blocks
function sfHasOverlap(blocks, t, end) {
  if (!blocks?.length) return false;
  for (let i = 0; i < blocks.length; i++) {
    if (t < blocks[i].end && end > blocks[i].start) return true;
  }
  return false;
}

// Adding [t,end] must not push the FI's duty span past 7 h
function sfDutyOk(duty, t, end) {
  if (!duty) return true;
  return (Math.max(duty.last, end) - Math.min(duty.first, t)) <= SF_MAX_DUTY;
}

// Build padded busy-block maps from all non-Canceled flights on the date.
// "Between-only" gap: left-pad a flight only if there is a prior flight for
// that resource; right-pad only if there is a later one.
function sfBuildBusyMap(dateFlights, gapMin) {
  const rawFI = {}, rawSP = {}, rawTail = {};
  const fiDuty = {};

  dateFlights.forEach(f => {
    const s = minutesOf(f.start), e = minutesOf(f.end);
    if (s == null || e == null) return;
    const push = (map, key) => { if (key) (map[key] = map[key] || []).push({ s, e }); };
    push(rawFI,   f.instructor);
    push(rawSP,   f.student);
    push(rawTail, f.tail);
    if (f.instructor) {
      const d = fiDuty[f.instructor];
      if (!d) fiDuty[f.instructor] = { first: s, last: e };
      else { d.first = Math.min(d.first, s); d.last = Math.max(d.last, e); }
    }
  });

  const toBusy = rawMap => {
    const out = {};
    Object.entries(rawMap).forEach(([key, arr]) => {
      const sorted = [...arr].sort((a, b) => a.s - b.s);
      out[key] = sorted.map(({ s, e }, i) => ({
        start: s - (i > 0               ? gapMin : 0),
        end:   e + (i < sorted.length - 1 ? gapMin : 0),
      }));
    });
    return out;
  };

  return {
    fiBusy:   toBusy(rawFI),
    spBusy:   toBusy(rawSP),
    tailBusy: toBusy(rawTail),
    fiDuty,
    rawFI,   // un-padded, used for timeline rendering
    rawTail,
  };
}

// Sweep in 15-min steps; emit valid (FI × tail) pairs per slot.
// A pair is valid when: FI free, tail free, FI qualified on tail's type,
// duty span ok, RWY not closed, SP free (if constrained).
function sfRunFinder(
  { windowStart, windowEnd, durationMin, spName, rwyStart, rwyEnd },
  { fiBusy, spBusy, tailBusy, fiDuty },
  { candFIs, candTails, tailTypeMap }
) {
  const results = [];
  for (let t = windowStart; t <= windowEnd - durationMin; t += 15) {
    const end = t + durationMin;
    // RWY close
    if (rwyStart != null && rwyEnd != null && t < rwyEnd && end > rwyStart) continue;
    // SP constraint
    if (spName && spName !== 'any' && sfHasOverlap(spBusy[spName], t, end)) continue;

    const freeFIs   = candFIs.filter(fi =>
      !sfHasOverlap(fiBusy[fi], t, end) && sfDutyOk(fiDuty[fi], t, end)
    );
    const freeTails = candTails.filter(tail => !sfHasOverlap(tailBusy[tail], t, end));
    if (!freeFIs.length || !freeTails.length) continue;

    const pairs = [];
    for (const fi of freeFIs) {
      const quals = SF_AP127_FI_QUALS[fi] || [];
      for (const tail of freeTails) {
        if (quals.includes(tailTypeMap[tail])) pairs.push({ fi, tail });
      }
    }
    if (!pairs.length) continue;
    results.push({ t, end, pairs, spName: (spName !== 'any' ? spName : null) });
  }
  return results;
}

// Merge consecutive 15-min slots that have the same (avFIs set, avTails set).
// Pairs shown = all valid pairs for ANY of the merged 15-min slots — the
// key is based on unique FIs + unique tails so the card reflects full option
// space while still grouping predictable "same resource block" windows.
function sfMergeSlots(rawSlots) {
  if (!rawSlots.length) return [];

  const makeKey = slot => {
    const fis   = [...new Set(slot.pairs.map(p => p.fi))].sort().join('|');
    const tails = [...new Set(slot.pairs.map(p => p.tail))].sort().join('|');
    return `${fis}##${tails}`;
  };

  const windows = [];
  let cur = null;
  rawSlots.forEach(slot => {
    const key = makeKey(slot);
    if (cur && cur._key === key && slot.t === cur.end) {
      cur.end = slot.end;
    } else {
      if (cur) windows.push(cur);
      cur = { ...slot, _key: key };
    }
  });
  if (cur) windows.push(cur);
  return windows.map(({ _key, ...w }) => w);
}

// ─── Tiny reusable controls ────────────────────────────────────────────────
function SfSel({ label, value, onChange, opts, minWidth }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)' }}>{label}</span>
      <select className="mono" value={value} onChange={e => onChange(e.target.value)}
        style={{
          background: 'var(--surface)', color: 'var(--ink)',
          border: '1px solid var(--line)', borderRadius: 4,
          padding: '4px 8px', fontSize: 11, outline: 'none',
          minWidth: minWidth || 90,
        }}>
        {opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  );
}

function SfTimeInput({ label, value, onChange, accent }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {label && (
        <span className="mono uc" style={{ fontSize: 9, color: accent || 'var(--ink-3)' }}>
          {label}
        </span>
      )}
      <input type="time" value={value} onChange={e => onChange(e.target.value)}
        className="mono"
        style={{
          background: 'var(--surface)', color: 'var(--ink)',
          border: `1px solid ${accent ? `color-mix(in oklch,${accent} 40%,var(--line))` : 'var(--line)'}`,
          borderRadius: 4, padding: '4px 8px', fontSize: 11, outline: 'none',
          fontFamily: 'inherit', width: 80,
        }} />
    </label>
  );
}

// ─── Slot card ─────────────────────────────────────────────────────────────
function SfSlotCard({ slot }) {
  // Group pairs by FI, each FI's aircraft sorted alphabetically
  const byFI = {};
  slot.pairs.forEach(({ fi, tail }) => { (byFI[fi] = byFI[fi] || []).push(tail); });
  const fiEntries = Object.entries(byFI).sort(([a], [b]) => a.localeCompare(b));

  const nCombos   = slot.pairs.length;
  const nFIs      = fiEntries.length;
  const nTails    = new Set(slot.pairs.map(p => p.tail)).size;
  const durMins   = slot.end - slot.t;
  const accent = nCombos >= 6 ? 'var(--col-done)' : nCombos >= 3 ? 'var(--col-pending)' : 'var(--col-cancel)';
  const badge  = nCombos >= 6 ? 'OPEN' : nCombos >= 3 ? 'LIMITED' : 'TIGHT';

  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid color-mix(in oklch,${accent} 22%,var(--line))`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 6, padding: '9px 12px',
      display: 'flex', flexDirection: 'column', gap: 7,
    }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="mono num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>
          {sfMinsToHHMM(slot.t)} – {sfMinsToHHMM(slot.end)}
        </span>
        <span className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>
          {sfFmtDur(durMins)}
        </span>
        <span className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>
          · {nFIs} FI{nFIs > 1 ? 's' : ''} · {nTails} A/C
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: accent }}>
          {nCombos}&thinsp;COMBO{nCombos > 1 ? 'S' : ''}
        </span>
        <span className="mono uc" style={{
          fontSize: 8, padding: '2px 7px', borderRadius: 999,
          background: `color-mix(in oklch,${accent} 14%,transparent)`,
          border: `1px solid color-mix(in oklch,${accent} 35%,transparent)`,
          color: accent,
        }}>{badge}</span>
      </div>

      {/* ── FI × Aircraft pairs table ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {fiEntries.map(([fi, tails]) => (
          <div key={fi} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
            {/* FI name */}
            <span style={{
              fontSize: 10, color: 'var(--ink-2)',
              minWidth: 138, flexShrink: 0, paddingTop: 2,
            }}>{fi}</span>
            {/* Aircraft chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
              {[...tails].sort().map(tail => {
                const res = RESOURCES.find(r => r.tail === tail);
                return (
                  <span key={tail} className="mono" style={{
                    fontSize: 9, padding: '2px 8px', borderRadius: 4,
                    background: 'color-mix(in oklch,var(--col-done) 10%,transparent)',
                    border: '1px solid color-mix(in oklch,var(--col-done) 28%,transparent)',
                    color: 'var(--col-done)',
                  }}>
                    {tail}{res?.acType ? ` · ${res.acType}` : ''}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── SP chip (when constrained) ── */}
      {slot.spName && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="mono uc" style={{ fontSize: 8, color: 'var(--ink-3)', minWidth: 22 }}>SP</span>
          <span className="mono" style={{
            fontSize: 9, padding: '2px 8px', borderRadius: 4,
            background: 'color-mix(in oklch,oklch(0.72 0.15 280) 12%,transparent)',
            border: '1px solid color-mix(in oklch,oklch(0.72 0.15 280) 30%,transparent)',
            color: 'oklch(0.72 0.15 280)',
          }}>{slot.spName}</span>
        </div>
      )}
    </div>
  );
}

// ─── Resource timeline ─────────────────────────────────────────────────────
function SfTimeline({
  busyMap, allFIs, candFIs, allTails, candTails,
  results, windowFrom, windowTo, leavesMap, rwyStart, rwyEnd,
}) {
  const LABEL_W  = 152;
  const BASE_MIN = SF_HOUR_START * 60;
  const SPAN_MIN = SF_HOUR_SPAN  * 60;

  const pct  = m  => `${Math.max(0, Math.min(100, ((m - BASE_MIN) / SPAN_MIN) * 100))}%`;
  const wpct = dm => `${Math.max(0, (dm / SPAN_MIN) * 100)}%`;

  const wStart = minutesOf(windowFrom) ?? BASE_MIN;
  const wEnd   = minutesOf(windowTo)   ?? (BASE_MIN + SPAN_MIN);

  const { rawFI, rawTail } = busyMap;

  // Pre-compute per-resource availability sets from results
  const avFISet   = new Set(results.flatMap(s => s.pairs.map(p => p.fi)));
  const avTailSet = new Set(results.flatMap(s => s.pairs.map(p => p.tail)));

  // Sections: FIs (alphabetical), then aircraft (alphabetical by tail)
  const sections = [
    { label: 'FLIGHT INSTRUCTORS', rows: [...allFIs].sort(),   raw: rawFI,   avSet: avFISet,   candSet: new Set(candFIs) },
    { label: 'AIRCRAFT',           rows: [...allTails].sort(), raw: rawTail, avSet: avTailSet, candSet: new Set(candTails) },
  ];

  return (
    <div style={{
      border: '1px solid var(--line)', borderRadius: 6,
      overflow: 'hidden', background: 'var(--surface)', flexShrink: 0,
    }}>
      {/* ── Hour ruler ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`,
        background: 'var(--bg-2)', borderBottom: '1px solid var(--line)', height: 26,
      }}>
        <div className="mono uc" style={{
          padding: '0 10px', fontSize: 8, color: 'var(--ink-3)',
          display: 'flex', alignItems: 'center',
        }}>TIMELINE</div>
        <div style={{ position: 'relative' }}>
          {/* Search window shading */}
          <div style={{
            position: 'absolute',
            left: pct(Math.max(BASE_MIN, wStart)),
            width: wpct(Math.min(BASE_MIN + SPAN_MIN, wEnd) - Math.max(BASE_MIN, wStart)),
            top: 0, bottom: 0,
            background: 'color-mix(in oklch,var(--col-pending) 8%,transparent)',
          }} />
          {/* RWY close band */}
          {rwyStart != null && rwyEnd != null && (
            <div style={{
              position: 'absolute',
              left: pct(Math.max(BASE_MIN, rwyStart)),
              width: wpct(Math.min(BASE_MIN + SPAN_MIN, rwyEnd) - Math.max(BASE_MIN, rwyStart)),
              top: 0, bottom: 0,
              background: 'color-mix(in oklch,var(--col-cancel) 15%,transparent)',
              borderLeft: '1px solid color-mix(in oklch,var(--col-cancel) 40%,transparent)',
              borderRight: '1px solid color-mix(in oklch,var(--col-cancel) 40%,transparent)',
            }} />
          )}
          {/* Hour ticks */}
          {Array.from({ length: SF_HOUR_SPAN + 1 }, (_, i) => {
            const h = SF_HOUR_START + i;
            return (
              <div key={i} className="mono num" style={{
                position: 'absolute', left: pct(h * 60), top: 0, bottom: 0,
                borderLeft: i === 0 ? 'none' : '1px solid var(--line-soft)',
                paddingLeft: 3, fontSize: 9, color: 'var(--ink-3)',
                display: 'flex', alignItems: 'center',
              }}>{h}</div>
            );
          })}
        </div>
      </div>

      {/* ── Resource rows ── */}
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        {sections.map(({ label, rows, raw, avSet, candSet }) => (
          <React.Fragment key={label}>
            {/* Section header */}
            <div className="mono uc" style={{
              fontSize: 8, color: 'var(--ink-3)', padding: '3px 10px',
              background: 'color-mix(in oklch,var(--ink) 4%,var(--surface))',
              borderBottom: '1px solid var(--line-soft)',
            }}>{label}</div>

            {rows.map((rowKey, ri) => {
              const flights  = raw[rowKey] || [];
              const isLeave  = leavesMap?.[rowKey];
              const isInCand = candSet.has(rowKey);
              const hasSlots = avSet.has(rowKey);
              const dimmed   = isLeave || !isInCand;

              return (
                <div key={rowKey} style={{
                  display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`,
                  borderBottom: '1px solid var(--line-soft)', minHeight: 32,
                  background: ri % 2
                    ? 'transparent'
                    : 'color-mix(in oklch,var(--ink) 1.5%,transparent)',
                  opacity: dimmed ? 0.28 : 1,
                  transition: 'opacity .15s',
                }}>
                  {/* Row label */}
                  <div style={{
                    padding: '0 8px', display: 'flex', alignItems: 'center', gap: 5,
                    borderRight: '1px solid var(--line)', overflow: 'hidden',
                  }}>
                    <span style={{
                      fontSize: 10,
                      color: hasSlots ? 'var(--ink)' : 'var(--ink-2)',
                      fontWeight: hasSlots ? 600 : 400,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                    }}>{rowKey}</span>
                    {isLeave && (
                      <span className="mono uc" style={{
                        fontSize: 7, padding: '1px 4px', borderRadius: 3, flexShrink: 0,
                        background: 'color-mix(in oklch,oklch(0.7 0.14 260) 15%,transparent)',
                        border: '1px solid color-mix(in oklch,oklch(0.7 0.14 260) 40%,transparent)',
                        color: 'oklch(0.7 0.14 260)',
                      }}>LEAVE</span>
                    )}
                  </div>

                  {/* Track */}
                  <div style={{ position: 'relative' }}>
                    {/* Hour grid lines */}
                    {Array.from({ length: SF_HOUR_SPAN }, (_, i) => (
                      <div key={i} style={{
                        position: 'absolute', left: pct((SF_HOUR_START + i) * 60),
                        top: 0, bottom: 0,
                        borderLeft: '1px solid var(--line-soft)', opacity: 0.35,
                        pointerEvents: 'none',
                      }} />
                    ))}

                    {/* Search window shading */}
                    <div style={{
                      position: 'absolute',
                      left: pct(Math.max(BASE_MIN, wStart)),
                      width: wpct(Math.min(BASE_MIN + SPAN_MIN, wEnd) - Math.max(BASE_MIN, wStart)),
                      top: 0, bottom: 0,
                      background: 'color-mix(in oklch,var(--col-pending) 5%,transparent)',
                      pointerEvents: 'none',
                    }} />

                    {/* RWY close band on each row */}
                    {rwyStart != null && rwyEnd != null && (
                      <div style={{
                        position: 'absolute',
                        left: pct(Math.max(BASE_MIN, rwyStart)),
                        width: wpct(Math.min(BASE_MIN + SPAN_MIN, rwyEnd) - Math.max(BASE_MIN, rwyStart)),
                        top: 0, bottom: 0,
                        background: 'color-mix(in oklch,var(--col-cancel) 8%,transparent)',
                        pointerEvents: 'none',
                      }} />
                    )}

                    {/* Existing flights (un-padded) */}
                    {flights.map((fl, fi) => (
                      <div key={fi} style={{
                        position: 'absolute',
                        left: pct(Math.max(BASE_MIN, fl.s)),
                        width: wpct(Math.min(BASE_MIN + SPAN_MIN, fl.e) - Math.max(BASE_MIN, fl.s)),
                        top: 4, bottom: 4,
                        background: 'color-mix(in oklch,var(--ink-2) 28%,transparent)',
                        border: '1px solid color-mix(in oklch,var(--ink-2) 45%,transparent)',
                        borderRadius: 3,
                      }} />
                    ))}

                    {/* Available slot highlights */}
                    {results.map((slot, si) => {
                      const inPairs = label === 'FLIGHT INSTRUCTORS'
                        ? slot.pairs.some(p => p.fi   === rowKey)
                        : slot.pairs.some(p => p.tail === rowKey);
                      if (!inPairs) return null;
                      return (
                        <div key={si} style={{
                          position: 'absolute',
                          left: pct(Math.max(BASE_MIN, slot.t)),
                          width: wpct(slot.end - slot.t),
                          top: 5, bottom: 5,
                          background: 'color-mix(in oklch,var(--col-done) 22%,transparent)',
                          border: '1px solid color-mix(in oklch,var(--col-done) 55%,transparent)',
                          borderRadius: 3, pointerEvents: 'none',
                        }} />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>

      {/* ── Legend ── */}
      <div style={{
        display: 'flex', gap: 14, padding: '4px 10px', flexWrap: 'wrap',
        borderTop: '1px solid var(--line-soft)',
        background: 'color-mix(in oklch,var(--ink) 2%,var(--surface))',
      }}>
        {[
          ['color-mix(in oklch,var(--ink-2) 28%,transparent)',   'Scheduled'],
          ['color-mix(in oklch,var(--col-done) 22%,transparent)', 'Available slot'],
          ['color-mix(in oklch,var(--col-pending) 8%,transparent)', 'Search window'],
          ['color-mix(in oklch,var(--col-cancel) 15%,transparent)', 'RWY closed'],
        ].map(([bg, lbl]) => (
          <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 12, height: 8, borderRadius: 2, background: bg, border: '1px solid rgba(255,255,255,0.12)' }} />
            <span className="mono" style={{ fontSize: 8, color: 'var(--ink-3)' }}>{lbl}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Root component ────────────────────────────────────────────────────────
function SlotFinderBoard() {
  const { isMobile } = useApp();

  // ── Search params ─────────────────────────────────────────────────────
  const [sfDate,       setSfDate]       = useS_sf(DEFAULT_DATE);
  const [durationMin,  setDurationMin]  = useS_sf(60);        // default 1 h
  const [gapMin,       setGapMin]       = useS_sf(30);        // default 30 min buffer
  const [acTypeFilter, setAcTypeFilter] = useS_sf('Any');
  const [fiFilter,     setFiFilter]     = useS_sf('any');
  const [spFilter,     setSpFilter]     = useS_sf('any');
  const [windowFrom,   setWindowFrom]   = useS_sf('06:00');
  const [windowTo,     setWindowTo]     = useS_sf('18:00');
  const [sortBy,       setSortBy]       = useS_sf('earliest');
  const [rwyEnabled,   setRwyEnabled]   = useS_sf(true);
  const [rwyFrom,      setRwyFrom]      = useS_sf('14:00');
  const [rwyTo,        setRwyTo]        = useS_sf('16:00');

  // ── Static option lists ───────────────────────────────────────────────
  const dateOpts = useM_sf(() =>
    ALL_DATES.map(d => {
      const { wd, day, mo } = fmtDay(d);
      return { v: d, l: `${wd} ${String(day).padStart(2, '0')} ${mo}` };
    })
  , []);

  // Aircraft types available (from RESOURCES, non-SIM)
  const typeOpts = useM_sf(() => {
    const types = [...new Set(
      RESOURCES.filter(r => r.acType && !/SIM|Classroom/i.test(r.acType)).map(r => r.acType)
    )].sort();
    return [{ v: 'Any', l: 'Any type' }, ...types.map(t => ({ v: t, l: t }))];
  }, []);

  // FI options: only AP127 FIs, filtered by selected type
  const fiOpts = useM_sf(() => {
    const qualified = acTypeFilter === 'Any'
      ? SF_AP127_FI_NAMES
      : SF_AP127_FI_NAMES.filter(n => SF_AP127_FI_QUALS[n]?.includes(acTypeFilter));
    return [{ v: 'any', l: 'Any available' }, ...qualified.map(n => ({ v: n, l: n }))];
  }, [acTypeFilter]);

  // ── Date-derived memos ────────────────────────────────────────────────
  const dateFlights = useM_sf(() =>
    FLIGHTS.filter(f => f.date === sfDate && f.status !== 'Canceled')
  , [sfDate]);

  const leavesMap = useM_sf(() => leavesOnDate(sfDate), [sfDate]);

  // AP-127 students from all scheduled flights, sorted alphabetically
  const ap127Students = useM_sf(() =>
    [...new Set(
      FLIGHTS.filter(f => /AP.?127/i.test(f.batch || '') && f.student)
             .map(f => f.student)
    )].sort()
  , []);

  // SP options: AP127 students not on leave today
  const spOpts = useM_sf(() => {
    const free = ap127Students.filter(n => !leavesMap[n]);
    return [{ v: 'any', l: 'No constraint' }, ...free.map(n => ({ v: n, l: n }))];
  }, [ap127Students, leavesMap]);

  // Busy/duty maps
  const busyMap = useM_sf(() => sfBuildBusyMap(dateFlights, gapMin), [dateFlights, gapMin]);

  // tail → acType lookup
  const tailTypeMap = useM_sf(() => {
    const m = {};
    RESOURCES.forEach(r => { if (r.tail) m[r.tail] = r.acType || ''; });
    return m;
  }, []);

  // Candidate FIs (AP127 only, type-qualified, not on leave, respect FI filter)
  // If a specific FI is selected but not qualified for the chosen type → empty
  const candidates = useM_sf(() => {
    const typeMatch = fi =>
      acTypeFilter === 'Any' || (SF_AP127_FI_QUALS[fi]?.includes(acTypeFilter));

    const candFIs = fiFilter !== 'any'
      ? (typeMatch(fiFilter) && !leavesMap[fiFilter] ? [fiFilter] : [])
      : SF_AP127_FI_NAMES.filter(n => typeMatch(n) && !leavesMap[n]);

    const candTails = RESOURCES.filter(r =>
      r.tail &&
      !r.isMaint &&
      !/SIM|Classroom/i.test(r.acType || '') &&
      (acTypeFilter === 'Any' || r.acType === acTypeFilter)
    ).map(r => r.tail).sort();

    return { candFIs, candTails, tailTypeMap };
  }, [fiFilter, acTypeFilter, leavesMap, tailTypeMap]);

  // All aircraft rows shown in timeline (filtered by type if selected)
  const allTailsForTimeline = useM_sf(() =>
    RESOURCES.filter(r =>
      r.tail &&
      !/SIM|Classroom/i.test(r.acType || '') &&
      (acTypeFilter === 'Any' || r.acType === acTypeFilter)
    ).map(r => r.tail).sort()
  , [acTypeFilter]);

  // RWY close in minutes
  const rwyBand = useM_sf(() => {
    if (!rwyEnabled) return { rwyStart: null, rwyEnd: null };
    return { rwyStart: minutesOf(rwyFrom) ?? null, rwyEnd: minutesOf(rwyTo) ?? null };
  }, [rwyEnabled, rwyFrom, rwyTo]);

  // ── Core search (live auto-update) ────────────────────────────────────
  const rawResults = useM_sf(() => {
    const wStart = minutesOf(windowFrom);
    const wEnd   = minutesOf(windowTo);
    if (wStart == null || wEnd == null) return [];
    if (wEnd <= wStart + durationMin) return [];
    return sfRunFinder(
      { windowStart: wStart, windowEnd: wEnd, durationMin,
        spName: spFilter, ...rwyBand },
      busyMap,
      candidates,
    );
  }, [windowFrom, windowTo, durationMin, spFilter, rwyBand, busyMap, candidates]);

  const mergedResults = useM_sf(() => sfMergeSlots(rawResults), [rawResults]);

  const sortedResults = useM_sf(() => {
    const arr = [...mergedResults];
    if (sortBy === 'most-combos') arr.sort((a, b) => b.pairs.length - a.pairs.length);
    if (sortBy === 'most-fi')
      arr.sort((a, b) =>
        new Set(b.pairs.map(p => p.fi)).size - new Set(a.pairs.map(p => p.fi)).size
      );
    // 'earliest' → natural order (already time-sorted)
    return arr;
  }, [mergedResults, sortBy]);

  // ── Summary stats ────────────────────────────────────────────────────
  const { wd, day, mo } = fmtDay(sfDate);
  const totalCombosMax = sortedResults.length
    ? Math.max(...sortedResults.map(s => s.pairs.length))
    : 0;

  return (
    <ArtboardShell style={{ display: 'flex', flexDirection: 'column' }}>
      <ThemeStyle />

      {/* ── Top bar ── */}
      <div style={{
        minHeight: 38, padding: '0 14px',
        borderBottom: '1px solid var(--line)', background: 'var(--bg-2)',
        display: 'flex', alignItems: 'center', gap: 10,
        flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 8, height: 8, borderRadius: 999,
            background: 'var(--col-done)',
            boxShadow: '0 0 8px var(--col-done)',
            animation: 'pulse 2s ease-in-out infinite',
          }} />
          <ViewIcon id="slotfinder" size={12} color="var(--ink-2)" />
          <div className="mono uc" style={{ fontSize: 11, fontWeight: 600 }}>SLOT FINDER</div>
        </div>
        <div style={{ flex: 1 }} />
        <FocusControls />
        {!isMobile && (
          <div className="mono num" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            {String(day).padStart(2, '0')} {mo} · {wd}
          </div>
        )}
        <RefreshButton />
        <LastUpdate />
      </div>

      {/* ── Search strip ── */}
      <div style={{
        padding: '6px 10px 8px',
        background: 'var(--bg-2)',
        borderBottom: '1px solid var(--line)',
        display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap',
        flexShrink: 0,
      }}>
        {/* Row 1: main params */}
        <SfSel label="DATE"     value={sfDate}       onChange={setSfDate}              opts={dateOpts} minWidth={130} />
        <SfSel label="DURATION" value={durationMin}  onChange={v => setDurationMin(+v)} opts={SF_DUR_OPTS} minWidth={74} />
        <SfSel label="BUFFER"   value={gapMin}       onChange={v => setGapMin(+v)}      opts={SF_GAP_OPTS} minWidth={82} />
        <SfSel label="TYPE"     value={acTypeFilter} onChange={setAcTypeFilter}         opts={typeOpts} />
        <SfSel label="FI"       value={fiFilter}     onChange={setFiFilter}             opts={fiOpts} minWidth={148} />
        <SfSel label="SP"       value={spFilter}     onChange={setSpFilter}             opts={spOpts}  minWidth={148} />

        {/* Divider */}
        <div style={{
          width: 1, height: 38, background: 'var(--line)',
          alignSelf: 'flex-end', flexShrink: 0, marginBottom: 1,
        }} />

        {/* Window + RWY close */}
        <SfTimeInput label="FROM" value={windowFrom} onChange={setWindowFrom} />
        <SfTimeInput label="TO"   value={windowTo}   onChange={setWindowTo} />

        {/* RWY close toggle */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span className="mono uc" style={{ fontSize: 9, color: 'var(--col-cancel)' }}>RWY CLOSE</span>
          <button onClick={() => setRwyEnabled(!rwyEnabled)} className="mono uc"
            style={{
              padding: '4px 9px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
              border: `1px solid ${rwyEnabled ? 'var(--col-cancel)' : 'var(--line)'}`,
              background: rwyEnabled
                ? 'color-mix(in oklch,var(--col-cancel) 14%,transparent)'
                : 'transparent',
              color: rwyEnabled ? 'var(--col-cancel)' : 'var(--ink-3)',
              fontWeight: rwyEnabled ? 600 : 400,
              height: 28,
            }}>
            {rwyEnabled ? 'ON' : 'OFF'}
          </button>
        </label>
        {rwyEnabled && (
          <>
            <SfTimeInput label="CLOSED FROM" value={rwyFrom} onChange={setRwyFrom} accent="var(--col-cancel)" />
            <SfTimeInput label="CLOSED TO"   value={rwyTo}   onChange={setRwyTo}   accent="var(--col-cancel)" />
          </>
        )}

        {/* Live result badge */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginLeft: 'auto' }}>
          <span style={{ fontSize: 9 }}>&nbsp;</span>
          <div className="mono uc" style={{
            padding: '4px 12px', borderRadius: 4, fontSize: 10, fontWeight: 600,
            border: `1px solid ${sortedResults.length > 0 ? 'var(--col-done)' : 'var(--line)'}`,
            background: sortedResults.length > 0
              ? 'color-mix(in oklch,var(--col-done) 12%,transparent)'
              : 'transparent',
            color: sortedResults.length > 0 ? 'var(--col-done)' : 'var(--ink-3)',
            height: 28, display: 'flex', alignItems: 'center',
            transition: 'all .15s',
          }}>
            {sortedResults.length > 0
              ? `${sortedResults.length} SLOT${sortedResults.length > 1 ? 'S' : ''} · UP TO ${totalCombosMax} COMBOS`
              : 'NO SLOTS FOUND'}
          </div>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px' }}>

          {/* Timeline */}
          <SfTimeline
            busyMap={busyMap}
            allFIs={SF_AP127_FI_NAMES}
            candFIs={candidates.candFIs}
            allTails={allTailsForTimeline}
            candTails={candidates.candTails}
            results={mergedResults}
            windowFrom={windowFrom}
            windowTo={windowTo}
            leavesMap={leavesMap}
            rwyStart={rwyBand.rwyStart}
            rwyEnd={rwyBand.rwyEnd}
          />

          {/* Results */}
          {sortedResults.length === 0 ? (
            <div style={{
              padding: '28px 16px', textAlign: 'center',
              color: 'var(--ink-3)', fontSize: 10,
            }} className="mono uc">
              No available slots — adjust window, duration, buffer, or filters
            </div>
          ) : (
            <>
              {/* Header + sort */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 2px 0' }}>
                <div className="mono uc" style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>
                  {sortedResults.length} SLOT{sortedResults.length > 1 ? 'S' : ''}
                </div>
                <div style={{ flex: 1 }} />
                <span className="mono uc" style={{ fontSize: 8, color: 'var(--ink-3)' }}>SORT</span>
                {[['earliest', 'EARLIEST'], ['most-combos', 'MOST COMBOS'], ['most-fi', 'MOST FIs']].map(([v, lbl]) => (
                  <button key={v} onClick={() => setSortBy(v)} className="mono uc"
                    style={{
                      padding: '2px 8px', fontSize: 8, borderRadius: 3, cursor: 'pointer',
                      border: `1px solid ${sortBy === v ? 'var(--col-pending)' : 'var(--line)'}`,
                      background: sortBy === v
                        ? 'color-mix(in oklch,var(--col-pending) 12%,transparent)'
                        : 'transparent',
                      color: sortBy === v ? 'var(--col-pending)' : 'var(--ink-3)',
                      fontWeight: sortBy === v ? 600 : 400,
                    }}>{lbl}</button>
                ))}
              </div>

              {/* Cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sortedResults.map((slot, i) => (
                  <SfSlotCard key={`${slot.t}-${slot.end}-${i}`} slot={slot} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <Drawer />
    </ArtboardShell>
  );
}

window.SlotFinderBoard = SlotFinderBoard;
