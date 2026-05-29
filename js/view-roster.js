// Roster — instructor × date workload heat-map
// PM view: spot over/under-loaded instructors and plan capacity across the period
const { useMemo: useM_r, useState: useS_r } = React;

// Load thresholds (flights per day per row)
const LOAD_COLOR = n => {
  if (n === 0) return null;
  if (n === 1) return 'var(--col-done)';
  if (n <= 3)  return 'var(--col-pending)';
  return 'var(--col-cancel)';
};
const LOAD_OPACITY = n => n === 0 ? 0 : Math.min(0.9, 0.35 + n * 0.14);

function RosterBoard() {
  const app = useApp();
  const { isMobile } = app;
  const [groupBy,    setGroupBy]    = useS_r('instructor'); // 'instructor' | 'batch' | 'student'
  const [ap127Only,  setAp127Only]  = useS_r(false);
  // cellDetail: { key, date } | null — the cell whose flight list is shown in the overlay
  const [cellDetail, setCellDetail] = useS_r(null);
  const today = localToday();

  // Build matrix: rowKey × date → { flights, hours, batches[], ap127, completed }
  const { keys, matrix, flightsByKeyDate } = useM_r(() => {
    const m        = {};   // key → date → agg
    const fByKD    = {};   // key → date → flight[]
    const keySet   = new Set();

    FLIGHTS.forEach(f => {
      // AP-127 only filter applies to full dataset
      if (ap127Only && f.batch !== HIGHLIGHT_BATCH) return;

      const key = groupBy === 'instructor'
        ? (f.instructor || '—')
        : groupBy === 'batch'
          ? (f.batch      || '—')
          : (f.student    || '—');
      keySet.add(key);

      if (!m[key])           m[key]           = {};
      if (!m[key][f.date])   m[key][f.date]   = { flights:0, hours:0, ap127:0, completed:0 };
      if (!fByKD[key])       fByKD[key]       = {};
      if (!fByKD[key][f.date]) fByKD[key][f.date] = [];

      const cell = m[key][f.date];
      cell.flights++;
      cell.hours += (f.durMin || 0) / 60;
      if (f.batch === HIGHLIGHT_BATCH) cell.ap127++;
      if (f.status === 'Completed')    cell.completed++;
      fByKD[key][f.date].push(f);
    });

    const sorted = [...keySet].sort((a, b) => {
      if (groupBy === 'instructor') return a.localeCompare(b);
      if (groupBy === 'batch') {
        const aAP = /^AP-/i.test(a), bAP = /^AP-/i.test(b);
        if (aAP !== bAP) return aAP ? -1 : 1;
      }
      return a.localeCompare(b);
    });

    return { keys: sorted, matrix: m, flightsByKeyDate: fByKD };
  }, [groupBy, ap127Only]);

  // Summary stats per date (bottom row) — respects ap127Only
  const dateTotals = useM_r(() => {
    const t = {};
    ALL_DATES.forEach(d => { t[d] = { flights:0, hours:0 }; });
    FLIGHTS.forEach(f => {
      if (ap127Only && f.batch !== HIGHLIGHT_BATCH) return;
      if (!t[f.date]) return;
      t[f.date].flights++;
      t[f.date].hours += (f.durMin||0)/60;
    });
    return t;
  }, [ap127Only]);

  const CELL_W  = isMobile ? 32 : 44;
  const ROW_H   = isMobile ? 28 : 34;
  const LABEL_W = isMobile ? 90 : 160;

  const GrpChip = ({ g, label }) => (
    <button onClick={() => setGroupBy(g)} className="mono uc" style={{
      padding:'2px 8px', fontSize:8, borderRadius:3, cursor:'pointer',
      border:`1px solid ${groupBy===g?'var(--ink-2)':'var(--line)'}`,
      background: groupBy===g ? `color-mix(in oklch,var(--ink-2) 14%,var(--surface))` : 'transparent',
      color: groupBy===g ? 'var(--ink-2)' : 'var(--ink-3)',
      fontWeight: groupBy===g ? 600 : 400, transition:'all .1s',
    }}>{label}</button>
  );

  // Cell detail overlay — shows flights for a specific key × date
  const CellDetailOverlay = () => {
    if (!cellDetail) return null;
    const { key, date } = cellDetail;
    const { wd, mo, day } = fmtDay(date);
    const flights = (flightsByKeyDate[key]?.[date] || [])
      .slice()
      .sort((a, b) => (minutesOf(a.start)||0) - (minutesOf(b.start)||0));

    return (
      <div
        onClick={() => setCellDetail(null)}
        style={{
          position:'fixed', inset:0, zIndex:100,
          background:'rgba(0,0,0,0.45)',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background:'var(--surface)', border:'1px solid var(--line)', borderRadius:10,
            width: Math.min(360, window.innerWidth - 32),
            maxHeight:'70vh', display:'flex', flexDirection:'column',
            boxShadow:'0 8px 32px rgba(0,0,0,0.4)',
          }}>
          {/* Detail header */}
          <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', borderRadius:'10px 10px 0 0', display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ flex:1 }}>
              <div className="mono uc" style={{ fontSize:12, fontWeight:600, color:'var(--ink)' }}>{key}</div>
              <div className="mono uc" style={{ fontSize:9, color:'var(--ink-3)', marginTop:1 }}>
                {String(day).padStart(2,'0')} {mo} · {wd} · {flights.length} FLT
              </div>
            </div>
            <button
              onClick={() => setCellDetail(null)}
              style={{ background:'transparent', border:'1px solid var(--line)', borderRadius:4, padding:'2px 8px', cursor:'pointer', color:'var(--ink-3)', fontSize:11 }}>
              ✕
            </button>
          </div>
          {/* Flight list */}
          <div style={{ overflowY:'auto', flex:1, padding:'8px 10px', display:'flex', flexDirection:'column', gap:6 }}>
            {flights.map((f, fi) => {
              const color = STATUS_COLOR(f);
              return (
                <button key={f.id+fi}
                  onClick={() => { app.setDate(date); app.setDrawer(f.id); setCellDetail(null); }}
                  style={{
                    textAlign:'left', padding:'8px 10px',
                    background:`color-mix(in oklch,${color} 8%,var(--bg-2))`,
                    border:`1px solid color-mix(in oklch,${color} 30%,var(--line))`,
                    borderLeft:`3px solid ${color}`,
                    borderRadius:5, cursor:'pointer', color:'var(--ink)',
                  }}>
                  <div style={{ display:'flex', gap:8, alignItems:'baseline' }}>
                    <span className="mono num" style={{ fontSize:12, fontWeight:600 }}>{f.start}</span>
                    <span className="mono" style={{ fontSize:10, color:'var(--ink-3)' }}>–{f.end}</span>
                    <span style={{ flex:1 }}/>
                    <span className="mono uc" style={{
                      fontSize:8,
                      color: f.batch===HIGHLIGHT_BATCH ? 'var(--highlight)' : 'var(--ink-3)',
                      fontWeight: f.batch===HIGHLIGHT_BATCH ? 600 : 400,
                    }}>{f.batch}</span>
                  </div>
                  {groupBy !== 'student'    && <div style={{ fontSize:11, color:'var(--ink)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.student||'—'}</div>}
                  {groupBy === 'student'    && <div style={{ fontSize:11, color:'var(--ink)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.instructor||'—'}</div>}
                  <div className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', marginTop:2, display:'flex', gap:6 }}>
                    <span>{f.lesson||'—'}</span>
                    <span>·</span>
                    <span>{f.tail||'TBD'}</span>
                    {f.isStandby && <><span>·</span><span style={{ color:'var(--col-stby)' }}>STBY</span></>}
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{ padding:'6px 14px', borderTop:'1px solid var(--line)', background:'var(--bg-2)', borderRadius:'0 0 10px 10px' }}>
            <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>TAP A FLIGHT FOR FULL DETAIL</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <ArtboardShell style={{ display:'flex', flexDirection:'column' }}>
      <ThemeStyle/>
      <CellDetailOverlay/>

      {/* Header */}
      <div style={{ minHeight:38, padding:'0 10px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', display:'flex', alignItems:'center', gap:8, flexShrink:0, flexWrap:'wrap' }}>
        <div style={{ display:'flex',alignItems:'center',gap:7 }}>
          <span style={{ width:8,height:8,borderRadius:999,background:'var(--col-done)',boxShadow:'0 0 6px var(--col-done)' }}/>
          <ViewIcon id="roster" size={12} color="var(--ink-2)"/>
          <div className="mono uc" style={{ fontSize:11,fontWeight:600 }}>ROSTER</div>
        </div>
        <div style={{ display:'flex',gap:4,alignItems:'center' }}>
          <span className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>VIEW</span>
          <GrpChip g="instructor" label="INSTRUCTOR"/>
          <GrpChip g="batch"      label="BATCH"/>
          <GrpChip g="student"    label="STUDENT"/>
        </div>
        {/* AP-127 only toggle */}
        <button onClick={() => setAp127Only(v => !v)} className="mono uc" style={{
          padding:'2px 8px', fontSize:8, borderRadius:3, cursor:'pointer',
          border:`1px solid ${ap127Only?'var(--highlight)':'var(--line)'}`,
          background: ap127Only ? `color-mix(in oklch,var(--highlight) 14%,var(--surface))` : 'transparent',
          color: ap127Only ? 'var(--highlight)' : 'var(--ink-3)',
          fontWeight: ap127Only ? 600 : 400, transition:'all .1s',
        }}>◆ AP-127 ONLY</button>
        <div style={{flex:1}}/>
        <FocusControls/>
        <div className="mono uc" style={{ fontSize:9,color:'var(--ink-3)' }}>{keys.length} {groupBy==='instructor'?'INSTRUCTORS':groupBy==='batch'?'BATCHES':'STUDENTS'}</div>
        <RefreshButton/>
        <LastUpdate/>
      </div>

      {/* Legend */}
      <div style={{ padding:'3px 10px', borderBottom:'1px solid var(--line-soft)', background:'var(--bg-2)', display:'flex', gap:14, alignItems:'center', flexShrink:0 }}>
        <span className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>LOAD:</span>
        {[[1,'1 FLT','var(--col-done)'],[2,'2–3','var(--col-pending)'],[4,'4+','var(--col-cancel)']].map(([n,lbl,c])=>(
          <span key={n} style={{ display:'flex',gap:5,alignItems:'center' }}>
            <span style={{ width:14,height:10,borderRadius:2,background:c,opacity:LOAD_OPACITY(n) }}/>
            <span className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>{lbl}</span>
          </span>
        ))}
        <span style={{ display:'flex',gap:5,alignItems:'center' }}>
          <span className="mono" style={{ fontSize:10,color:'var(--highlight)' }}>◆</span>
          <span className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>AP-127</span>
        </span>
        <span style={{ display:'flex',gap:5,alignItems:'center' }}>
          <span style={{ width:14,height:10,borderRadius:2,background:'color-mix(in oklch,var(--col-stby) 10%,transparent)',border:'1px solid var(--col-stby)',display:'flex',alignItems:'center',justifyContent:'center' }}>
            <span className="mono uc" style={{ fontSize:6,color:'var(--col-stby)',fontWeight:700 }}>L</span>
          </span>
          <span className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>ON LEAVE</span>
        </span>
        <div style={{flex:1}}/>
        <span className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>CLICK CELL → DETAILS</span>
      </div>

      {/* Scrollable matrix */}
      <div style={{ flex:1, minHeight:0, overflow:'auto' }}>
        <table style={{ borderCollapse:'collapse', minWidth:'max-content' }}>
          {/* Column header: dates */}
          <thead>
            <tr>
              <th style={{
                width:LABEL_W, minWidth:LABEL_W, padding:'6px 8px', textAlign:'left',
                background:'var(--bg-2)', borderBottom:'1px solid var(--line)',
                position:'sticky', top:0, left:0, zIndex:3,
              }}>
                <span className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>{groupBy.toUpperCase()}</span>
              </th>
              {ALL_DATES.map(d => {
                const { wd, day } = fmtDay(d);
                const isPastDate  = d < today;
                const isTodayDate = d === today;
                return (
                  <th key={d} style={{
                    width:CELL_W, minWidth:CELL_W, padding:'4px 2px', textAlign:'center',
                    background: isTodayDate ? 'color-mix(in oklch,var(--col-pending) 10%,var(--bg-2))' : 'var(--bg-2)',
                    borderBottom:`1px solid ${isTodayDate?'var(--col-pending)':'var(--line)'}`,
                    borderLeft:'1px solid var(--line-soft)',
                    position:'sticky', top:0, zIndex:2,
                    opacity: isPastDate && !isTodayDate ? 0.6 : 1,
                  }}>
                    <div className="mono uc" style={{ fontSize:isMobile?6:7, color:'var(--ink-3)' }}>{wd}</div>
                    <div className="num" style={{ fontSize:isMobile?10:12, fontWeight:600, color: isTodayDate?'var(--col-pending)':'var(--ink)' }}>{String(day).padStart(2,'0')}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {keys.map((key, ki) => {
              const rowData  = matrix[key] || {};
              const rowTotal = ALL_DATES.reduce((s,d) => s + (rowData[d]?.flights||0), 0);
              const rowHours = ALL_DATES.reduce((s,d) => s + (rowData[d]?.hours||0),   0);
              const isHL = groupBy === 'batch'
                ? key === HIGHLIGHT_BATCH
                : ALL_DATES.some(d => rowData[d]?.ap127 > 0);
              const rowAlpha = app.highlightAP127 && !isHL ? 0.3 : 1;
              // Show LEAVE badge only when they are on leave TODAY
              const isOnLeaveToday = groupBy !== 'batch' && !!leavesOnDate(today)[key];

              return (
                <tr key={key} style={{ opacity: rowAlpha, transition:'opacity .15s' }}>
                  {/* Row label */}
                  <td style={{
                    padding:'4px 8px',
                    borderBottom:'1px solid var(--line-soft)',
                    borderRight:'1px solid var(--line)',
                    position:'sticky', left:0, zIndex:1,
                    background: ki%2
                      ? 'var(--bg-2)'
                      : 'color-mix(in oklch,var(--ink) 1.5%,var(--bg-2))',
                  }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      {isHL && <span style={{ color:'var(--highlight)',fontSize:9 }}>◆</span>}
                      <span style={{
                        fontSize: isMobile?9:11, fontWeight:500,
                        color: isHL ? 'var(--highlight)' : 'var(--ink)',
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                        maxWidth: LABEL_W - 30,
                        display:'block',
                      }}>{key}</span>
                      {isOnLeaveToday && <LeaveBadge reason={leavesOnDate(today)[key]}/>}
                    </div>
                    {!isMobile && (
                      <div className="mono uc" style={{ fontSize:8,color:'var(--ink-3)',marginTop:1 }}>
                        {rowTotal} FLT · {rowHours.toFixed(1)}h
                      </div>
                    )}
                  </td>
                  {/* Cells */}
                  {ALL_DATES.map(d => {
                    const cell = rowData[d];
                    const n    = cell?.flights || 0;
                    const color      = LOAD_COLOR(n);
                    const isTodayDate = d === today;
                    const onLeaveToday = groupBy !== 'batch' && !!leavesOnDate(d)[key];
                    return (
                      <td key={d}
                        onClick={() => {
                          if (n > 0) setCellDetail({ key, date: d });
                        }}
                        title={
                          onLeaveToday
                            ? `${key} · ${d} · ON LEAVE${n ? ` · ${n} FLT` : ''}`
                            : n > 0 ? `${key} · ${d} · ${n} FLT · ${(cell.hours).toFixed(1)}h` : undefined
                        }
                        style={{
                          width:CELL_W, height:ROW_H, textAlign:'center', verticalAlign:'middle',
                          borderBottom:'1px solid var(--line-soft)',
                          borderLeft:`1px solid ${isTodayDate?'color-mix(in oklch,var(--col-pending) 30%,var(--line-soft))':'var(--line-soft)'}`,
                          background: color
                            ? `color-mix(in oklch,${color} ${Math.round(LOAD_OPACITY(n)*100)}%,var(--surface))`
                            : onLeaveToday
                              ? 'color-mix(in oklch,var(--col-stby) 10%,transparent)'
                              : ki%2 ? 'transparent' : 'color-mix(in oklch,var(--ink) 0.8%,transparent)',
                          cursor: n > 0 ? 'pointer' : 'default',
                          transition:'background .1s',
                          position:'relative',
                        }}>
                        {n > 0 && (
                          <>
                            <span className="mono num" style={{ fontSize:isMobile?9:11, fontWeight:600, color:'var(--ink)', display:'block', lineHeight:1 }}>{n}</span>
                            {cell.ap127 > 0 && (
                              <span style={{ position:'absolute', top:2, right:3, fontSize:7, color:'var(--highlight)', lineHeight:1 }}>◆</span>
                            )}
                          </>
                        )}
                        {n === 0 && onLeaveToday && (
                          <span className="mono uc" style={{ fontSize:isMobile?6:7, color:'var(--col-stby)', fontWeight:600, letterSpacing:'0.03em' }}>L</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {/* Summary row */}
            <tr style={{ borderTop:'2px solid var(--line)' }}>
              <td style={{
                padding:'4px 8px', position:'sticky', left:0, zIndex:1,
                background:'var(--bg-2)', borderTop:'1px solid var(--line)',
              }}>
                <span className="mono uc" style={{ fontSize:9,fontWeight:600,color:'var(--ink-2)' }}>DAILY TOTAL</span>
              </td>
              {ALL_DATES.map(d => {
                const t = dateTotals[d] || { flights:0, hours:0 };
                const isTodayDate = d === today;
                return (
                  <td key={d} style={{
                    textAlign:'center', padding:'3px 2px',
                    background: isTodayDate ? 'color-mix(in oklch,var(--col-pending) 8%,var(--bg-2))' : 'var(--bg-2)',
                    borderLeft:'1px solid var(--line-soft)',
                    borderTop:'1px solid var(--line)',
                  }}>
                    <div className="mono num" style={{ fontSize:isMobile?9:11, fontWeight:600, color:'var(--ink)', lineHeight:1 }}>{t.flights||''}</div>
                    {!isMobile && <div className="mono" style={{ fontSize:7,color:'var(--ink-3)' }}>{t.flights?t.hours.toFixed(0)+'h':''}</div>}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <Drawer/>
    </ArtboardShell>
  );
}

window.RosterBoard = RosterBoard;
