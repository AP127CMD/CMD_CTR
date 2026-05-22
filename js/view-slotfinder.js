// SLOT FINDER — find open time windows for an additional flight
// Checks: FI availability (leave + conflict + 7-h duty span)
//         SP availability (leave + conflict)           [optional]
//         Aircraft availability (maintenance + conflict)
//         Gap buffer between consecutive flights of the same resource
const { useMemo: useM_sf, useState: useS_sf } = React;

// ─── Constants ───────────────────────────────────────────────────────────
const SF_HOUR_START = 6;
const SF_HOUR_END   = 18;
const SF_HOUR_SPAN  = SF_HOUR_END - SF_HOUR_START;  // 12 h
const SF_MAX_DUTY   = 420;  // 7 hours in minutes

// ─── Helpers ─────────────────────────────────────────────────────────────
const sfMinsToHHMM = m => {
  if (m == null) return '—';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// Direct overlap check (no gap padding — gap is baked into the busyMap)
function sfHasOverlap(blocks, t, end) {
  if (!blocks || !blocks.length) return false;
  for (let i = 0; i < blocks.length; i++) {
    if (t < blocks[i].end && end > blocks[i].start) return true;
  }
  return false;
}

// Duty span check: adding [t, end] must not push the FI's span over 7 h
function sfDutyOk(duty, t, end) {
  if (!duty) return true;  // no existing flights → always ok
  const newFirst = Math.min(duty.first, t);
  const newLast  = Math.max(duty.last,  end);
  return (newLast - newFirst) <= SF_MAX_DUTY;
}

// Build busy-block maps from all non-Canceled flights on a given date.
// Gap padding uses "between only": pad right side of flight i only if there
// is a subsequent flight; pad left side only if there is a preceding flight.
// This means the first flight's left edge and last flight's right edge are
// never padded — only transitions between adjacent flights carry the buffer.
function sfBuildBusyMap(dateFlights, gapMin) {
  // Collect raw intervals per resource key
  const rawFI   = {};  // name  → [{s,e}] sorted by s
  const rawSP   = {};  // name  → [{s,e}]
  const rawTail = {};  // tail  → [{s,e}]
  const fiDuty  = {};  // name  → {first,last}

  dateFlights.forEach(f => {
    const s = minutesOf(f.start), e = minutesOf(f.end);
    if (s == null || e == null) return;

    const push = (map, key) => {
      if (!key) return;
      (map[key] = map[key] || []).push({ s, e });
    };
    push(rawFI,   f.instructor);
    push(rawSP,   f.student);
    push(rawTail, f.tail);

    if (f.instructor) {
      if (!fiDuty[f.instructor]) fiDuty[f.instructor] = { first: s, last: e };
      else {
        fiDuty[f.instructor].first = Math.min(fiDuty[f.instructor].first, s);
        fiDuty[f.instructor].last  = Math.max(fiDuty[f.instructor].last,  e);
      }
    }
  });

  // Convert raw intervals to gap-padded busy blocks ("between only" logic)
  const toBusy = (rawMap) => {
    const out = {};
    Object.entries(rawMap).forEach(([key, arr]) => {
      const sorted = [...arr].sort((a, b) => a.s - b.s);
      out[key] = sorted.map(({ s, e }, i) => ({
        start: s - (i > 0               ? gapMin : 0),
        end:   e + (i < sorted.length-1 ? gapMin : 0),
      }));
    });
    return out;
  };

  return {
    fiBusy:   toBusy(rawFI),
    spBusy:   toBusy(rawSP),
    tailBusy: toBusy(rawTail),
    fiDuty,
    rawFI,     // kept for timeline rendering (un-padded intervals)
    rawSP,
    rawTail,
  };
}

// Sweep 15-min increments and collect valid slots
function sfRunFinder({ windowStart, windowEnd, durationMin, spName },
                     { fiBusy, spBusy, tailBusy, fiDuty },
                     { candFIs, candTails, candSPs }) {
  const results = [];
  for (let t = windowStart; t <= windowEnd - durationMin; t += 15) {
    const end = t + durationMin;
    const avFIs   = candFIs.filter(fi =>
      !sfHasOverlap(fiBusy[fi], t, end) && sfDutyOk(fiDuty[fi], t, end)
    );
    const avTails = candTails.filter(tail =>
      !sfHasOverlap(tailBusy[tail], t, end)
    );
    if (!avFIs.length || !avTails.length) continue;

    let avSPs = null;
    if (spName && spName !== 'any') {
      if (sfHasOverlap(spBusy[spName], t, end)) continue;
      avSPs = [spName];
    }
    results.push({ t, end, avFIs, avTails, avSPs });
  }
  return results;
}

// Merge consecutive 15-min slots that share the exact same FI + tail sets
// into a single wider window. Adjacent = slot.t === prev.end.
function sfMergeSlots(rawSlots) {
  if (!rawSlots.length) return [];
  const windows = [];
  let cur = null;
  rawSlots.forEach(slot => {
    const key = [...slot.avFIs].sort().join('|') + '##' + [...slot.avTails].sort().join('|');
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

// ─── Sub-components ───────────────────────────────────────────────────────

// Inline label + select (matches FilterBar style)
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

// Chip row
function SfChips({ items, color }) {
  if (!items || !items.length)
    return <span className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>—</span>;
  return (
    <>
      {items.map(item => (
        <span key={item} className="mono" style={{
          fontSize: 9, padding: '2px 7px', borderRadius: 4, flexShrink: 0,
          background: `color-mix(in oklch,${color} 12%,transparent)`,
          border: `1px solid color-mix(in oklch,${color} 30%,transparent)`,
          color,
        }}>{item}</span>
      ))}
    </>
  );
}

// One result card
function SfSlotCard({ slot }) {
  const tight = slot.avFIs.length === 1 || slot.avTails.length === 1;
  const veryTight = slot.avFIs.length === 1 && slot.avTails.length === 1;
  const accent = veryTight
    ? 'var(--col-cancel)'
    : tight
      ? 'var(--col-pending)'
      : 'var(--col-done)';
  const badge = veryTight ? 'TIGHT' : tight ? 'LIMITED' : 'OPEN';

  const startLbl = sfMinsToHHMM(slot.t);
  const endLbl   = sfMinsToHHMM(slot.end);
  const durH     = Math.floor((slot.end - slot.t) / 60);
  const durM     = (slot.end - slot.t) % 60;
  const durLbl   = durH > 0 ? `${durH}h${durM > 0 ? durM + 'm' : ''}` : `${durM}m`;

  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid color-mix(in oklch,${accent} 25%,var(--line))`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 6, padding: '9px 12px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="mono num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>
          {startLbl} – {endLbl}
        </span>
        <span className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>{durLbl}</span>
        <span className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)' }}>
          · {slot.avFIs.length} FI{slot.avFIs.length > 1 ? 's' : ''}
          &nbsp;· {slot.avTails.length} A/C
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono uc" style={{
          fontSize: 8, padding: '2px 7px', borderRadius: 999,
          background: `color-mix(in oklch,${accent} 14%,transparent)`,
          border: `1px solid color-mix(in oklch,${accent} 35%,transparent)`,
          color: accent,
        }}>{badge}</span>
      </div>
      {/* FIs */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="mono uc" style={{ fontSize: 8, color: 'var(--ink-3)', width: 22 }}>FI</span>
        <SfChips items={slot.avFIs} color="var(--col-pending)" />
      </div>
      {/* Aircraft */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="mono uc" style={{ fontSize: 8, color: 'var(--ink-3)', width: 22 }}>A/C</span>
        <SfChips
          items={slot.avTails.map(t => {
            const r = RESOURCES.find(x => x.tail === t);
            return r ? `${t} (${r.acType})` : t;
          })}
          color="var(--col-done)"
        />
      </div>
      {/* SP */}
      {slot.avSPs && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="mono uc" style={{ fontSize: 8, color: 'var(--ink-3)', width: 22 }}>SP</span>
          <SfChips items={slot.avSPs} color="var(--col-sim, oklch(0.72 0.15 280))" />
        </div>
      )}
    </div>
  );
}

// ─── Resource Timeline ────────────────────────────────────────────────────
function SfTimeline({ busyMap, candFIs, candTails, results, windowFrom, windowTo, leavesMap, durationMin }) {
  const LABEL_W  = 150;
  const BASE_MIN = SF_HOUR_START * 60;
  const SPAN_MIN = SF_HOUR_SPAN  * 60;

  const pct  = m  => `${Math.max(0, Math.min(100, ((m - BASE_MIN) / SPAN_MIN) * 100))}%`;
  const wpct = dm => `${Math.max(0, (dm / SPAN_MIN) * 100)}%`;

  const wStart = minutesOf(windowFrom) || BASE_MIN;
  const wEnd   = minutesOf(windowTo)   || (BASE_MIN + SPAN_MIN);

  const { rawFI, rawTail } = busyMap;

  const sections = [
    { label: 'FLIGHT INSTRUCTORS', rows: candFIs,   raw: rawFI   },
    { label: 'AIRCRAFT',           rows: candTails, raw: rawTail },
  ];

  return (
    <div style={{
      border: '1px solid var(--line)', borderRadius: 6,
      overflow: 'hidden', background: 'var(--surface)', flexShrink: 0,
    }}>
      {/* Hour ruler */}
      <div style={{
        display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`,
        background: 'var(--bg-2)', borderBottom: '1px solid var(--line)', height: 26,
      }}>
        <div className="mono uc" style={{
          padding: '0 10px', fontSize: 8, color: 'var(--ink-3)',
          display: 'flex', alignItems: 'center',
        }}>TIMELINE</div>
        <div style={{ position: 'relative' }}>
          {/* Window shading */}
          <div style={{
            position: 'absolute',
            left: pct(Math.max(BASE_MIN, wStart)),
            width: wpct(Math.min(BASE_MIN + SPAN_MIN, wEnd) - Math.max(BASE_MIN, wStart)),
            top: 0, bottom: 0,
            background: 'color-mix(in oklch,var(--col-pending) 8%,transparent)',
            pointerEvents: 'none',
          }} />
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

      {/* Resource rows */}
      <div style={{ maxHeight: 290, overflowY: 'auto' }}>
        {sections.map(({ label, rows, raw }) => (
          <React.Fragment key={label}>
            {/* Section header */}
            <div className="mono uc" style={{
              fontSize: 8, color: 'var(--ink-3)', padding: '3px 10px',
              background: 'color-mix(in oklch,var(--ink) 4%,var(--surface))',
              borderBottom: '1px solid var(--line-soft)',
            }}>{label}</div>

            {rows.map((rowKey, ri) => {
              const flights = raw[rowKey] || [];
              const isLeave = leavesMap && leavesMap[rowKey];

              return (
                <div key={rowKey} style={{
                  display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`,
                  borderBottom: '1px solid var(--line-soft)', minHeight: 34,
                  background: ri % 2
                    ? 'transparent'
                    : 'color-mix(in oklch,var(--ink) 1.5%,transparent)',
                  opacity: isLeave ? 0.4 : 1,
                }}>
                  {/* Label */}
                  <div style={{
                    padding: '0 8px', display: 'flex', alignItems: 'center', gap: 5,
                    borderRight: '1px solid var(--line)', overflow: 'hidden',
                  }}>
                    <span style={{
                      fontSize: 10, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                    }}>{rowKey}</span>
                    {isLeave && (
                      <span className="mono uc" style={{
                        fontSize: 7, padding: '1px 4px', borderRadius: 3, flexShrink: 0,
                        background: 'color-mix(in oklch,var(--col-stby,oklch(0.7 0.14 260)) 15%,transparent)',
                        border: '1px solid color-mix(in oklch,var(--col-stby,oklch(0.7 0.14 260)) 40%,transparent)',
                        color: 'var(--col-stby,oklch(0.7 0.14 260))',
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
                        borderLeft: '1px solid var(--line-soft)', opacity: 0.4,
                        pointerEvents: 'none',
                      }} />
                    ))}

                    {/* Window shading */}
                    <div style={{
                      position: 'absolute',
                      left: pct(Math.max(BASE_MIN, wStart)),
                      width: wpct(Math.min(BASE_MIN + SPAN_MIN, wEnd) - Math.max(BASE_MIN, wStart)),
                      top: 0, bottom: 0,
                      background: 'color-mix(in oklch,var(--col-pending) 5%,transparent)',
                      pointerEvents: 'none',
                    }} />

                    {/* Existing flights (un-padded, raw) */}
                    {flights.map((fl, fi) => (
                      <div key={fi} style={{
                        position: 'absolute',
                        left: pct(Math.max(BASE_MIN, fl.s)),
                        width: wpct(Math.min(BASE_MIN + SPAN_MIN, fl.e) - Math.max(BASE_MIN, fl.s)),
                        top: 4, bottom: 4,
                        background: 'color-mix(in oklch,var(--ink-2) 25%,transparent)',
                        border: '1px solid color-mix(in oklch,var(--ink-2) 40%,transparent)',
                        borderRadius: 3,
                      }} />
                    ))}

                    {/* Available slot highlights from results */}
                    {results && results.map((slot, si) => {
                      const isAv = label === 'FLIGHT INSTRUCTORS'
                        ? slot.avFIs.includes(rowKey)
                        : slot.avTails.includes(rowKey);
                      if (!isAv) return null;
                      return (
                        <div key={si} style={{
                          position: 'absolute',
                          left: pct(Math.max(BASE_MIN, slot.t)),
                          width: wpct(slot.end - slot.t),
                          top: 5, bottom: 5,
                          background: 'color-mix(in oklch,var(--col-done) 22%,transparent)',
                          border: '1px solid color-mix(in oklch,var(--col-done) 50%,transparent)',
                          borderRadius: 3,
                          pointerEvents: 'none',
                        }} />
                      );
                    })}

                    {/* Duration preview bar spanning the search window width */}
                    {results === null && wEnd > wStart && (
                      <div style={{
                        position: 'absolute',
                        left: pct(Math.max(BASE_MIN, wStart)),
                        width: wpct(durationMin),
                        top: 7, bottom: 7,
                        borderRadius: 3,
                        background: 'color-mix(in oklch,var(--col-pending) 10%,transparent)',
                        border: '1px dashed color-mix(in oklch,var(--col-pending) 30%,transparent)',
                        pointerEvents: 'none',
                      }} />
                    )}
                  </div>
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>

      {/* Legend */}
      <div style={{
        display: 'flex', gap: 14, padding: '4px 10px',
        borderTop: '1px solid var(--line-soft)',
        background: 'color-mix(in oklch,var(--ink) 2%,var(--surface))',
      }}>
        {[
          ['color-mix(in oklch,var(--ink-2) 25%,transparent)', 'Scheduled'],
          ['color-mix(in oklch,var(--col-done) 22%,transparent)', 'Available slot'],
          ['color-mix(in oklch,var(--col-pending) 8%,transparent)', 'Search window'],
        ].map(([bg, lbl]) => (
          <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 12, height: 8, borderRadius: 2, background: bg, border: '1px solid rgba(255,255,255,0.15)' }} />
            <span className="mono" style={{ fontSize: 8, color: 'var(--ink-3)' }}>{lbl}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Root component ───────────────────────────────────────────────────────
function SlotFinderBoard() {
  const { isMobile } = useApp();

  // ── Search params ──
  const [sfDate,       setSfDate]       = useS_sf(DEFAULT_DATE);
  const [durationMin,  setDurationMin]  = useS_sf(60);
  const [gapMin,       setGapMin]       = useS_sf(15);
  const [acTypeFilter, setAcTypeFilter] = useS_sf('Any');
  const [fiFilter,     setFiFilter]     = useS_sf('any');
  const [spFilter,     setSpFilter]     = useS_sf('any');
  const [windowFrom,   setWindowFrom]   = useS_sf('06:00');
  const [windowTo,     setWindowTo]     = useS_sf('18:00');
  const [sortBy,       setSortBy]       = useS_sf('earliest');

  // ── Dropdown option lists (stable — built once or on date change) ──
  const dateOpts = useM_sf(() =>
    ALL_DATES.map(d => { const { wd, day, mo } = fmtDay(d); return { v: d, l: `${wd} ${String(day).padStart(2,'0')} ${mo}` }; })
  , []);

  const durOpts = [30, 45, 60, 90, 120].map(m => ({
    v: m, l: m < 60 ? `${m} min` : m === 60 ? '1 h' : `${m / 60} h`,
  }));

  const gapOpts = [0, 15, 30].map(m => ({
    v: m, l: m === 0 ? 'No gap' : `${m} min`,
  }));

  const typeOpts = useM_sf(() => {
    const types = [...new Set(
      RESOURCES.filter(r => r.acType && !/SIM|Classroom/i.test(r.acType)).map(r => r.acType)
    )].sort();
    return [{ v: 'Any', l: 'Any type' }, ...types.map(t => ({ v: t, l: t }))];
  }, []);

  const fiOpts = useM_sf(() => {
    const names = INSTRUCTORS.map(i => i.name).sort();
    return [{ v: 'any', l: 'Any available' }, ...names.map(n => ({ v: n, l: n }))];
  }, []);

  // ── Date-derived memos ──
  const dateFlights = useM_sf(() =>
    FLIGHTS.filter(f => f.date === sfDate && f.status !== 'Canceled')
  , [sfDate]);

  const leavesMap = useM_sf(() => leavesOnDate(sfDate), [sfDate]);

  const spOpts = useM_sf(() => {
    const names = [...new Set(
      FLIGHTS.filter(f => f.date === sfDate).map(f => f.student).filter(Boolean)
    )].filter(n => !leavesMap[n]).sort();
    return [{ v: 'any', l: 'No constraint' }, ...names.map(n => ({ v: n, l: n }))];
  }, [sfDate, leavesMap]);

  const busyMap = useM_sf(() => sfBuildBusyMap(dateFlights, gapMin), [dateFlights, gapMin]);

  const candidates = useM_sf(() => {
    const candFIs = fiFilter !== 'any'
      ? (leavesMap[fiFilter] ? [] : [fiFilter])
      : INSTRUCTORS.map(i => i.name).filter(n => !leavesMap[n]);

    const candTails = RESOURCES.filter(r =>
      r.tail &&
      !r.isMaint &&
      !/SIM|Classroom/i.test(r.acType || '') &&
      (acTypeFilter === 'Any' || r.acType === acTypeFilter)
    ).map(r => r.tail);

    const candSPs = spFilter !== 'any' ? [spFilter] : [];

    return { candFIs, candTails, candSPs };
  }, [fiFilter, spFilter, acTypeFilter, leavesMap]);

  // ── Core search — live auto-update ──
  const rawResults = useM_sf(() => {
    const wStart = minutesOf(windowFrom);
    const wEnd   = minutesOf(windowTo);
    if (!wStart && wStart !== 0) return [];
    if (!wEnd   && wEnd   !== 0) return [];
    if (wEnd <= wStart + durationMin) return [];
    return sfRunFinder(
      { windowStart: wStart, windowEnd: wEnd, durationMin, spName: spFilter },
      busyMap,
      candidates,
    );
  }, [windowFrom, windowTo, durationMin, spFilter, busyMap, candidates]);

  const mergedResults = useM_sf(() => sfMergeSlots(rawResults), [rawResults]);

  const sortedResults = useM_sf(() => {
    const arr = [...mergedResults];
    if (sortBy === 'most-fi') arr.sort((a, b) => b.avFIs.length - a.avFIs.length);
    if (sortBy === 'most-ac') arr.sort((a, b) => b.avTails.length - a.avTails.length);
    return arr;
  }, [mergedResults, sortBy]);

  // ── Display date label ──
  const { wd, day, mo } = fmtDay(sfDate);

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
        padding: '6px 10px',
        background: 'var(--bg-2)',
        borderBottom: '1px solid var(--line)',
        display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap',
        flexShrink: 0,
      }}>
        <SfSel label="DATE"     value={sfDate}       onChange={setSfDate}                   opts={dateOpts} minWidth={130} />
        <SfSel label="DURATION" value={durationMin}  onChange={v => setDurationMin(+v)}     opts={durOpts} />
        <SfSel label="BUFFER"   value={gapMin}       onChange={v => setGapMin(+v)}          opts={gapOpts} />
        <SfSel label="TYPE"     value={acTypeFilter} onChange={setAcTypeFilter}             opts={typeOpts} />
        <SfSel label="FI"       value={fiFilter}     onChange={setFiFilter}                 opts={fiOpts} minWidth={140} />
        <SfSel label="SP"       value={spFilter}     onChange={setSpFilter}                 opts={spOpts}  minWidth={140} />
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)' }}>FROM</span>
          <input type="time" value={windowFrom} onChange={e => setWindowFrom(e.target.value)}
            className="mono"
            style={{
              background: 'var(--surface)', color: 'var(--ink)',
              border: '1px solid var(--line)', borderRadius: 4,
              padding: '4px 8px', fontSize: 11, outline: 'none',
              fontFamily: 'inherit', width: 80,
            }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span className="mono uc" style={{ fontSize: 9, color: 'var(--ink-3)' }}>TO</span>
          <input type="time" value={windowTo} onChange={e => setWindowTo(e.target.value)}
            className="mono"
            style={{
              background: 'var(--surface)', color: 'var(--ink)',
              border: '1px solid var(--line)', borderRadius: 4,
              padding: '4px 8px', fontSize: 11, outline: 'none',
              fontFamily: 'inherit', width: 80,
            }} />
        </label>

        {/* Live result badge */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 9 }}>&nbsp;</span>
          <div className="mono uc" style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 10, fontWeight: 600,
            border: `1px solid ${sortedResults.length > 0 ? 'var(--col-done)' : 'var(--line)'}`,
            background: sortedResults.length > 0
              ? 'color-mix(in oklch,var(--col-done) 12%,transparent)'
              : 'transparent',
            color: sortedResults.length > 0 ? 'var(--col-done)' : 'var(--ink-3)',
            transition: 'all .15s',
          }}>
            {sortedResults.length > 0
              ? `${sortedResults.length} SLOT${sortedResults.length > 1 ? 'S' : ''}`
              : 'NO SLOTS'}
          </div>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px' }}>

          {/* Resource timeline */}
          <SfTimeline
            busyMap={busyMap}
            candFIs={candidates.candFIs}
            candTails={candidates.candTails}
            results={mergedResults}
            windowFrom={windowFrom}
            windowTo={windowTo}
            leavesMap={leavesMap}
            durationMin={durationMin}
          />

          {/* Results section */}
          {sortedResults.length === 0 ? (
            <div style={{
              padding: '28px 16px', textAlign: 'center',
              color: 'var(--ink-3)', fontSize: 10,
            }} className="mono uc">
              No available slots — try wider window, shorter duration, or less buffer
            </div>
          ) : (
            <>
              {/* Results header + sort */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 2px 0' }}>
                <div className="mono uc" style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>
                  {sortedResults.length} AVAILABLE SLOT{sortedResults.length > 1 ? 'S' : ''}
                </div>
                <div style={{ flex: 1 }} />
                <span className="mono uc" style={{ fontSize: 8, color: 'var(--ink-3)' }}>SORT</span>
                {[['earliest', 'EARLIEST'], ['most-fi', 'MOST FIs'], ['most-ac', 'MOST A/C']].map(([v, lbl]) => (
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
