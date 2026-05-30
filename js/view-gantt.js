// Gantt timeline — rows = instructor / tail / batch
const { useMemo: useM_g } = React;

const HOUR_START     = 6;
const HOUR_END_MIN   = 18; // minimum end — extends dynamically if flights run later

// Helper: detect non-flight activities (meetings, briefings, ground school)
const isMeetingFlt = f => /meeting|briefing|debrief|ground.school/i.test(f.lesson || '') || /meeting|recurrent/i.test(f.batch || '');

// Set of all instructor names across full dataset (computed once)
const ALL_GANTT_FI_NAMES = new Set(FLIGHTS.map(f => f.instructor).filter(Boolean));

function GanttBoard() {
  const app      = useApp();
  const { isMobile } = app;
  const groupBy  = app.tweaks.groupBy || 'instructor';
  const TRACK_LEFT  = isMobile ? 90  : 190;
  const TRACK_RIGHT = isMobile ? 64  : 180;
  const PX_PER_HOUR = 60; // minimum px per hour — drives horizontal scroll width

  // Override dayFlights: include ALL activity types (bypass showSim filter)
  const flights = useM_g(() => {
    const { date, filters, hideOthers, highlightAP127 } = app;
    return FLIGHTS.filter(x => {
      if (x.date !== date) return false;
      // intentionally omit showSim/showStandby filters — GANTT shows all activity types
      if (filters.batches     && !filters.batches.includes(x.batch))          return false;
      if (filters.instructors && !filters.instructors.includes(x.instructor))  return false;
      if (filters.tails       && !filters.tails.includes(x.tail))              return false;
      if (filters.statuses) {
        const matchStatus = filters.statuses.includes(x.status);
        const matchStby   = filters.statuses.includes('Standby') && x.isStandby;
        if (!matchStatus && !matchStby) return false;
      }
      if (hideOthers && highlightAP127 && x.batch !== HIGHLIGHT_BATCH) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const hay = [x.student, x.instructor, x.batch, x.lesson, x.tail, x.type].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [app.date, app.filters, app.hideOthers, app.highlightAP127]);

  // Extend end hour to cover late flights (e.g. 19:00, 20:00)
  const hourEnd = useM_g(() => {
    let maxMin = HOUR_END_MIN * 60;
    flights.forEach(f => { const e = minutesOf(f.end); if (e) maxMin = Math.max(maxMin, e); });
    return Math.max(HOUR_END_MIN, Math.ceil(maxMin / 60));
  }, [flights]);
  const hourSpan = hourEnd - HOUR_START;

  const rows = useM_g(()=>{
    const map = {};
    flights.forEach(f=>{
      const key = (groupBy==='instructor'?f.instructor:groupBy==='tail'?f.tail:f.batch)||'—';
      (map[key]||(map[key]=[])).push(f);

      // In instructor view: if the student is also a known FI, add this flight to their row too
      // (shows the FI is busy as a student pilot during this time)
      if (groupBy === 'instructor' && f.student && f.student !== key && ALL_GANTT_FI_NAMES.has(f.student)) {
        const fiKey = f.student;
        (map[fiKey]||(map[fiKey]=[])).push({ ...f, _asFiStudent: true });
      }
    });
    return Object.entries(map)
      .map(([k,v])=>({ key:k, flights:v.sort((a,b)=>(minutesOf(a.start)||0)-(minutesOf(b.start)||0)) }))
      .sort((a,b)=>{
        // Tail focus: sort by aircraft type first, then tail number alphabetically
        if (groupBy === 'tail') {
          const aType = a.flights[0]?.type || '';
          const bType = b.flights[0]?.type || '';
          if (aType !== bType) return aType.localeCompare(bType);
        }
        return a.key.localeCompare(b.key);
      });
  },[flights,groupBy]);

  const { wd, mo, day } = fmtDay(app.date);

  const GrpChip = ({ g }) => (
    <button onClick={()=>app.setTweak('groupBy',g)} className="mono uc" style={{
      padding:'2px 8px', fontSize:8, borderRadius:3, cursor:'pointer',
      border:`1px solid ${app.tweaks.groupBy===g?'var(--ink-2)':'var(--line)'}`,
      background:app.tweaks.groupBy===g?`color-mix(in oklch,var(--ink-2) 14%,var(--surface))`:'transparent',
      color:app.tweaks.groupBy===g?'var(--ink-2)':'var(--ink-3)',
      fontWeight:app.tweaks.groupBy===g?600:400, transition:'all .1s',
    }}>{g}</button>
  );

  return (
    <ArtboardShell style={{ display:'flex', flexDirection:'column' }}>
      <ThemeStyle/>
      {/* Header */}
      <div style={{ padding:'0 16px', borderBottom:'1px solid var(--line)', background:'var(--bg-2)', display:'flex', alignItems:'center', gap:8, flexShrink:0, minHeight:38, flexWrap:'wrap' }}>
        <div style={{ display:'flex',alignItems:'center',gap:8 }}>
          <span style={{ width:8,height:8,borderRadius:999,background:'var(--col-pending)',boxShadow:'0 0 8px var(--col-pending)' }}/>
          <ViewIcon id="gantt" size={12} color="var(--ink-2)"/>
          <div className="mono uc" style={{ fontSize:11,fontWeight:600 }}>GANTT</div>
        </div>
        <div style={{ display:'flex',gap:4,alignItems:'center' }}>
          <span className="mono uc" style={{ fontSize:8,color:'var(--ink-3)' }}>FOCUS</span>
          <GrpChip g="instructor"/>
          <GrpChip g="tail"/>
          <GrpChip g="batch"/>
        </div>
        <div style={{flex:1}}/>
        <FocusControls/>
        {!isMobile && <div className="mono num" style={{ fontSize:11,color:'var(--ink-3)' }}>{String(day).padStart(2,'0')} {mo} · {wd}</div>}
        <RefreshButton/>
        <LastUpdate/>
      </div>

      {/* Date + filter */}
      <div style={{ padding:'4px 8px', display:'flex', flexDirection:'column', gap:4, flexShrink:0 }}>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <DateCalendarTrigger/>
          <span className="mono uc" style={{ fontSize:9, color:'var(--ink-3)' }}>SELECT DATE</span>
        </div>
        <FilterBar/>
      </div>

      {/* Timeline */}
      <div style={{ margin:'2px 6px 6px', flex:1, minHeight:0, border:'1px solid var(--line)', borderRadius:6, background:'var(--surface)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Single scroll viewport — scrolls both axes. On mobile the inner content
            gets a min-width so the timeline isn't cramped; the hour ruler stays
            pinned to the top and the label column stays pinned to the left while
            you swipe/scroll. (One scroll container is required for position:sticky
            to track the same scroll on both axes.) */}
        <div style={{ flex:1, minHeight:0, overflow:'auto' }}>
          {/* minWidth ensures horizontal scroll activates for extended-hour days */}
          <div style={{ minWidth: TRACK_LEFT + TRACK_RIGHT + hourSpan * PX_PER_HOUR }}>
            {/* Hour ruler — sticky to the top of the viewport */}
            <div style={{ display:'grid', gridTemplateColumns:`${TRACK_LEFT}px 1fr ${TRACK_RIGHT}px`, borderBottom:'1px solid var(--line)', background:'var(--bg-2)', position:'sticky', top:0, zIndex:4 }}>
              <div className="mono uc" style={{ padding:'9px 14px', fontSize:9, color:'var(--ink-3)',
                position:'sticky', left:0, zIndex:5, background:'var(--bg-2)' }}>
                {groupBy.toUpperCase()} · {rows.length}
              </div>
              <div style={{ position:'relative', height:34, overflow:'hidden' }}>
                {Array.from({length:hourSpan+1}).map((_,i)=>{
                  const h=HOUR_START+i;
                  const showLabel = !isMobile || h % 3 === 0;
                  return (
                    <div key={i} className="mono num" style={{
                      position:'absolute', left:`${(i/hourSpan)*100}%`, top:0, bottom:0,
                      borderLeft:i===0?'none':'1px solid var(--line-soft)',
                      paddingLeft:5, fontSize:isMobile?9:10, color:'var(--ink-3)', display:'flex', alignItems:'center',
                      whiteSpace:'nowrap',
                    }}>{showLabel ? `${h}` : ''}</div>
                  );
                })}
              </div>
              <div className="mono uc" style={{ padding:'9px 14px', fontSize:9, color:'var(--ink-3)', borderLeft:'1px solid var(--line)' }}>
                {groupBy==='instructor' ? `DUTY ${HOUR_START}–${hourEnd}` : groupBy==='tail' ? 'TAIL HRS' : 'BATCH HRS'}
              </div>
            </div>

            {/* Rows */}
            <div>
              {rows.map((r,ri)=>{
            const totalMin = r.flights.reduce((a,b)=>a+(b.durMin||0),0);
            const hasHL    = r.flights.some(f=>f.batch===HIGHLIGHT_BATCH);
            const rowAlpha = app.highlightAP127&&!hasHL ? 0.28 : 1;
            const dateLeaveMap = leavesOnDate(app.date);
            const rowOnLeave   = groupBy === 'instructor' && dateLeaveMap[r.key];
            const rowOnMaint   = groupBy === 'tail'       && isTailMaint(r.key);

            const rightMetric = (() => {
              if (groupBy === 'instructor') {
                const starts = r.flights.map(f=>minutesOf(f.start)).filter(v=>v!=null);
                const ends   = r.flights.map(f=>minutesOf(f.end)).filter(v=>v!=null);
                if (!starts.length) return { label:'DUTY', value:'—', sub:'' };
                const dutyMin = Math.max(...ends) - Math.min(...starts);
                const h = Math.floor(dutyMin/60), m = dutyMin%60;
                const firstStart = r.flights.reduce((a,b)=>(minutesOf(a.start)||9999)<(minutesOf(b.start)||9999)?a:b).start;
                const lastEnd    = r.flights.reduce((a,b)=>(minutesOf(a.end)||0)>(minutesOf(b.end)||0)?a:b).end;
                return { label:'DUTY', value:`${h}h${String(m).padStart(2,'0')}`, sub:`${firstStart}–${lastEnd}` };
              }
              const h = Math.floor(totalMin/60), m = totalMin%60;
              return { label: groupBy==='tail'?'TAIL HRS':'FLT HRS', value:`${h}h${String(m).padStart(2,'0')}`, sub:`${r.flights.length} FLT` };
            })();

            return (
              <div key={r.key} style={{
                display:'grid', gridTemplateColumns:`${TRACK_LEFT}px 1fr ${TRACK_RIGHT}px`,
                borderBottom:'1px solid var(--line-soft)', minHeight:54,
                background:ri%2?'transparent':'color-mix(in oklch,var(--ink) 1.2%,transparent)',
                opacity:rowAlpha, transition:'opacity .15s',
              }}>
                <div style={{ padding: isMobile?'4px 6px':'8px 10px', display:'flex', alignItems:'center', borderRight:'1px solid var(--line)', overflow:'hidden',
                  ...(isMobile ? { position:'sticky', left:0, zIndex:2, background:'var(--bg-2)' } : {}) }}>
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontSize:isMobile?10:12, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                      color: rowOnMaint ? 'var(--col-cancel)' : 'var(--ink)' }}>{r.key}</div>
                    <div style={{ display:'flex', gap:4, marginTop:2, flexWrap:'wrap' }}>
                      {rowOnMaint && <GndBadge/>}
                      {rowOnLeave && <LeaveBadge reason={rowOnLeave}/>}
                    </div>
                  </div>
                </div>
                <div style={{ position:'relative' }}>
                  {Array.from({length:hourSpan+1}).map((_,i)=>(
                    <div key={i} style={{ position:'absolute',left:`${(i/hourSpan)*100}%`,top:0,bottom:0,borderLeft:'1px solid var(--line-soft)',opacity:i%2?0.5:1 }}/>
                  ))}
                  {r.flights.map((f,fi)=>{
                    if (!f.start) return null;
                    const startMin  = (minutesOf(f.start)||0) - HOUR_START*60;
                    const totalSpan = hourSpan*60;
                    const left      = Math.max(0,(startMin/totalSpan)*100);
                    const width     = ((f.durMin||60)/totalSpan)*100;
                    const isFiSP    = !!f._asFiStudent;
                    const isMtg     = isMeetingFlt(f);
                    const color     = isFiSP ? 'var(--col-stby)' : isMtg ? 'var(--ink-3)' : STATUS_COLOR(f);
                    const done      = f.status==='Completed';
                    const dim       = f.status==='Canceled';
                    const stby      = f.isStandby;
                    return (
                      <button key={f.id+fi+(isFiSP?'s':'')} onClick={()=>app.setDrawer(f.id)}
                        title={isFiSP
                          ? `${f.start}–${f.end} · ${f.student} flying as SP · instr: ${f.instructor} · ${f.lesson}`
                          : `${f.start}–${f.end} · ${f.student||f.instructor||''} · ${f.lesson}`}
                        style={{
                          position:'absolute', left:`${left}%`, width:`calc(${width}% - 2px)`,
                          top: isFiSP ? 2 : 5, bottom: isFiSP ? 2 : 5,
                          background:`color-mix(in oklch,${color} ${stby?8:isFiSP?10:18}%,var(--surface))`,
                          border:`${stby||isFiSP?'1px dashed':'1px solid'} ${color}`,
                          borderLeft:`3px ${stby||isFiSP?'dashed':'solid'} ${color}`,
                          borderRadius:4, padding:'2px 5px', textAlign:'left',
                          cursor:'pointer', overflow:'hidden', color:'var(--ink)',
                          opacity: dim?0.4:isFiSP?0.75:1,
                          textDecoration: dim?'line-through':'none',
                        }}>
                        <div className="mono num" style={{ fontSize:9,display:'flex',justifyContent:'space-between',gap:4 }}>
                          <span>{f.start}</span>
                          {isFiSP && <span style={{color:'var(--col-stby)',fontSize:7,fontWeight:600}}>AS SP</span>}
                          {!isFiSP && done && <span style={{color:'var(--col-done)'}}>✓</span>}
                          {!isFiSP && stby && <span style={{color:'var(--col-stby)',fontSize:8}}>STBY</span>}
                          {isMtg && !isFiSP && <span style={{color:'var(--ink-3)',fontSize:7}}>MTG</span>}
                        </div>
                        <div style={{ fontSize:isMobile?9:11,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',lineHeight:1.2 }}>
                          {isFiSP
                            ? `▾ ${f.lesson}`
                            : isMtg
                              ? (f.lesson || f.batch || '—')
                              : f.student}
                        </div>
                        {!isMobile && (
                          <div className="mono uc" style={{ fontSize:8,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'flex',gap:4,alignItems:'center' }}>
                            {isFiSP
                              ? <span style={{color:'var(--ink-3)'}}>instr: {f.instructor||'—'}</span>
                              : <>
                                  <span style={{color:f.batch===HIGHLIGHT_BATCH?'var(--highlight)':'var(--ink-3)',fontWeight:f.batch===HIGHLIGHT_BATCH?600:400}}>{f.batch}</span>
                                  <span style={{color:'var(--ink-3)'}}>·</span>
                                  <span style={{color:isTailMaint(f.tail)?'var(--col-cancel)':'var(--ink-3)',fontWeight:isTailMaint(f.tail)?600:400}}>{f.tail||'TBD'}</span>
                                  {isTailMaint(f.tail) && <GndBadge/>}
                                </>
                            }
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div style={{ padding: isMobile?'6px 8px':'10px 14px',borderLeft:'1px solid var(--line)',display:'flex',flexDirection:'column',justifyContent:'center',gap:1 }}>
                  <div className="mono uc" style={{ fontSize:isMobile?7:8,color:'var(--ink-3)' }}>{rightMetric.label}</div>
                  <div className="mono num" style={{ fontSize:isMobile?11:14,fontWeight:600,color:'var(--ink)' }}>{rightMetric.value}</div>
                  {!isMobile && <div className="mono" style={{ fontSize:9,color:'var(--ink-3)' }}>{rightMetric.sub}</div>}
                </div>
              </div>
            );
          })}
          {rows.length===0&&(
            <div className="mono uc" style={{ padding:40,textAlign:'center',color:'var(--ink-3)',fontSize:10 }}>No flights match current filters.</div>
          )}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="mono uc" style={{ display:'flex',gap:10,padding:'7px 16px',fontSize:9,color:'var(--ink-3)',borderTop:'1px solid var(--line)',background:'var(--bg-2)',flexShrink:0,flexWrap:'wrap' }}>
          {[['PENDING','var(--col-pending)'],['COMPLETED','var(--col-done)'],['CANCELED','var(--col-cancel)'],['SIM','var(--col-sim)'],['STANDBY','var(--col-stby)']].map(([l,c])=>(
            <span key={l} style={{ display:'flex',gap:5,alignItems:'center' }}>
              <span style={{ width:12,height:7,background:`color-mix(in oklch,${c} 20%,var(--surface))`,border:`1px ${l==='STANDBY'?'dashed':'solid'} ${c}`,borderRadius:2 }}/>
              {l}
            </span>
          ))}
          <span style={{ display:'flex',gap:5,alignItems:'center' }}>
            <span style={{ width:12,height:7,background:`color-mix(in oklch,var(--col-stby) 10%,var(--surface))`,border:'1px dashed var(--col-stby)',borderRadius:2 }}/>
            FI AS SP
          </span>
          <span style={{ display:'flex',gap:5,alignItems:'center' }}>
            <span style={{ width:12,height:7,background:'color-mix(in oklch,var(--ink-3) 15%,var(--surface))',border:'1px solid var(--ink-3)',borderRadius:2 }}/>
            MTG/OTHER
          </span>
          <span style={{flex:1}}/>
          <span>CLICK A BAR FOR DETAILS</span>
        </div>
      </div>
      <Drawer/>
    </ArtboardShell>
  );
}

window.GanttBoard = GanttBoard;
