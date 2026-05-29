// Calendar — monthly overview: flight stats, FI/SP leave, per-day detail panel
const { useMemo: useM_cal, useState: useS_cal } = React;

const CAL_DATE_SET  = new Set(ALL_DATES);
const CAL_MON      = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const CAL_FI_NAMES = new Set(FLIGHTS.map(f => f.instructor).filter(Boolean));
const CAL_SP_COLOR = 'oklch(0.72 0.15 280)';

// Helpers
const calFlownMin = f => {
  if (f.status !== 'Completed') return 0;
  if (f.airborne) { const [h,m]=String(f.airborne).split(':').map(Number); return (h||0)*60+(m||0); }
  return f.durMin || 0;
};
const calAbbrev = name => (name||'').split(/[\s.]+/).filter(Boolean)[0]?.slice(0,4).toUpperCase() || '?';
const calHours  = h => h >= 10 ? h.toFixed(0) : h.toFixed(1);

function CalendarBoard() {
  const app = useApp();
  const { isMobile } = app;
  const today = localToday();

  const [calYM,        setCalYM]       = useS_cal(() => today.slice(0,7) + '-01');
  const [ap127Only,    setAp127Only]   = useS_cal(false);
  const [showLeave,    setShowLeave]   = useS_cal(true);
  const [density,      setDensity]     = useS_cal('normal'); // 'compact' | 'normal'
  const [selectedDate, setSelectedDate] = useS_cal(null);

  const calYear  = parseInt(calYM.slice(0,4));
  const calMonth = parseInt(calYM.slice(5,7));

  const goPrev = () => {
    const d = new Date(Date.UTC(calYear, calMonth-2, 1));
    setCalYM(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-01`);
  };
  const goNext = () => {
    const d = new Date(Date.UTC(calYear, calMonth, 1));
    setCalYM(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-01`);
  };
  const goToday = () => { setCalYM(today.slice(0,7) + '-01'); };

  // Per-day stats (respects ap127Only filter)
  const dayStats = useM_cal(() => {
    const prefix = `${calYear}-${String(calMonth).padStart(2,'0')}-`;
    const m = {};
    FLIGHTS.forEach(f => {
      if (!f.date.startsWith(prefix)) return;
      if (ap127Only && f.batch !== HIGHLIGHT_BATCH) return;
      if (!m[f.date]) m[f.date] = { total:0, completed:0, canceled:0, pending:0, ap127:0, schedHours:0, completedHours:0 };
      const s = m[f.date];
      s.total++; s.schedHours += (f.durMin||0)/60; s.completedHours += calFlownMin(f)/60;
      if (f.status==='Completed') s.completed++;
      if (f.status==='Canceled')  s.canceled++;
      if (f.status==='Pending')   s.pending++;
      if (f.batch===HIGHLIGHT_BATCH) s.ap127++;
    });
    return m;
  }, [calYear, calMonth, ap127Only]);

  // Leave info per day in month
  const monthLeaves = useM_cal(() => {
    const daysInMonth = new Date(Date.UTC(calYear, calMonth, 0)).getUTCDate();
    const result = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const lv = leavesOnDate(ds);
      const keys = Object.keys(lv);
      if (keys.length > 0) {
        const fis = keys.filter(n => CAL_FI_NAMES.has(n));
        const sps = keys.filter(n => !CAL_FI_NAMES.has(n));
        result[ds] = { fis, sps, all: lv };
      }
    }
    return result;
  }, [calYear, calMonth]);

  // Month-level summary
  const monthSummary = useM_cal(() => {
    const s = { total:0, completed:0, canceled:0, pending:0, completedHours:0, schedHours:0, ap127:0,
                fiLeaveDays:0, spLeaveDays:0, peakDate:'', peakCount:0 };
    Object.entries(dayStats).forEach(([date, d]) => {
      s.total += d.total; s.completed += d.completed; s.canceled += d.canceled;
      s.pending += d.pending; s.completedHours += d.completedHours;
      s.schedHours += d.schedHours; s.ap127 += d.ap127;
      if (d.total > s.peakCount) { s.peakCount = d.total; s.peakDate = date; }
    });
    Object.values(monthLeaves).forEach(({ fis, sps }) => {
      s.fiLeaveDays += fis.length; s.spLeaveDays += sps.length;
    });
    return s;
  }, [dayStats, monthLeaves]);

  // Calendar grid (Mon-Sun)
  const grid = useM_cal(() => {
    const first  = new Date(Date.UTC(calYear, calMonth-1, 1));
    const offset = (first.getUTCDay() + 6) % 7;
    const days   = new Date(Date.UTC(calYear, calMonth, 0)).getUTCDate();
    const cells  = Array(offset).fill(null);
    for (let d = 1; d <= days; d++)
      cells.push(`${calYear}-${String(calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [calYear, calMonth]);

  // Leave summary by person (for the bottom panel)
  const leaveSummary = useM_cal(() => {
    const fi = {}, sp = {};
    Object.entries(monthLeaves).forEach(([date, { fis, sps }]) => {
      fis.forEach(n => { if (!fi[n]) fi[n] = []; fi[n].push(date); });
      sps.forEach(n => { if (!sp[n]) sp[n] = []; sp[n].push(date); });
    });
    return { fi, sp };
  }, [monthLeaves]);

  // Day detail panel data — computed for any date in dataset
  const panelData = useM_cal(() => {
    if (!selectedDate) return null;
    const all = FLIGHTS.filter(f => f.date === selectedDate)
      .sort((a,b) => (minutesOf(a.start)||0) - (minutesOf(b.start)||0));
    const lv   = leavesOnDate(selectedDate);
    const lvKeys = Object.keys(lv);
    const fis  = lvKeys.filter(n => CAL_FI_NAMES.has(n));
    const sps  = lvKeys.filter(n => !CAL_FI_NAMES.has(n));
    const s    = { total:0, completed:0, canceled:0, pending:0, standby:0, sim:0, completedHours:0, schedHours:0 };
    all.forEach(f => {
      s.total++; s.schedHours += (f.durMin||0)/60; s.completedHours += calFlownMin(f)/60;
      if (f.status==='Completed') s.completed++;
      if (f.status==='Canceled')  s.canceled++;
      if (f.status==='Pending')   s.pending++;
      if (f.isStandby) s.standby++;
      if (f.isSim)     s.sim++;
    });
    const compRate = (s.completed+s.canceled) > 0 ? Math.round(s.completed/(s.completed+s.canceled)*100) : null;
    const ap127 = all.filter(f => f.batch === HIGHLIGHT_BATCH);
    return { all, ap127, fis, sps, lv, stats: s, compRate };
  }, [selectedDate]);

  // ALL_DATES index for panel prev/next navigation
  const panelPrev = selectedDate ? ALL_DATES[ALL_DATES.indexOf(selectedDate) - 1] || null : null;
  const panelNext = selectedDate ? ALL_DATES[ALL_DATES.indexOf(selectedDate) + 1] || null : null;

  const cellH = isMobile ? 58 : (density === 'compact' ? 68 : 96);

  // ── Day detail panel (slide-in from right) ──────────────────────────────
  const DayPanel = () => {
    if (!selectedDate || !panelData) return null;
    const { wd, mo, day, y } = fmtDay(selectedDate);
    const isT  = selectedDate === today;
    const pd   = panelData;
    const s    = pd.stats;
    const compRate = pd.compRate;
    const panelW = isMobile ? '100%' : 360;

    const Sect = ({ title, color, children }) => (
      <div style={{ marginBottom:14 }}>
        <div className="mono uc" style={{ fontSize:9, color: color || 'var(--ink-3)', fontWeight:600, marginBottom:6, paddingBottom:4, borderBottom:'1px solid var(--line-soft)' }}>{title}</div>
        {children}
      </div>
    );

    const StatRow = ({ label, value, color, sub }) => (
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'3px 0' }}>
        <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)', flex:1 }}>{label}</span>
        <span className="mono num" style={{ fontSize:13, fontWeight:600, color: color||'var(--ink)' }}>{value}</span>
        {sub && <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', minWidth:36, textAlign:'right' }}>{sub}</span>}
      </div>
    );

    return (
      <>
        {/* Backdrop */}
        <div onClick={() => setSelectedDate(null)}
          style={{ position:'fixed', inset:0, zIndex:39, background:'oklch(0 0 0 / 0.25)' }}/>

        {/* Panel */}
        <div style={{
          position:'fixed', right:0, top:0, bottom:0,
          width: panelW,
          background:'var(--surface)', borderLeft:'1px solid var(--line)',
          boxShadow:'-12px 0 40px oklch(0 0 0 / 0.45)',
          zIndex:40, display:'flex', flexDirection:'column',
          overflow:'hidden',
        }}>
          {/* Panel header */}
          <div style={{
            padding:'12px 16px', borderBottom:'1px solid var(--line)',
            background:'var(--bg-2)', flexShrink:0,
            display:'flex', alignItems:'flex-start', gap:10,
          }}>
            <div style={{ flex:1 }}>
              <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:3 }}>
                <span className="num" style={{ fontSize:26, fontWeight:700, lineHeight:1, color: isT?'var(--col-pending)':'var(--ink)' }}>{String(day).padStart(2,'0')}</span>
                <div>
                  <div className="mono uc" style={{ fontSize:10, fontWeight:600, color:'var(--ink-2)' }}>{wd}</div>
                  <div className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>{mo} {y}</div>
                </div>
                {isT && <span className="mono uc" style={{ fontSize:7, padding:'2px 6px', border:'1px solid var(--col-pending)', color:'var(--col-pending)', borderRadius:3 }}>TODAY</span>}
              </div>
              {/* Status bar */}
              {s.total > 0 && (
                <div style={{ height:5, display:'flex', borderRadius:3, overflow:'hidden', gap:1 }}>
                  {s.completed > 0 && <div title={`Completed: ${s.completed}`} style={{ flex:s.completed, background:'var(--col-done)', opacity:.85 }}/>}
                  {s.pending   > 0 && <div title={`Pending: ${s.pending}`}     style={{ flex:s.pending,   background:'var(--col-pending)', opacity:.85 }}/>}
                  {s.canceled  > 0 && <div title={`Canceled: ${s.canceled}`}   style={{ flex:s.canceled,  background:'var(--col-cancel)', opacity:.85 }}/>}
                </div>
              )}
            </div>
            <button onClick={() => setSelectedDate(null)}
              style={{ background:'transparent', border:'1px solid var(--line)', borderRadius:4, padding:'3px 8px', cursor:'pointer', color:'var(--ink-3)', fontSize:13, flexShrink:0 }}>✕</button>
          </div>

          {/* Scrollable content */}
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px' }}>

            {/* Flight stats */}
            <Sect title="FLIGHT SUMMARY">
              <div style={{ background:'var(--bg-2)', borderRadius:6, padding:'10px 12px', marginBottom:8 }}>
                <div style={{ display:'flex', gap:8, marginBottom:8 }}>
                  {[
                    { l:'TOTAL',     v:s.total,     c:'var(--ink)' },
                    { l:'✓ DONE',    v:s.completed, c:'var(--col-done)' },
                    { l:'⏳ PEND',   v:s.pending,   c:'var(--col-pending)' },
                    { l:'✗ CNCL',   v:s.canceled,  c:'var(--col-cancel)' },
                  ].map(({ l, v, c }) => (
                    <div key={l} style={{ flex:1, textAlign:'center' }}>
                      <div className="num" style={{ fontSize:20, fontWeight:700, color:c, lineHeight:1 }}>{v}</div>
                      <div className="mono uc" style={{ fontSize:7, color:'var(--ink-3)', marginTop:2 }}>{l}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display:'flex', gap:10, alignItems:'center', fontSize:11 }}>
                  <span className="mono" style={{ color:'var(--col-done)', fontWeight:600 }}>✓ {calHours(s.completedHours)}h flown</span>
                  <span className="mono" style={{ color:'var(--ink-3)' }}>/ {calHours(s.schedHours)}h planned</span>
                  {compRate !== null && <span className="mono uc" style={{ marginLeft:'auto', fontSize:9, color:compRate>=90?'var(--col-done)':compRate>=70?'var(--col-pending)':'var(--col-cancel)', fontWeight:600 }}>{compRate}%</span>}
                </div>
                {(s.sim > 0 || s.standby > 0) && (
                  <div style={{ display:'flex', gap:8, marginTop:5 }}>
                    {s.sim     > 0 && <span className="mono uc" style={{ fontSize:8, padding:'2px 6px', borderRadius:3, background:'color-mix(in oklch,var(--col-sim) 14%,transparent)', color:'var(--col-sim)', border:'1px solid color-mix(in oklch,var(--col-sim) 35%,transparent)' }}>SIM {s.sim}</span>}
                    {s.standby > 0 && <span className="mono uc" style={{ fontSize:8, padding:'2px 6px', borderRadius:3, background:'color-mix(in oklch,var(--col-stby) 14%,transparent)', color:'var(--col-stby)', border:'1px dashed color-mix(in oklch,var(--col-stby) 50%,transparent)' }}>STBY {s.standby}</span>}
                  </div>
                )}
              </div>
            </Sect>

            {/* AP-127 flights */}
            {pd.ap127.length > 0 && (
              <Sect title={`◆ AP-127 FLIGHTS · ${pd.ap127.length}`} color="var(--highlight)">
                <div style={{ display:'flex', flexDirection:'column', gap:4, maxHeight:240, overflowY:'auto' }}>
                  {pd.ap127.map((f, i) => {
                    const col = STATUS_COLOR(f);
                    return (
                      <button key={f.id+i}
                        onClick={() => { app.setDrawer(f.id); }}
                        style={{
                          textAlign:'left', padding:'7px 10px', borderRadius:5, cursor:'pointer',
                          background:`color-mix(in oklch,${col} 8%,var(--bg-2))`,
                          border:`1px solid color-mix(in oklch,${col} 25%,var(--line))`,
                          borderLeft:`3px solid ${col}`, color:'var(--ink)',
                        }}>
                        <div style={{ display:'flex', gap:6, alignItems:'baseline', marginBottom:2 }}>
                          <span className="mono num" style={{ fontSize:11, fontWeight:600 }}>{f.start}</span>
                          <span className="mono uc" style={{ fontSize:8, color:col }}>{f.status}</span>
                          <span style={{ flex:1 }}/>
                          <span className="mono" style={{ fontSize:9, color:'var(--ink-3)' }}>{f.duration||''}</span>
                        </div>
                        <div style={{ fontSize:11, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.student||'—'}</div>
                        <div className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', marginTop:1, display:'flex', gap:5 }}>
                          <span>{f.lesson}</span>
                          {f.instructor && <><span>·</span><span>{f.instructor}</span></>}
                          {f.tail && <><span>·</span><span>{f.tail}</span></>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Sect>
            )}

            {/* FI leave */}
            {pd.fis.length > 0 && (
              <Sect title={`FI ON LEAVE · ${pd.fis.length}`} color="var(--col-stby)">
                <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                  {pd.fis.map(n => (
                    <div key={n} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', borderRadius:5, background:'color-mix(in oklch,var(--col-stby) 8%,var(--bg-2))', border:'1px solid color-mix(in oklch,var(--col-stby) 20%,var(--line))' }}>
                      <span style={{ flex:1, fontSize:11 }}>{n}</span>
                      <span className="mono uc" style={{ fontSize:8, color:'var(--col-stby)' }}>{pd.lv[n]||'ON LEAVE'}</span>
                    </div>
                  ))}
                </div>
              </Sect>
            )}

            {/* SP leave */}
            {pd.sps.length > 0 && (
              <Sect title={`SP ON LEAVE · ${pd.sps.length}`} color={CAL_SP_COLOR}>
                <div style={{ display:'flex', flexDirection:'column', gap:4, maxHeight:200, overflowY:'auto' }}>
                  {pd.sps.map(n => (
                    <div key={n} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', borderRadius:5, background:`color-mix(in oklch,${CAL_SP_COLOR} 8%,var(--bg-2))`, border:`1px solid color-mix(in oklch,${CAL_SP_COLOR} 20%,var(--line))` }}>
                      <span style={{ flex:1, fontSize:11 }}>{n}</span>
                      <span className="mono uc" style={{ fontSize:8, color:CAL_SP_COLOR }}>{pd.lv[n]||'ON LEAVE'}</span>
                    </div>
                  ))}
                </div>
              </Sect>
            )}

            {pd.fis.length === 0 && pd.sps.length === 0 && (
              <div className="mono uc" style={{ fontSize:9, color:'var(--col-done)', padding:'6px 0' }}>NO LEAVE ON THIS DAY</div>
            )}
          </div>

          {/* Panel footer */}
          <div style={{
            padding:'8px 12px', borderTop:'1px solid var(--line)',
            background:'var(--bg-2)', display:'flex', gap:6, alignItems:'center', flexShrink:0,
          }}>
            <button onClick={() => panelPrev && setSelectedDate(panelPrev)}
              disabled={!panelPrev}
              className="mono uc"
              style={{ padding:'5px 10px', fontSize:9, borderRadius:4, cursor:panelPrev?'pointer':'default', border:'1px solid var(--line)', background:'transparent', color:panelPrev?'var(--ink-2)':'var(--ink-3)', opacity:panelPrev?1:0.4 }}>
              ‹ PREV
            </button>
            <button onClick={() => { app.setDate(selectedDate); app.setView('daily'); }}
              className="mono uc"
              style={{ flex:1, padding:'5px 10px', fontSize:9, borderRadius:4, cursor:'pointer', border:'1px solid var(--col-pending)', background:'color-mix(in oklch,var(--col-pending) 12%,transparent)', color:'var(--col-pending)', fontWeight:600 }}>
              OPEN IN DAY GLANCE →
            </button>
            <button onClick={() => panelNext && setSelectedDate(panelNext)}
              disabled={!panelNext}
              className="mono uc"
              style={{ padding:'5px 10px', fontSize:9, borderRadius:4, cursor:panelNext?'pointer':'default', border:'1px solid var(--line)', background:'transparent', color:panelNext?'var(--ink-2)':'var(--ink-3)', opacity:panelNext?1:0.4 }}>
              NEXT ›
            </button>
          </div>
        </div>
      </>
    );
  };

  // ── Calendar cell renderer ───────────────────────────────────────────────
  const renderCell = (date, di) => {
    const dayOfWeek = di % 7; // 0=Mon
    const isWeekend = dayOfWeek >= 5;
    const isToday   = date === today;
    const inRange   = CAL_DATE_SET.has(date);
    const isSel     = date === selectedDate;
    const s         = dayStats[date];
    const lv        = monthLeaves[date];
    const dayNum    = parseInt(date.slice(8));

    const bgBase = isToday
      ? 'color-mix(in oklch,var(--col-pending) 10%,var(--surface))'
      : isSel
        ? 'color-mix(in oklch,var(--col-pending) 6%,var(--surface))'
        : !inRange
          ? 'color-mix(in oklch,var(--ink) 1.5%,var(--bg-2))'
          : 'var(--surface)';

    return (
      <div key={date}
        onClick={() => {
          if (!inRange) return;
          setSelectedDate(d => d === date ? null : date);
        }}
        style={{
          minHeight:cellH,
          borderRight:'1px solid var(--line-soft)',
          padding: isMobile ? '3px 4px' : '5px 6px',
          cursor: inRange ? 'pointer' : 'default',
          background: bgBase,
          position:'relative',
          display:'flex', flexDirection:'column', gap:1,
          borderTop:`2px solid ${isToday ? 'var(--col-pending)' : isSel ? 'color-mix(in oklch,var(--col-pending) 50%,transparent)' : 'transparent'}`,
          transition:'background .1s',
          boxSizing:'border-box',
        }}
        onMouseEnter={e => { if(inRange && !isToday && !isSel) e.currentTarget.style.background = 'color-mix(in oklch,var(--ink) 4%,var(--surface))'; }}
        onMouseLeave={e => { if(!isToday && !isSel) e.currentTarget.style.background = inRange ? 'var(--surface)' : 'color-mix(in oklch,var(--ink) 1.5%,var(--bg-2))'; }}
      >
        {/* Date number row */}
        <div style={{ display:'flex', alignItems:'center', gap:3 }}>
          <span className="num" style={{
            fontSize: isMobile ? 11 : 13, fontWeight: isToday ? 700 : 400, lineHeight:1,
            color: isToday ? 'var(--col-pending)' : isWeekend ? 'color-mix(in oklch,var(--col-cancel) 80%,var(--ink-2))' : 'var(--ink)',
          }}>{dayNum}</span>
          {isToday && !isMobile && (
            <span className="mono uc" style={{ fontSize:6, color:'var(--col-pending)', padding:'1px 3px', border:'1px solid var(--col-pending)', borderRadius:2, lineHeight:1.2 }}>NOW</span>
          )}
          {/* AP-127 badge top-right */}
          {s?.ap127 > 0 && !isMobile && (
            <span style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:2 }}>
              <span style={{ color:'var(--highlight)', fontSize:7, lineHeight:1 }}>◆</span>
              <span className="num" style={{ fontSize:9, color:'var(--highlight)', fontWeight:700 }}>{s.ap127}</span>
            </span>
          )}
        </div>

        {/* Status bar (full width) */}
        {s && s.total > 0 && (
          <div style={{ height:4, display:'flex', borderRadius:2, overflow:'hidden', gap:0.5, flexShrink:0 }}>
            {s.completed > 0 && <div style={{ flex:s.completed, background:'var(--col-done)', opacity:.9 }}/>}
            {s.pending   > 0 && <div style={{ flex:s.pending,   background:'var(--col-pending)', opacity:.9 }}/>}
            {s.canceled  > 0 && <div style={{ flex:s.canceled,  background:'var(--col-cancel)', opacity:.9 }}/>}
          </div>
        )}

        {/* Counts */}
        {s && s.total > 0 && (
          <>
            {!isMobile ? (
              <div style={{ display:'flex', alignItems:'baseline', gap:4 }}>
                <span className="num" style={{ fontSize:density==='compact'?15:18, fontWeight:700, color:'var(--ink)', lineHeight:1 }}>{s.total}</span>
                <span className="mono uc" style={{ fontSize:7, color:'var(--ink-3)' }}>FLT</span>
                {s.completedHours > 0.05 && (
                  <span className="num" style={{ fontSize:9, color:'var(--col-done)', marginLeft:2 }}>✓{calHours(s.completedHours)}h</span>
                )}
              </div>
            ) : (
              <span className="num" style={{ fontSize:14, fontWeight:700, color:'var(--ink)', lineHeight:1 }}>{s.total}</span>
            )}

            {/* Completion % (normal density, desktop) */}
            {density === 'normal' && !isMobile && (
              <div style={{ display:'flex', alignItems:'center', gap:3 }}>
                {s.completed > 0 && <span className="num" style={{ fontSize:9, color:'var(--col-done)' }}>✓{s.completed}</span>}
                {s.pending   > 0 && <span className="num" style={{ fontSize:9, color:'var(--col-pending)' }}>⏳{s.pending}</span>}
                {s.canceled  > 0 && <span className="num" style={{ fontSize:9, color:'var(--col-cancel)' }}>✗{s.canceled}</span>}
              </div>
            )}
          </>
        )}

        {/* Leave indicators */}
        {showLeave && lv && !isMobile && (
          <div style={{ marginTop:'auto', display:'flex', flexDirection:'column', gap:2 }}>
            {lv.fis.length > 0 && (
              <div style={{ display:'flex', gap:2, flexWrap:'wrap', alignItems:'center' }}>
                {lv.fis.slice(0, density==='compact' ? 2 : 3).map(n => (
                  <span key={n} title={n} className="mono"
                    style={{ fontSize:7, padding:'1px 4px', borderRadius:3, lineHeight:1.4,
                      background:'color-mix(in oklch,var(--col-stby) 16%,transparent)',
                      color:'var(--col-stby)', border:'1px solid color-mix(in oklch,var(--col-stby) 35%,transparent)',
                      cursor:'default', whiteSpace:'nowrap' }}>
                    {calAbbrev(n)}
                  </span>
                ))}
                {lv.fis.length > (density==='compact' ? 2 : 3) && (
                  <span className="mono" style={{ fontSize:7, color:'var(--col-stby)', opacity:.7 }}>
                    +{lv.fis.length - (density==='compact' ? 2 : 3)}
                  </span>
                )}
              </div>
            )}
            {lv.sps.length > 0 && (
              <div style={{ display:'flex', gap:2, flexWrap:'wrap', alignItems:'center' }}>
                {lv.sps.slice(0, density==='compact' ? 2 : 3).map(n => (
                  <span key={n} title={n} className="mono"
                    style={{ fontSize:7, padding:'1px 4px', borderRadius:3, lineHeight:1.4,
                      background:`color-mix(in oklch,${CAL_SP_COLOR} 16%,transparent)`,
                      color: CAL_SP_COLOR, border:`1px solid color-mix(in oklch,${CAL_SP_COLOR} 35%,transparent)`,
                      cursor:'default', whiteSpace:'nowrap' }}>
                    {calAbbrev(n)}
                  </span>
                ))}
                {lv.sps.length > (density==='compact' ? 2 : 3) && (
                  <span className="mono" style={{ fontSize:7, color:CAL_SP_COLOR, opacity:.7 }}>
                    +{lv.sps.length - (density==='compact' ? 2 : 3)}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {/* Mobile leave dot */}
        {showLeave && lv && isMobile && (lv.fis.length + lv.sps.length) > 0 && (
          <div style={{ display:'flex', gap:2, marginTop:'auto' }}>
            {lv.fis.length > 0 && <span style={{ width:5, height:5, borderRadius:999, background:'var(--col-stby)', flexShrink:0 }}/>}
            {lv.sps.length > 0 && <span style={{ width:5, height:5, borderRadius:999, background:CAL_SP_COLOR, flexShrink:0 }}/>}
          </div>
        )}
      </div>
    );
  };

  // ── Chip helper ─────────────────────────────────────────────────────────
  const Chip = ({ on, onClick, children, color='var(--ink-2)' }) => (
    <button onClick={onClick} className="mono uc" style={{
      padding:'3px 8px', fontSize:9, borderRadius:4, cursor:'pointer',
      border:`1px solid ${on ? color : 'var(--line)'}`,
      background: on ? `color-mix(in oklch,${color} 14%,var(--surface))` : 'transparent',
      color: on ? color : 'var(--ink-3)', fontWeight: on ? 600 : 400, transition:'all .1s',
      whiteSpace:'nowrap',
    }}>{children}</button>
  );

  const compRate = monthSummary.total > 0
    ? Math.round(monthSummary.completed / (monthSummary.completed + monthSummary.canceled) * 100 || 0) : 0;

  return (
    <ArtboardShell style={{ display:'flex', flexDirection:'column' }}>
      <ThemeStyle/>

      {/* Header */}
      <div style={{
        minHeight:38, padding:'0 10px', borderBottom:'1px solid var(--line)',
        background:'var(--bg-2)', display:'flex', alignItems:'center', gap:6,
        flexShrink:0, flexWrap:'wrap',
      }}>
        <span style={{ width:8, height:8, borderRadius:999, background:'var(--col-pending)', boxShadow:'0 0 8px var(--col-pending)', flexShrink:0 }}/>
        <ViewIcon id="calendar" size={12} color="var(--ink-2)"/>
        <div className="mono uc" style={{ fontSize:11, fontWeight:600 }}>CALENDAR</div>

        {/* Month nav */}
        <div style={{ display:'flex', gap:3, alignItems:'center', marginLeft:4 }}>
          <button onClick={goPrev} className="mono" style={{ padding:'3px 8px', fontSize:12, borderRadius:4, cursor:'pointer', border:'1px solid var(--line)', background:'transparent', color:'var(--ink-2)' }}>‹</button>
          <span className="mono uc" style={{ fontSize:11, fontWeight:600, color:'var(--ink)', minWidth:100, textAlign:'center' }}>{CAL_MON[calMonth-1]} {calYear}</span>
          <button onClick={goNext} className="mono" style={{ padding:'3px 8px', fontSize:12, borderRadius:4, cursor:'pointer', border:'1px solid var(--line)', background:'transparent', color:'var(--ink-2)' }}>›</button>
          <button onClick={goToday} className="mono uc" style={{ padding:'2px 6px', fontSize:8, borderRadius:3, cursor:'pointer', border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)', marginLeft:1 }}>TODAY</button>
        </div>

        <div style={{ width:1, height:18, background:'var(--line)', flexShrink:0, marginLeft:2 }}/>

        {/* View controls */}
        {!isMobile && (
          <div style={{ display:'flex', gap:4, alignItems:'center', flexShrink:0 }}>
            <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>DENSITY</span>
            <Chip on={density==='compact'} onClick={()=>setDensity('compact')} color="var(--ink-2)">COMPACT</Chip>
            <Chip on={density==='normal'}  onClick={()=>setDensity('normal')}  color="var(--ink-2)">NORMAL</Chip>
          </div>
        )}

        <Chip on={ap127Only} onClick={()=>setAp127Only(v=>!v)} color="var(--highlight)">◆ AP-127</Chip>
        <Chip on={showLeave} onClick={()=>setShowLeave(v=>!v)} color="var(--col-stby)">LEAVE</Chip>

        <div style={{flex:1}}/>
        <RefreshButton/>
        <LastUpdate/>
      </div>

      {/* Body */}
      <div style={{ flex:1, minHeight:0, overflowY:'auto' }}>
        <div style={{ padding: isMobile?'6px':'10px 14px', display:'flex', flexDirection:'column', gap:10 }}>

          {/* Month summary strip */}
          {monthSummary.total > 0 && (() => {
            const items = [
              { l:'FLIGHTS',   v:monthSummary.total,                       c:'var(--ink)' },
              { l:'✓ DONE',    v:monthSummary.completed,                   c:'var(--col-done)' },
              { l:'HRS ✓',     v:calHours(monthSummary.completedHours)+'h',c:'var(--col-done)' },
              { l:'RATE',      v:compRate+'%',                             c:compRate>=90?'var(--col-done)':compRate>=70?'var(--col-pending)':'var(--col-cancel)' },
              { l:'◆ AP-127',  v:monthSummary.ap127,                       c:'var(--highlight)' },
              { l:'FI LEAVE',  v:monthSummary.fiLeaveDays+'d',             c:'var(--col-stby)' },
              { l:'SP LEAVE',  v:monthSummary.spLeaveDays+'d',             c:CAL_SP_COLOR },
            ];
            // On mobile use 2-row grid, desktop single flex row
            return isMobile ? (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', background:'var(--surface)', border:'1px solid var(--line)', borderRadius:7, overflow:'hidden' }}>
                {items.map(({ l, v, c }, i) => (
                  <div key={l} style={{ padding:'6px 8px', textAlign:'center', borderRight:'1px solid var(--line-soft)', borderBottom: i < 4 ? '1px solid var(--line-soft)' : 'none' }}>
                    <div className="mono uc" style={{ fontSize:6, color:'var(--ink-3)', marginBottom:1 }}>{l}</div>
                    <div className="mono num" style={{ fontSize:13, fontWeight:700, color:c, lineHeight:1 }}>{v}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display:'flex', background:'var(--surface)', border:'1px solid var(--line)', borderRadius:7, overflow:'hidden', flexShrink:0 }}>
                {items.map(({ l, v, c }) => (
                  <div key={l} style={{ flex:1, padding:'7px 10px', textAlign:'center', borderRight:'1px solid var(--line-soft)' }}>
                    <div className="mono uc" style={{ fontSize:7, color:'var(--ink-3)', marginBottom:2 }}>{l}</div>
                    <div className="mono num" style={{ fontSize:16, fontWeight:700, color:c, lineHeight:1 }}>{v}</div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Calendar grid */}
          <div style={{ background:'var(--surface)', border:'1px solid var(--line)', borderRadius:8, overflow:'hidden', flexShrink:0 }}>
            {/* Day-of-week header */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', borderBottom:'1px solid var(--line)', background:'var(--bg-2)' }}>
              {['MON','TUE','WED','THU','FRI','SAT','SUN'].map(d => (
                <div key={d} className="mono uc" style={{
                  textAlign:'center', padding:'6px 2px', fontSize:8,
                  color: d==='SAT'||d==='SUN' ? 'var(--col-cancel)' : 'var(--ink-3)',
                  borderRight:'1px solid var(--line-soft)',
                }}>{d}</div>
              ))}
            </div>

            {/* Weeks */}
            {Array.from({ length: Math.ceil(grid.length/7) }, (_,wi) => (
              <div key={wi} style={{
                display:'grid', gridTemplateColumns:'repeat(7,1fr)',
                borderBottom: wi < Math.ceil(grid.length/7)-1 ? '1px solid var(--line-soft)' : 'none',
              }}>
                {grid.slice(wi*7, wi*7+7).map((date, di) => (
                  date
                    ? renderCell(date, wi*7+di)
                    : <div key={di} style={{ minHeight:cellH, background:'color-mix(in oklch,var(--ink) 1.5%,var(--bg-2))', borderRight:'1px solid var(--line-soft)' }}/>
                ))}
              </div>
            ))}
          </div>

          {/* Legend */}
          <div style={{ display:'flex', gap:10, flexWrap:'wrap', padding:'2px 0', alignItems:'center' }}>
            {[
              ['var(--col-done)',    '✓ Completed'],
              ['var(--col-pending)', '⏳ Pending'],
              ['var(--col-cancel)',  '✗ Canceled'],
              ['var(--highlight)',   '◆ AP-127'],
              ['var(--col-stby)',    'FI leave'],
              [CAL_SP_COLOR,        'SP leave'],
            ].map(([c,l]) => (
              <div key={l} style={{ display:'flex', gap:5, alignItems:'center' }}>
                <span style={{ width:10, height:4, borderRadius:2, background:c, flexShrink:0, opacity:.85 }}/>
                <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>{l}</span>
              </div>
            ))}
            <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', marginLeft:'auto' }}>
              CLICK DAY FOR DETAIL
            </span>
          </div>

          {/* Leave summary table */}
          {(Object.keys(leaveSummary.fi).length > 0 || Object.keys(leaveSummary.sp).length > 0) && (
            <div style={{ display:'grid', gridTemplateColumns: isMobile?'1fr':'repeat(2,1fr)', gap:10 }}>

              {Object.keys(leaveSummary.fi).length > 0 && (
                <div style={{ background:'var(--surface)', border:'1px solid var(--line)', borderRadius:8, overflow:'hidden' }}>
                  <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', borderLeft:'3px solid var(--col-stby)' }}>
                    <span className="mono uc" style={{ fontSize:10, color:'var(--col-stby)', fontWeight:600 }}>
                      FI ON LEAVE — {CAL_MON[calMonth-1]} {calYear}
                    </span>
                  </div>
                  <div style={{ padding:'8px 14px', display:'flex', flexDirection:'column', gap:4, maxHeight:200, overflowY:'auto' }}>
                    {Object.entries(leaveSummary.fi).sort(([a],[b])=>a.localeCompare(b)).map(([name, dates]) => {
                      const sorted = [...dates].sort();
                      const range = sorted.length === 1
                        ? `${parseInt(sorted[0].slice(8))} ${CAL_MON[calMonth-1]}`
                        : `${parseInt(sorted[0].slice(8))}–${parseInt(sorted[sorted.length-1].slice(8))} ${CAL_MON[calMonth-1]}`;
                      return (
                        <div key={name} style={{ display:'flex', alignItems:'center', gap:8, padding:'3px 0' }}>
                          <span style={{ flex:1, fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</span>
                          <span className="mono" style={{ fontSize:8, color:'var(--col-stby)', flexShrink:0 }}>{dates.length}d</span>
                          <span className="mono" style={{ fontSize:9, color:'var(--ink-3)', flexShrink:0 }}>{range}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {Object.keys(leaveSummary.sp).length > 0 && (
                <div style={{ background:'var(--surface)', border:'1px solid var(--line)', borderRadius:8, overflow:'hidden' }}>
                  <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', borderLeft:`3px solid ${CAL_SP_COLOR}` }}>
                    <span className="mono uc" style={{ fontSize:10, color:CAL_SP_COLOR, fontWeight:600 }}>
                      SP ON LEAVE — {CAL_MON[calMonth-1]} {calYear}
                    </span>
                  </div>
                  <div style={{ padding:'8px 14px', display:'flex', flexDirection:'column', gap:4, maxHeight:200, overflowY:'auto' }}>
                    {Object.entries(leaveSummary.sp).sort(([a],[b])=>a.localeCompare(b)).map(([name, dates]) => {
                      const sorted = [...dates].sort();
                      const range = sorted.length === 1
                        ? `${parseInt(sorted[0].slice(8))} ${CAL_MON[calMonth-1]}`
                        : `${parseInt(sorted[0].slice(8))}–${parseInt(sorted[sorted.length-1].slice(8))} ${CAL_MON[calMonth-1]}`;
                      return (
                        <div key={name} style={{ display:'flex', alignItems:'center', gap:8, padding:'3px 0' }}>
                          <span style={{ flex:1, fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</span>
                          <span className="mono" style={{ fontSize:8, color:CAL_SP_COLOR, flexShrink:0 }}>{dates.length}d</span>
                          <span className="mono" style={{ fontSize:9, color:'var(--ink-3)', flexShrink:0 }}>{range}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ height:8 }}/>
        </div>
      </div>

      {/* Day detail panel */}
      <DayPanel/>
      <Drawer/>
    </ArtboardShell>
  );
}

window.CalendarBoard = CalendarBoard;
