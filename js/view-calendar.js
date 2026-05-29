// Calendar — monthly overview: flight stats, FI/SP leave status, AP-127 filter
const { useMemo: useM_cal, useState: useS_cal } = React;

const CAL_DATE_SET = new Set(ALL_DATES);
const CAL_MON_NAMES = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Build set of all FI names once (from full flight dataset)
const CAL_ALL_FI_NAMES = new Set(FLIGHTS.map(f => f.instructor).filter(Boolean));

// Helper: actual flown minutes for a completed flight
const calFlownMin = f => {
  if (f.status !== 'Completed') return 0;
  if (f.airborne) { const [h,m]=String(f.airborne).split(':').map(Number); return (h||0)*60+(m||0); }
  return f.durMin || 0;
};

function CalendarBoard() {
  const app = useApp();
  const { isMobile } = app;
  const today = localToday();

  // Calendar navigation state — month is tracked as YYYY-MM-01 string
  const [calYM, setCalYM] = useS_cal(() => {
    const t = localToday();
    return t.slice(0,7) + '-01';
  });
  const [ap127Only, setAp127Only] = useS_cal(false);

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

  // Per-day stats for the visible month
  const dayStats = useM_cal(() => {
    const prefix = `${calYear}-${String(calMonth).padStart(2,'0')}-`;
    const m = {};
    FLIGHTS.forEach(f => {
      if (!f.date.startsWith(prefix)) return;
      if (ap127Only && f.batch !== HIGHLIGHT_BATCH) return;
      if (!m[f.date]) m[f.date] = { total:0, completed:0, canceled:0, pending:0, ap127:0, schedHours:0, completedHours:0 };
      const s = m[f.date];
      s.total++;
      s.schedHours += (f.durMin||0)/60;
      s.completedHours += calFlownMin(f)/60;
      if (f.status==='Completed') s.completed++;
      if (f.status==='Canceled')  s.canceled++;
      if (f.status==='Pending')   s.pending++;
      if (f.batch===HIGHLIGHT_BATCH) s.ap127++;
    });
    return m;
  }, [calYear, calMonth, ap127Only]);

  // Leave info per day in current month
  const monthLeaves = useM_cal(() => {
    const daysInMonth = new Date(Date.UTC(calYear, calMonth, 0)).getUTCDate();
    const result = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const lv = leavesOnDate(ds);
      const keys = Object.keys(lv);
      if (keys.length > 0) {
        const fis = keys.filter(n => CAL_ALL_FI_NAMES.has(n));
        const sps = keys.filter(n => !CAL_ALL_FI_NAMES.has(n));
        result[ds] = { fis, sps, all: lv };
      }
    }
    return result;
  }, [calYear, calMonth]);

  // Build Mon-Sun calendar grid
  const grid = useM_cal(() => {
    const first  = new Date(Date.UTC(calYear, calMonth-1, 1));
    const offset = (first.getUTCDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(Date.UTC(calYear, calMonth, 0)).getUTCDate();
    const cells = Array(offset).fill(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(`${calYear}-${String(calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    }
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [calYear, calMonth]);

  // Leave summary for bottom panel
  const leaveSummary = useM_cal(() => {
    const fiMap = {}, spMap = {};
    Object.entries(monthLeaves).forEach(([date, { fis, sps }]) => {
      fis.forEach(n => { if (!fiMap[n]) fiMap[n] = []; fiMap[n].push(date); });
      sps.forEach(n => { if (!spMap[n]) spMap[n] = []; spMap[n].push(date); });
    });
    return { fiMap, spMap };
  }, [monthLeaves]);

  const cellH = isMobile ? 52 : 80;

  return (
    <ArtboardShell style={{ display:'flex', flexDirection:'column' }}>
      <ThemeStyle/>

      {/* Header */}
      <div style={{
        minHeight:38, padding:'0 14px', borderBottom:'1px solid var(--line)',
        background:'var(--bg-2)', display:'flex', alignItems:'center', gap:8,
        flexShrink:0, flexWrap:'wrap',
      }}>
        <span style={{ width:8, height:8, borderRadius:999, background:'var(--col-pending)', boxShadow:'0 0 8px var(--col-pending)' }}/>
        <ViewIcon id="calendar" size={12} color="var(--ink-2)"/>
        <div className="mono uc" style={{ fontSize:11, fontWeight:600 }}>CALENDAR</div>

        {/* Month navigation */}
        <div style={{ display:'flex', gap:4, alignItems:'center', marginLeft:6 }}>
          <button onClick={goPrev} className="mono" style={{
            padding:'3px 9px', fontSize:12, borderRadius:4, cursor:'pointer',
            border:'1px solid var(--line)', background:'transparent', color:'var(--ink-2)',
          }}>‹</button>
          <span className="mono uc" style={{ fontSize:11, fontWeight:600, color:'var(--ink)', minWidth:108, textAlign:'center' }}>
            {CAL_MON_NAMES[calMonth-1]} {calYear}
          </span>
          <button onClick={goNext} className="mono" style={{
            padding:'3px 9px', fontSize:12, borderRadius:4, cursor:'pointer',
            border:'1px solid var(--line)', background:'transparent', color:'var(--ink-2)',
          }}>›</button>
          <button onClick={goToday} className="mono uc" style={{
            padding:'2px 7px', fontSize:8, borderRadius:3, cursor:'pointer',
            border:'1px solid var(--line)', background:'transparent', color:'var(--ink-3)',
            marginLeft:2,
          }}>TODAY</button>
        </div>

        {/* AP-127 only toggle */}
        <button onClick={() => setAp127Only(v => !v)} className="mono uc" style={{
          padding:'3px 8px', fontSize:9, borderRadius:4, cursor:'pointer',
          border:`1px solid ${ap127Only?'var(--highlight)':'var(--line)'}`,
          background: ap127Only?'color-mix(in oklch,var(--highlight) 14%,transparent)':'transparent',
          color: ap127Only?'var(--highlight)':'var(--ink-3)',
          fontWeight: ap127Only?600:400,
        }}>◆ AP-127 ONLY</button>

        <div style={{flex:1}}/>
        <RefreshButton/>
        <LastUpdate/>
      </div>

      {/* Body */}
      <div style={{ flex:1, minHeight:0, overflowY:'auto' }}>
        <div style={{ padding: isMobile?'8px':'12px 16px', display:'flex', flexDirection:'column', gap:12 }}>

          {/* Calendar grid */}
          <div style={{ background:'var(--surface)', border:'1px solid var(--line)', borderRadius:8, overflow:'hidden' }}>

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
            {Array.from({length: Math.ceil(grid.length/7)}, (_,wi) => (
              <div key={wi} style={{
                display:'grid', gridTemplateColumns:'repeat(7,1fr)',
                borderBottom: wi < Math.ceil(grid.length/7)-1 ? '1px solid var(--line-soft)' : 'none',
              }}>
                {grid.slice(wi*7, wi*7+7).map((date, di) => {
                  const weekday = wi*7+di; // 0=Mon … 6=Sun
                  const isWeekend = weekday%7 >= 5;

                  if (!date) return (
                    <div key={di} style={{
                      minHeight:cellH,
                      background:'color-mix(in oklch,var(--ink) 1.5%,var(--bg-2))',
                      borderRight:'1px solid var(--line-soft)',
                    }}/>
                  );

                  const isToday   = date === today;
                  const inRange   = CAL_DATE_SET.has(date);
                  const s         = dayStats[date];
                  const lv        = monthLeaves[date];
                  const dayNum    = parseInt(date.slice(8));
                  const compDone  = s?.completed || 0;
                  const compRate  = s && (s.completed+s.canceled) > 0
                    ? Math.round(s.completed/(s.completed+s.canceled)*100) : null;

                  return (
                    <div key={date}
                      onClick={() => {
                        if (inRange) {
                          app.setDate(date);
                          app.setView('daily');
                        }
                      }}
                      style={{
                        minHeight:cellH,
                        borderRight:'1px solid var(--line-soft)',
                        padding: isMobile?'3px 4px':'4px 6px',
                        cursor: inRange ? 'pointer' : 'default',
                        background: isToday
                          ? 'color-mix(in oklch,var(--col-pending) 12%,var(--surface))'
                          : !inRange
                            ? 'color-mix(in oklch,var(--ink) 1%,var(--bg-2))'
                            : 'var(--surface)',
                        position:'relative',
                        transition:'background .1s',
                        display:'flex', flexDirection:'column',
                        borderTop: isToday ? '2px solid var(--col-pending)' : '2px solid transparent',
                      }}
                      onMouseEnter={e => { if(inRange) e.currentTarget.style.background = isToday?'color-mix(in oklch,var(--col-pending) 18%,var(--surface))':'color-mix(in oklch,var(--ink) 5%,var(--surface))'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = isToday?'color-mix(in oklch,var(--col-pending) 12%,var(--surface))':!inRange?'color-mix(in oklch,var(--ink) 1%,var(--bg-2))':'var(--surface)'; }}
                    >
                      {/* Date number row */}
                      <div style={{ display:'flex', alignItems:'center', gap:3, marginBottom:isMobile?1:3 }}>
                        <span className="num" style={{
                          fontSize: isMobile?11:14, fontWeight: isToday?700:400, lineHeight:1,
                          color: isToday?'var(--col-pending)':isWeekend?'color-mix(in oklch,var(--col-cancel) 75%,var(--ink-2))':'var(--ink)',
                        }}>{dayNum}</span>
                        {isToday && !isMobile && (
                          <span className="mono uc" style={{ fontSize:6, color:'var(--col-pending)', padding:'1px 3px', border:'1px solid var(--col-pending)', borderRadius:2, lineHeight:1 }}>NOW</span>
                        )}
                      </div>

                      {/* Flight stats */}
                      {s && s.total > 0 && (
                        <>
                          {!isMobile && (
                            <div style={{ display:'flex', gap:4, alignItems:'baseline', marginBottom:2 }}>
                              <span className="num" style={{ fontSize:16, fontWeight:700, color:'var(--ink)', lineHeight:1 }}>{s.total}</span>
                              <span className="mono uc" style={{ fontSize:7, color:'var(--ink-3)' }}>FLT</span>
                              {s.completedHours > 0 && (
                                <span className="num" style={{ fontSize:9, color:'var(--col-done)', marginLeft:2 }}>
                                  {s.completedHours.toFixed(1)}h
                                </span>
                              )}
                            </div>
                          )}
                          {isMobile && (
                            <span className="num" style={{ fontSize:13, fontWeight:700, color:'var(--ink)', lineHeight:1 }}>{s.total}</span>
                          )}

                          {/* Completion mini-bar */}
                          {compRate !== null && !isMobile && (
                            <div style={{ display:'flex', gap:3, alignItems:'center', marginBottom:2 }}>
                              <div style={{ flex:1, height:3, background:'var(--bg-2)', borderRadius:2, overflow:'hidden' }}>
                                <div style={{ width:`${compRate}%`, height:'100%', background:'var(--col-done)', opacity:.85 }}/>
                              </div>
                              <span className="mono num" style={{ fontSize:7, color:'var(--col-done)', flexShrink:0 }}>{compRate}%</span>
                            </div>
                          )}

                          {/* AP-127 count */}
                          {s.ap127 > 0 && !isMobile && (
                            <div style={{ display:'flex', gap:3, alignItems:'center', marginBottom:2 }}>
                              <span style={{ color:'var(--highlight)', fontSize:8, lineHeight:1 }}>◆</span>
                              <span className="num" style={{ fontSize:10, color:'var(--highlight)', fontWeight:600 }}>{s.ap127}</span>
                            </div>
                          )}
                        </>
                      )}

                      {/* Leave indicators */}
                      {lv && !isMobile && (
                        <div style={{ display:'flex', gap:3, marginTop:'auto', paddingTop:2, flexWrap:'wrap' }}>
                          {lv.fis.length > 0 && (
                            <span className="mono uc" title={`FI on leave: ${lv.fis.join(', ')}`}
                              style={{ fontSize:6, color:'var(--col-stby)', padding:'0 3px', background:'color-mix(in oklch,var(--col-stby) 12%,transparent)', borderRadius:2, lineHeight:1.6 }}>
                              FI {lv.fis.length}
                            </span>
                          )}
                          {lv.sps.length > 0 && (
                            <span className="mono uc" title={`SP on leave: ${lv.sps.join(', ')}`}
                              style={{ fontSize:6, color:'oklch(0.72 0.15 280)', padding:'0 3px', background:'color-mix(in oklch,oklch(0.72 0.15 280) 12%,transparent)', borderRadius:2, lineHeight:1.6 }}>
                              SP {lv.sps.length}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Legend */}
          <div style={{ display:'flex', gap:12, flexWrap:'wrap', padding:'4px 0' }}>
            <div className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>LEGEND:</div>
            {[
              ['var(--col-done)',     'Completed hrs'],
              ['var(--highlight)',    '◆ AP-127'],
              ['var(--col-stby)',     'FI leave'],
              ['oklch(0.72 0.15 280)','SP leave'],
            ].map(([c,l]) => (
              <div key={l} style={{ display:'flex', gap:5, alignItems:'center' }}>
                <span style={{ width:9, height:9, borderRadius:2, background:c, flexShrink:0, opacity:.85 }}/>
                <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)' }}>{l}</span>
              </div>
            ))}
            <span className="mono uc" style={{ fontSize:8, color:'var(--ink-3)', marginLeft:'auto' }}>CLICK DAY → DAY GLANCE</span>
          </div>

          {/* Leave summary panels */}
          {(Object.keys(leaveSummary.fiMap).length > 0 || Object.keys(leaveSummary.spMap).length > 0) && (
            <div style={{ display:'grid', gridTemplateColumns: isMobile?'1fr':'repeat(2,1fr)', gap:12 }}>

              {/* FI leave summary */}
              {Object.keys(leaveSummary.fiMap).length > 0 && (
                <div style={{ background:'var(--surface)', border:'1px solid var(--line)', borderRadius:8, overflow:'hidden' }}>
                  <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', borderLeft:'3px solid var(--col-stby)' }}>
                    <div className="mono uc" style={{ fontSize:10, color:'var(--col-stby)', fontWeight:600 }}>
                      FI ON LEAVE — {CAL_MON_NAMES[calMonth-1]} {calYear}
                    </div>
                  </div>
                  <div style={{ padding:'10px 14px', display:'flex', flexDirection:'column', gap:5, maxHeight:200, overflowY:'auto' }}>
                    {Object.entries(leaveSummary.fiMap)
                      .sort(([a],[b]) => a.localeCompare(b))
                      .map(([name, dates]) => {
                        const sortedD = [...dates].sort();
                        // Compact date range display
                        const rangeLabel = sortedD.length === 1
                          ? `${parseInt(sortedD[0].slice(8))} ${CAL_MON_NAMES[calMonth-1]}`
                          : `${parseInt(sortedD[0].slice(8))}–${parseInt(sortedD[sortedD.length-1].slice(8))} ${CAL_MON_NAMES[calMonth-1]}`;
                        return (
                          <div key={name} style={{ display:'flex', gap:8, alignItems:'center' }}>
                            <span style={{ flex:1, fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</span>
                            <span className="mono uc" style={{ fontSize:8, color:'var(--col-stby)', flexShrink:0 }}>{dates.length}d</span>
                            <span className="mono" style={{ fontSize:9, color:'var(--ink-3)', flexShrink:0 }}>{rangeLabel}</span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* SP leave summary */}
              {Object.keys(leaveSummary.spMap).length > 0 && (
                <div style={{ background:'var(--surface)', border:'1px solid var(--line)', borderRadius:8, overflow:'hidden' }}>
                  <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', borderLeft:'3px solid oklch(0.72 0.15 280)' }}>
                    <div className="mono uc" style={{ fontSize:10, color:'oklch(0.72 0.15 280)', fontWeight:600 }}>
                      SP ON LEAVE — {CAL_MON_NAMES[calMonth-1]} {calYear}
                    </div>
                  </div>
                  <div style={{ padding:'10px 14px', display:'flex', flexDirection:'column', gap:5, maxHeight:200, overflowY:'auto' }}>
                    {Object.entries(leaveSummary.spMap)
                      .sort(([a],[b]) => a.localeCompare(b))
                      .map(([name, dates]) => {
                        const sortedD = [...dates].sort();
                        const rangeLabel = sortedD.length === 1
                          ? `${parseInt(sortedD[0].slice(8))} ${CAL_MON_NAMES[calMonth-1]}`
                          : `${parseInt(sortedD[0].slice(8))}–${parseInt(sortedD[sortedD.length-1].slice(8))} ${CAL_MON_NAMES[calMonth-1]}`;
                        return (
                          <div key={name} style={{ display:'flex', gap:8, alignItems:'center' }}>
                            <span style={{ flex:1, fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</span>
                            <span className="mono uc" style={{ fontSize:8, color:'oklch(0.72 0.15 280)', flexShrink:0 }}>{dates.length}d</span>
                            <span className="mono" style={{ fontSize:9, color:'var(--ink-3)', flexShrink:0 }}>{rangeLabel}</span>
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

      <Drawer/>
    </ArtboardShell>
  );
}

window.CalendarBoard = CalendarBoard;
